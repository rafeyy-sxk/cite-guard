/**
 * The run: retrieve, draft, verify mechanically, verify independently, tally.
 *
 * Both model phases go through ONE scheduler with ONE shared token budget,
 * because the provider's per-minute ceiling does not care which phase we are in.
 *
 *   phase 1  drafting     - one call per question, scheduled
 *   (free)   mechanical   - every claimed quote searched in the source text
 *   phase 2  entailment   - one small call per surviving claim, up to 100 wide
 *
 * The free pass in the middle is what makes phase 2 affordable: a fabricated
 * quote is thrown out for nothing, so the token budget is only ever spent on
 * claims that already have real supporting text behind them.
 */

import { BM25Index } from './bm25';
import { chunkCorpus } from './chunk';
import { systemClock, type Clock } from './clock';
import { RollingTokenBudget } from './budget';
import { chat as groqChat, resolveModels as groqResolveModels } from './groq';
import { MAX_CLAIMS, RETRIEVAL_COVERAGE_FLOOR, RETRIEVE_TOP_K } from './limits';
import {
  DRAFT_MAX_OUTPUT_TOKENS,
  VERIFY_MAX_OUTPUT_TOKENS,
  buildDraftMessages,
  buildEntailmentMessages,
  outputBudgetForAttempt,
  parseDraftResponse,
  parseEntailmentResponse,
} from './prompt';
import { SCHEDULER_DEFAULTS, runScheduled, type SchedulerEvent, type SchedulerTask } from './scheduler';
import { estimateRequestTokens } from './tokens';
import type {
  CheckedSentence,
  ClaimedSentence,
  QuestionResult,
  RunLedgerSummary,
  RunResult,
  SourceDoc,
  UnverifiedReason,
  VerifiedSentence,
} from './types';
import { VerificationCorpus } from './verify';

export interface AskRequest {
  docs: SourceDoc[];
  questions: string[];
  concurrency?: number;
  tokensPerWindow?: number;
  windowMs?: number;
  /** Passages sent to the model per question. Fewer means a cheaper prompt. */
  topK?: number;
  /** Second pass on by default; off makes a run free of phase-2 tokens. */
  entailment?: boolean;
}

export interface PipelineDeps {
  chat?: typeof groqChat;
  resolveModels?: typeof groqResolveModels;
  clock?: Clock;
  random?: () => number;
  signal?: AbortSignal;
}

export type RunEvent =
  | { type: 'models'; draft: string; verify: string }
  | { type: 'phase'; phase: 'retrieving' | 'drafting' | 'checking' | 'entailing' | 'done'; detail: string }
  | { type: 'scheduler'; phase: 'draft' | 'verify'; event: SchedulerEvent }
  | { type: 'claims'; claims: Array<{ id: string; question: string; text: string }> }
  | { type: 'result'; result: RunResult }
  | { type: 'error'; message: string };

export type EmitFn = (event: RunEvent) => void;

interface DraftTaskValue {
  questionId: string;
  claims: ClaimedSentence[];
  sufficient: boolean;
}

interface PendingClaim {
  id: string;
  questionId: string;
  checked: VerifiedSentence;
}

const REASON_KEYS: UnverifiedReason[] = [
  'no_citation', 'missing_source', 'quote_too_short',
  'quote_not_found', 'not_entailed', 'check_failed',
];

/** Run a whole question set end to end. */
export async function runAsk(
  request: AskRequest,
  emit: EmitFn,
  deps: PipelineDeps = {},
): Promise<RunResult> {
  const chat = deps.chat ?? groqChat;
  const resolveModels = deps.resolveModels ?? groqResolveModels;
  const clock = deps.clock ?? systemClock;
  const entailmentEnabled = request.entailment !== false;

  const concurrency = Math.max(1, Math.min(200, request.concurrency ?? 100));
  const tokensPerWindow = Math.max(500, request.tokensPerWindow ?? 8000);
  const windowMs = request.windowMs ?? SCHEDULER_DEFAULTS.windowMs;

  const startedAt = clock.now();
  const budget = new RollingTokenBudget(tokensPerWindow, windowMs, clock);

  emit({ type: 'phase', phase: 'retrieving', detail: 'Indexing sources' });
  const chunks = chunkCorpus(request.docs);
  const index = new BM25Index(chunks);
  const corpus = new VerificationCorpus(request.docs, chunks);

  const models = await resolveModels();
  emit({ type: 'models', draft: models.draft, verify: models.verify });

  // ---- retrieval -----------------------------------------------------------
  const questions: QuestionResult[] = request.questions.map((question, i) => {
    const retrieved = index.search(question, request.topK ?? RETRIEVE_TOP_K);
    const best = retrieved[0]?.coverage ?? 0;
    const relevant = retrieved.length > 0 && best >= RETRIEVAL_COVERAGE_FLOOR;
    return {
      id: `q${i}`,
      question,
      outcome: relevant ? 'answered' : 'no_relevant_source',
      sentences: [],
      coverage: { verified: 0, total: 0, ratio: 0 },
      retrieved,
      notice: relevant
        ? null
        : 'Nothing in these sources matches this question closely enough to answer from. Rather than write something that sounds plausible, cite-guard stops here.',
    };
  });

  const answerable = questions.filter((q) => q.outcome === 'answered');

  // ---- phase 1: drafting ---------------------------------------------------
  emit({ type: 'phase', phase: 'drafting', detail: `Drafting ${answerable.length} answer(s)` });

  const draftTasks: Array<SchedulerTask<DraftTaskValue>> = answerable.map((q) => {
    const messages = buildDraftMessages(q.question, q.retrieved);
    return {
      id: `draft:${q.id}`,
      // Reserve exactly what THIS attempt is allowed to spend, so a retry's
      // larger allowance is accounted for without the first attempt paying for it.
      estimateTokens: (attempt: number) =>
        estimateRequestTokens(messages, outputBudgetForAttempt(DRAFT_MAX_OUTPUT_TOKENS, attempt)),
      run: async ({ signal, attempt }) => {
        const res = await chat({
          model: models.draft,
          messages,
          maxOutputTokens: outputBudgetForAttempt(DRAFT_MAX_OUTPUT_TOKENS, attempt),
          json: true,
          reasoningEffort: 'medium',
          signal,
        });
        const parsed = parseDraftResponse(res.content);
        return {
          value: { questionId: q.id, claims: parsed.claims, sufficient: parsed.sufficient },
          tokensUsed: res.totalTokens,
        };
      },
    };
  });

  const draftRun = await runScheduled(draftTasks, {
    concurrency,
    budget,
    windowMs,
    clock,
    random: deps.random,
    signal: deps.signal,
    onEvent: (event) => emit({ type: 'scheduler', phase: 'draft', event }),
  });

  // ---- free pass: mechanical quote verification ----------------------------
  emit({ type: 'phase', phase: 'checking', detail: 'Searching sources for every quote' });

  const byQuestion = new Map<string, CheckedSentence[]>();
  const pending: PendingClaim[] = [];
  const mechanical = { checked: 0, passed: 0, rejected: 0, byReason: {} as Partial<Record<UnverifiedReason, number>> };

  for (const q of answerable) {
    const result = draftRun.results.get(`draft:${q.id}`);
    if (!result || result.state !== 'done') {
      q.outcome = 'draft_failed';
      q.notice =
        result?.state === 'failed'
          ? `The model call for this question did not complete: ${result.error}`
          : 'The model call for this question was cancelled.';
      continue;
    }
    if (!result.value.sufficient || result.value.claims.length === 0) {
      q.outcome = 'model_declined';
      q.notice =
        'The model was given the closest passages and reported that they do not answer this question.';
      continue;
    }

    const checkedList: CheckedSentence[] = [];
    for (const claim of result.value.claims.slice(0, MAX_CLAIMS)) {
      const checked = corpus.verify(claim);
      mechanical.checked += 1;
      if (checked.status === 'verified') {
        mechanical.passed += 1;
        const withEntailment: VerifiedSentence = { ...checked, entailment: null };
        checkedList.push(withEntailment);
        if (entailmentEnabled) {
          pending.push({
            id: `verify:${q.id}:${checkedList.length - 1}`,
            questionId: q.id,
            checked: withEntailment,
          });
        }
      } else {
        mechanical.rejected += 1;
        mechanical.byReason[checked.reason] = (mechanical.byReason[checked.reason] ?? 0) + 1;
        checkedList.push(checked);
      }
    }
    byQuestion.set(q.id, checkedList);
  }

  emit({
    type: 'claims',
    claims: pending.map((p) => ({
      id: p.id,
      question: questions.find((q) => q.id === p.questionId)?.question ?? '',
      text: p.checked.text,
    })),
  });

  // ---- phase 2: independent entailment, up to `concurrency` wide -----------
  let verifyRun: Awaited<ReturnType<typeof runScheduled>> | null = null;

  if (entailmentEnabled && pending.length > 0) {
    emit({ type: 'phase', phase: 'entailing', detail: `Checking ${pending.length} claim(s)` });

    const tasks: Array<SchedulerTask<{ supported: boolean; reason: string; model: string }>> =
      pending.map((p) => {
        const messages = buildEntailmentMessages(p.checked.text, p.checked.sourceText);
        return {
          id: p.id,
          estimateTokens: (attempt: number) =>
            estimateRequestTokens(messages, outputBudgetForAttempt(VERIFY_MAX_OUTPUT_TOKENS, attempt)),
          run: async ({ signal, attempt }) => {
            const res = await chat({
              model: models.verify,
              messages,
              maxOutputTokens: outputBudgetForAttempt(VERIFY_MAX_OUTPUT_TOKENS, attempt),
              json: true,
              // A yes/no judgement does not need deep deliberation, and on a
              // reasoning model the thinking comes out of the same budget.
              reasoningEffort: 'low',
              signal,
            });
            const verdict = parseEntailmentResponse(res.content);
            return {
              value: { supported: verdict.supported, reason: verdict.reason, model: res.model },
              tokensUsed: res.totalTokens,
            };
          },
        };
      });

    verifyRun = await runScheduled(tasks, {
      concurrency,
      budget,
      windowMs,
      clock,
      random: deps.random,
      signal: deps.signal,
      onEvent: (event) => emit({ type: 'scheduler', phase: 'verify', event }),
    });

    for (const p of pending) {
      const list = byQuestion.get(p.questionId);
      if (!list) continue;
      const slot = list.findIndex((s) => s === p.checked);
      if (slot === -1) continue;
      const outcome = verifyRun.results.get(p.id);

      if (outcome?.state === 'done') {
        const value = outcome.value as { supported: boolean; reason: string; model: string };
        if (value.supported) {
          list[slot] = {
            ...p.checked,
            entailment: {
              supported: true,
              reason: value.reason,
              model: value.model,
              attempts: outcome.attempts,
              tokensUsed: outcome.tokensUsed,
            },
          };
        } else {
          list[slot] = {
            text: p.checked.text,
            status: 'unverified',
            reason: 'not_entailed',
            detail: `The quote is genuinely in the source, but it does not support this sentence (${value.reason}).`,
            claimedChunkId: p.checked.claimedChunkId,
            quote: p.checked.quote,
            span: p.checked.span,
            sourceText: p.checked.sourceText,
          };
          mechanical.byReason.not_entailed = (mechanical.byReason.not_entailed ?? 0) + 1;
        }
      } else {
        // Fail closed. An unfinished check is not a pass.
        const why = outcome?.state === 'failed' ? outcome.error : 'the check was cancelled';
        list[slot] = {
          text: p.checked.text,
          status: 'unverified',
          reason: 'check_failed',
          detail: `The quote was found in the source, but the independent check could not be completed (${why}). It is withheld rather than shown as verified.`,
          claimedChunkId: p.checked.claimedChunkId,
          quote: p.checked.quote,
          span: p.checked.span,
          sourceText: p.checked.sourceText,
        };
        mechanical.byReason.check_failed = (mechanical.byReason.check_failed ?? 0) + 1;
      }
    }
  }

  // ---- tally ---------------------------------------------------------------
  for (const q of questions) {
    const list = byQuestion.get(q.id);
    if (!list) continue;
    q.sentences = list;
    const verified = list.filter((s) => s.status === 'verified').length;
    q.coverage = { verified, total: list.length, ratio: list.length > 0 ? verified / list.length : 0 };
    if (verified === 0 && list.length > 0) {
      q.notice = 'Not one sentence of this answer could be traced to the sources, so none of it is shown as an answer.';
    }
  }

  const allSentences = questions.flatMap((q) => q.sentences);
  const ledger: RunLedgerSummary = {
    questions: request.questions.length,
    claimsDispatched: (verifyRun?.ledger.tasks ?? 0),
    verified: allSentences.filter((s) => s.status === 'verified').length,
    unverified: allSentences.filter((s) => s.status === 'unverified').length,
    failed: draftRun.ledger.failed + (verifyRun?.ledger.failed ?? 0),
    retriesAbsorbed: draftRun.ledger.retries + (verifyRun?.ledger.retries ?? 0),
    rateLimitHits: draftRun.ledger.rateLimitHits + (verifyRun?.ledger.rateLimitHits ?? 0),
    budgetWaits: draftRun.ledger.budgetWaits + (verifyRun?.ledger.budgetWaits ?? 0),
    peakConcurrency: Math.max(draftRun.ledger.peakConcurrency, verifyRun?.ledger.peakConcurrency ?? 0),
    wallClockMs: clock.now() - startedAt,
    tokensEstimated: draftRun.ledger.tokensEstimated + (verifyRun?.ledger.tokensEstimated ?? 0),
    tokensActual: draftRun.ledger.tokensActual + (verifyRun?.ledger.tokensActual ?? 0),
    modelCalls: draftRun.ledger.dispatched + (verifyRun?.ledger.dispatched ?? 0),
    mechanical: {
      checked: mechanical.checked,
      passed: mechanical.passed,
      rejected: mechanical.rejected,
      byReason: Object.fromEntries(
        REASON_KEYS.map((k) => [k, mechanical.byReason[k] ?? 0]).filter(([, v]) => (v as number) > 0),
      ),
    },
  };

  const result: RunResult = { questions, ledger, models, chunks, entailmentEnabled };
  emit({ type: 'phase', phase: 'done', detail: 'Complete' });
  emit({ type: 'result', result });
  return result;
}
