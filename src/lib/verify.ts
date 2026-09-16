/**
 * Mechanical quote verification.
 *
 * This is the part of cite-guard that is not a language model. The model is
 * asked to return, for each sentence it writes, the exact passage that supports
 * it. This module then goes and *looks for that passage in the source text*. If
 * it is not there, the sentence does not ship as an answer — no appeal, no
 * confidence score, no second model opinion that might be talked around.
 *
 * Why string search rather than asking a model "is this supported?": a model
 * grading its own output is correlated with the error it is meant to catch, and
 * a fabricated quote is exactly the case where it is most confident. Substring
 * search has no such failure mode. A quote that was never in the document
 * cannot be found in the document.
 *
 * What it must NOT do is be brittle. A model that reproduces a passage with
 * straight quotes instead of curly ones, different capitalisation, or a line
 * break collapsed to a space has not fabricated anything, and failing it would
 * train users to ignore the warnings. All comparison therefore happens in the
 * folded space from `normalize.ts`, which is insensitive to case, punctuation,
 * accents and whitespace while still mapping back to exact original offsets.
 *
 * The residual risk this design accepts, stated plainly: a real quote lifted out
 * of context still passes the mechanical check. That is what the optional
 * entailment pass in `pipeline.ts` is for, and it is a second gate on top of
 * this one, never a replacement for it.
 */

import type {
  Chunk,
  ClaimedSentence,
  CheckedSentence,
  SourceDoc,
  UnverifiedReason,
} from './types';
import { foldedWordCount, normalize, projectRange, type NormalizedText } from './normalize';

/**
 * Shortest quote we will accept, in folded words.
 *
 * Three words ("the company grew") match so much text that finding them proves
 * nothing about whether the source supports the claim; at four the match starts
 * to carry information. This is the one tunable with a real false-negative cost,
 * so it is deliberately low rather than "safe".
 */
export const MIN_QUOTE_WORDS = 4;

/** Shortest quote we will accept, in folded characters. Guards "a b c d". */
export const MIN_QUOTE_CHARS = 16;

export interface VerifyOptions {
  minQuoteWords?: number;
  minQuoteChars?: number;
  /**
   * When true (the default), a quote that is genuinely present in the corpus but
   * under a chunk the model did not cite is accepted and flagged `relocated`.
   * Citing the wrong neighbour is a bookkeeping slip, not a fabrication.
   */
  allowRelocation?: boolean;
}

interface IndexedDoc {
  doc: SourceDoc;
  normalized: NormalizedText;
  chunks: Chunk[];
}

/**
 * The reasons THIS module can produce. `not_entailed` and `check_failed` come
 * from the second pass in `pipeline.ts`; naming the subset here means adding a
 * reason there cannot silently create an unhandled branch in the verifier.
 */
export type MechanicalReason = Extract<
  UnverifiedReason,
  'no_citation' | 'missing_source' | 'quote_too_short' | 'quote_not_found'
>;

const REASON_DETAIL: Record<MechanicalReason, string> = {
  no_citation: 'The model wrote this sentence without offering a supporting quote.',
  missing_source: 'The model cited a passage id that is not in the provided sources.',
  quote_too_short: 'The supporting quote was too short to prove anything.',
  quote_not_found: 'The supporting quote does not appear anywhere in the provided sources.',
};

/**
 * Pre-folded corpus. Folding is O(n) per document and every claim searches the
 * same text, so it is done once per run rather than once per claim — the
 * difference at 100 concurrent claims is the difference between instant and
 * noticeable.
 */
export class VerificationCorpus {
  private readonly docs = new Map<string, IndexedDoc>();
  private readonly chunkById = new Map<string, Chunk>();

  constructor(docs: SourceDoc[], chunks: Chunk[]) {
    for (const doc of docs) {
      this.docs.set(doc.id, { doc, normalized: normalize(doc.text), chunks: [] });
    }
    for (const chunk of chunks) {
      this.chunkById.set(chunk.id, chunk);
      this.docs.get(chunk.docId)?.chunks.push(chunk);
    }
  }

  getChunk(id: string): Chunk | undefined {
    return this.chunkById.get(id);
  }

  getDoc(id: string): SourceDoc | undefined {
    return this.docs.get(id)?.doc;
  }

  private indexed(docId: string): IndexedDoc | undefined {
    return this.docs.get(docId);
  }

  /**
   * Find `foldedQuote` inside one document, restricted to `[from, to)` of the
   * ORIGINAL text when given. Returns original-text offsets.
   */
  private findInDoc(
    docId: string,
    foldedQuote: string,
    window?: { start: number; end: number },
  ): { start: number; end: number } | null {
    const indexed = this.indexed(docId);
    if (!indexed) return null;
    const { normalized } = indexed;

    // Translate an original-text window into folded space so the search can be
    // confined to one chunk without re-folding a substring (which would break
    // the offset map).
    let searchFrom = 0;
    let searchTo = normalized.text.length;
    if (window) {
      searchFrom = normalized.map.findIndex((orig) => orig >= window.start);
      if (searchFrom === -1) return null;
      let lastInside = -1;
      for (let i = normalized.map.length - 1; i >= 0; i -= 1) {
        if (normalized.map[i]! < window.end) {
          lastInside = i;
          break;
        }
      }
      if (lastInside === -1) return null;
      searchTo = lastInside + 1;
    }

    const haystack = normalized.text.slice(searchFrom, searchTo);
    const hit = haystack.indexOf(foldedQuote);
    if (hit === -1) return null;

    return projectRange(normalized, searchFrom + hit, searchFrom + hit + foldedQuote.length);
  }

  /** The chunk that best contains an original-text span. */
  private chunkFor(docId: string, start: number, end: number): Chunk | undefined {
    const chunks = this.indexed(docId)?.chunks ?? [];
    return (
      chunks.find((c) => c.start <= start && c.end >= end) ??
      chunks.find((c) => c.start <= start && c.end > start)
    );
  }

  /** All document ids, cited document first. */
  private searchOrder(preferredDocId?: string): string[] {
    const ids = [...this.docs.keys()];
    if (!preferredDocId) return ids;
    return [preferredDocId, ...ids.filter((id) => id !== preferredDocId)];
  }

  /**
   * Check one model-proposed sentence.
   *
   * Every path returns a decision; there is no "probably fine". The sentence is
   * either backed by text we located in the source, or it is struck through with
   * a reason the user can check for themselves.
   */
  verify(claim: ClaimedSentence, options: VerifyOptions = {}): CheckedSentence {
    const minWords = options.minQuoteWords ?? MIN_QUOTE_WORDS;
    const minChars = options.minQuoteChars ?? MIN_QUOTE_CHARS;
    const allowRelocation = options.allowRelocation ?? true;

    const reject = (reason: MechanicalReason, detail?: string): CheckedSentence => ({
      text: claim.text,
      status: 'unverified',
      reason,
      detail: detail ?? REASON_DETAIL[reason],
      claimedChunkId: claim.chunkId,
      quote: claim.quote,
    });

    if (claim.quote === null || claim.quote.trim().length === 0 || claim.chunkId === null) {
      return reject('no_citation');
    }

    const citedChunk = this.getChunk(claim.chunkId);
    if (!citedChunk) {
      return reject(
        'missing_source',
        `The model cited "${claim.chunkId}", which is not one of the passages it was given.`,
      );
    }

    const folded = normalize(claim.quote).text;
    if (folded.length < minChars || foldedWordCount(folded) < minWords) {
      return reject(
        'quote_too_short',
        `The supporting quote was only ${foldedWordCount(folded)} word(s); at least ${minWords} are required for a match to mean anything.`,
      );
    }

    // 1. The chunk the model actually cited.
    let found = this.findInDoc(citedChunk.docId, folded, {
      start: citedChunk.start,
      end: citedChunk.end,
    });
    let foundDocId = citedChunk.docId;
    let relocated = false;

    // 2. Anywhere in the corpus, cited document first.
    if (!found && allowRelocation) {
      for (const docId of this.searchOrder(citedChunk.docId)) {
        const hit = this.findInDoc(docId, folded);
        if (hit) {
          found = hit;
          foundDocId = docId;
          relocated = true;
          break;
        }
      }
    }

    if (!found) return reject('quote_not_found');

    const owningChunk = this.chunkFor(foundDocId, found.start, found.end);
    const doc = this.getDoc(foundDocId);
    if (!owningChunk || !doc) return reject('quote_not_found');

    return {
      text: claim.text,
      status: 'verified',
      chunkId: owningChunk.id,
      relocated,
      claimedChunkId: claim.chunkId,
      span: { docId: foundDocId, chunkId: owningChunk.id, start: found.start, end: found.end },
      quote: claim.quote,
      // The source's own words, not the model's retyping of them. This is what
      // the UI shows when a citation is expanded.
      sourceText: doc.text.slice(found.start, found.end),
      // The mechanical pass never decides entailment; the pipeline fills this in.
      entailment: null,
    };
  }
}
