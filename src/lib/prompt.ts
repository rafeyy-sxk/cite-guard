/**
 * Prompt construction and response parsing.
 *
 * The prompts are written to make the *mechanical* check pass honestly rather
 * than to make the model sound confident. The model is told to copy a quote
 * character-for-character, because a paraphrased quote will simply not be found
 * in the source and the sentence will be struck through. That is the intended
 * behaviour, not a bug to prompt around.
 */

import type { ChatMessage } from './tokens';
import type { ClaimedSentence, ScoredChunk } from './types';
import { splitSentences } from './sentences';

/**
 * Output caps.
 *
 * On Groq these budgets cover hidden reasoning tokens as well as the visible
 * answer, so they are set with headroom rather than to the size of the JSON.
 * A cap that is too tight does not truncate the answer - it fails the whole
 * request with `json_validate_failed`, which cost a live run before these
 * numbers were measured.
 */
export const DRAFT_MAX_OUTPUT_TOKENS = 900;

/**
 * Output cap for one entailment check.
 *
 * Measured live on openai/gpt-oss-20b at `reasoning_effort: 'low'`: 53
 * completion tokens, of which 33 were reasoning. 160 leaves 3x headroom. The
 * cap is kept tight on purpose - it is reserved against the per-minute ceiling
 * before dispatch, so every unused token here is throughput thrown away.
 */
export const VERIFY_MAX_OUTPUT_TOKENS = 160;

/**
 * Multiplier applied to the output cap on each retry.
 *
 * Because `json_validate_failed` means "ran out of room to think", retrying with
 * the same budget would fail the same way. The budget gate reserves the largest
 * allowance a task can reach, so escalating cannot overshoot the token ceiling.
 */
export const OUTPUT_ESCALATION = 2;

/** Output allowance for attempt `attempt` (1-based), capped at one escalation. */
export function outputBudgetForAttempt(base: number, attempt: number): number {
  return attempt <= 1 ? base : base * OUTPUT_ESCALATION;
}

const DRAFT_SYSTEM = [
  'You answer questions strictly from the numbered passages you are given.',
  'Every sentence of your answer must be supported by a quote you copy from one passage.',
  '',
  'Return JSON only, in this exact shape:',
  '{"sufficient": true, "sentences": [{"text": "...", "passage": "c0", "quote": "..."}]}',
  '',
  'Rules:',
  '1. "quote" must be copied character-for-character from the passage you name in "passage".',
  '   Do not paraphrase, shorten with ellipses, correct, or translate it. It is checked by',
  '   exact search against the source text, so an invented or reworded quote will be rejected.',
  '2. A quote must be at least 6 consecutive words from the passage.',
  '3. "passage" must be one of the given passage ids. Never invent an id.',
  '4. Write 1 to 5 sentences. Each entry in "sentences" is exactly one sentence.',
  '5. If the passages do not contain the answer, return {"sufficient": false, "sentences": []}.',
  '   Do not answer from general knowledge. An honest "not in these documents" is correct.',
].join('\n');

/** Build the drafting request for one question over its retrieved passages. */
export function buildDraftMessages(question: string, retrieved: ScoredChunk[]): ChatMessage[] {
  const passages = retrieved
    .map((r) => `[${r.chunk.id}] (from "${r.chunk.docTitle}")\n${r.chunk.text}`)
    .join('\n\n');

  return [
    { role: 'system', content: DRAFT_SYSTEM },
    { role: 'user', content: `PASSAGES:\n\n${passages}\n\nQUESTION: ${question}` },
  ];
}

const VERIFY_SYSTEM = [
  'You judge whether a source passage supports a statement.',
  'Return JSON only: {"supported": true, "reason": "<8 words>"}',
  'Supported means the passage states or directly entails the statement.',
  'If the statement adds a fact, number, name, or causal link the passage does not contain,',
  'answer false. Judge only against the passage, never against your own knowledge.',
].join('\n');

/**
 * Build one entailment check.
 *
 * This deliberately sees only the quoted span and the sentence - not the
 * question, not the rest of the answer, not the other passages. A judge given
 * the surrounding argument tends to ratify it; a judge given one passage and one
 * claim has nothing to be agreeable about.
 */
export function buildEntailmentMessages(sentence: string, sourceText: string): ChatMessage[] {
  return [
    { role: 'system', content: VERIFY_SYSTEM },
    { role: 'user', content: `PASSAGE:\n"""${sourceText}"""\n\nSTATEMENT:\n"""${sentence}"""` },
  ];
}

/**
 * Pull the first balanced JSON object out of a model response.
 *
 * Models wrap JSON in fences, prefix it with prose, or append a closing remark
 * even when told not to. Brace-matching (string- and escape-aware) is more
 * reliable here than a regex, and returns null rather than throwing so the
 * caller can treat an unparseable response as a failed claim.
 */
export function extractJsonObject(raw: string): unknown {
  const text = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export interface DraftResult {
  /** False when the model says the passages do not answer the question. */
  sufficient: boolean;
  claims: ClaimedSentence[];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Parse a drafting response into claims.
 *
 * Tolerant about field naming because that varies between models and costs
 * nothing to absorb, and strict about everything that matters: a missing quote
 * or passage id becomes a claim with nulls, which the verifier then strikes
 * through as `no_citation`. Being lenient here would let an uncited sentence
 * reach the user unmarked, which is the one outcome this app exists to prevent.
 */
export function parseDraftResponse(raw: string): DraftResult {
  const parsed = extractJsonObject(raw);
  if (parsed === null || typeof parsed !== 'object') return { sufficient: false, claims: [] };

  const obj = parsed as Record<string, unknown>;
  const sufficient = obj.sufficient !== false;
  const rows = Array.isArray(obj.sentences) ? obj.sentences : [];
  const claims: ClaimedSentence[] = [];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const text = asString(r.text) ?? asString(r.sentence) ?? asString(r.claim);
    if (!text) continue;
    const chunkId = asString(r.passage) ?? asString(r.chunk_id) ?? asString(r.chunkId) ?? asString(r.id);
    const quote = asString(r.quote) ?? asString(r.evidence) ?? asString(r.support);

    // A model sometimes returns a paragraph in one entry. Split it so each
    // sentence is judged on its own; they share the citation, and the
    // entailment pass is what separates the supported part from the rest.
    const parts = splitSentences(text);
    if (parts.length > 1) {
      for (const part of parts) claims.push({ text: part.text, chunkId, quote });
    } else {
      claims.push({ text, chunkId, quote });
    }
  }

  return { sufficient, claims };
}

export interface EntailmentVerdict {
  supported: boolean;
  reason: string;
}

/**
 * Parse an entailment response.
 *
 * Fails closed: anything unparseable is `supported: false`. An unreadable
 * verdict must never be read as approval.
 */
export function parseEntailmentResponse(raw: string): EntailmentVerdict {
  const parsed = extractJsonObject(raw);
  if (parsed === null || typeof parsed !== 'object') {
    return { supported: false, reason: 'unreadable verdict' };
  }
  const obj = parsed as Record<string, unknown>;
  const supported = obj.supported === true;
  const reason = asString(obj.reason) ?? (supported ? 'passage states it' : 'not stated in passage');
  return { supported, reason: reason.slice(0, 120) };
}
