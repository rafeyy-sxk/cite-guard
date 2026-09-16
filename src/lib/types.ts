/** Shared domain types for cite-guard. */

/** A user-supplied source document, held in memory only — never written to disk. */
export interface SourceDoc {
  id: string;
  /** Display title (filename, URL host + path, or "Pasted text 1"). */
  title: string;
  /** Where the text came from, for provenance in the UI. */
  origin: 'paste' | 'file' | 'url';
  /** Original, unmodified text. All chunk offsets index into this string. */
  text: string;
  /** Present only for `origin: 'url'`. */
  url?: string;
}

/** A retrievable slice of a source document. */
export interface Chunk {
  /** Short, model-facing id such as `c3`. Unique across the whole corpus. */
  id: string;
  docId: string;
  docTitle: string;
  /** Verbatim slice of `SourceDoc.text`. */
  text: string;
  /** Inclusive start offset into `SourceDoc.text`. */
  start: number;
  /** Exclusive end offset into `SourceDoc.text`. */
  end: number;
  /** 0-based position of this chunk within its document. */
  index: number;
}

export interface ScoredChunk {
  chunk: Chunk;
  /** Okapi BM25 score. Unbounded above; only comparable within one query. */
  score: number;
  /**
   * Fraction of the query's distinct content terms that appear in this chunk,
   * in [0, 1]. Unlike `score` this IS comparable across corpora, so it is what
   * the retrieval floor is expressed in.
   */
  coverage: number;
}

/**
 * Why a sentence is not published as an answer.
 *
 * The first four come from the mechanical quote check. The last two come from
 * the optional second pass, and both fail CLOSED: a claim whose check could not
 * be completed is shown struck through, never shown as verified.
 */
export type UnverifiedReason =
  | 'no_citation'
  | 'missing_source'
  | 'quote_too_short'
  | 'quote_not_found'
  | 'not_entailed'
  | 'check_failed';

/** A model-proposed sentence before verification. */
export interface ClaimedSentence {
  text: string;
  chunkId: string | null;
  quote: string | null;
}

/** Character range inside a `SourceDoc.text`. */
export interface SourceSpan {
  docId: string;
  chunkId: string;
  start: number;
  end: number;
}

/** Outcome of the independent, per-claim entailment check. */
export interface EntailmentInfo {
  supported: boolean;
  reason: string;
  model: string;
  attempts: number;
  tokensUsed: number;
}

export interface VerifiedSentence {
  text: string;
  status: 'verified';
  /** The chunk the quote was actually found in. */
  chunkId: string;
  /** True when the model cited chunk A but the quote was found in chunk B. */
  relocated: boolean;
  /** The chunk the model originally cited, when different from `chunkId`. */
  claimedChunkId: string | null;
  /** Exact location of the supporting text in the original document. */
  span: SourceSpan;
  /** The quote as the model wrote it. */
  quote: string;
  /** The supporting text exactly as it appears in the source. */
  sourceText: string;
  /** Null when the entailment pass was switched off for the run. */
  entailment: EntailmentInfo | null;
}

export interface UnverifiedSentence {
  text: string;
  status: 'unverified';
  reason: UnverifiedReason;
  /** Human-readable explanation shown in the UI. */
  detail: string;
  claimedChunkId: string | null;
  quote: string | null;
  /**
   * Present when the quote WAS located but the claim failed the second pass.
   * The UI shows the passage next to the struck-through sentence so the reader
   * can judge the disagreement rather than take our word for it.
   */
  span?: SourceSpan;
  sourceText?: string;
}

export type CheckedSentence = VerifiedSentence | UnverifiedSentence;

export interface Coverage {
  verified: number;
  total: number;
  /** verified / total, or 0 when total is 0. */
  ratio: number;
}

export type AnswerOutcome =
  | 'answered'
  | 'no_relevant_source'
  | 'model_declined'
  | 'draft_failed';

export interface QuestionResult {
  id: string;
  question: string;
  outcome: AnswerOutcome;
  /** Empty unless `outcome === 'answered'`. */
  sentences: CheckedSentence[];
  coverage: Coverage;
  /** Chunks sent to the model, in rank order. */
  retrieved: ScoredChunk[];
  /** Plain-language note shown above the answer (e.g. the honest empty state). */
  notice: string | null;
}

/** Tally of the free, mechanical pass. */
export interface MechanicalLedger {
  checked: number;
  passed: number;
  rejected: number;
  byReason: Partial<Record<UnverifiedReason, number>>;
}

/**
 * What the run actually did. Every field is computed from the run, not
 * estimated: `peakConcurrency` is the highest in-flight count observed,
 * `tokensActual` is the sum of `usage.total_tokens` the API reported back.
 */
export interface RunLedgerSummary {
  questions: number;
  claimsDispatched: number;
  verified: number;
  unverified: number;
  failed: number;
  retriesAbsorbed: number;
  rateLimitHits: number;
  budgetWaits: number;
  peakConcurrency: number;
  wallClockMs: number;
  tokensEstimated: number;
  tokensActual: number;
  modelCalls: number;
  mechanical: MechanicalLedger;
}

export interface RunResult {
  questions: QuestionResult[];
  ledger: RunLedgerSummary;
  models: { draft: string; verify: string };
  /** Chunks built for this run, so the UI can map a citation to a source span. */
  chunks: Chunk[];
  entailmentEnabled: boolean;
}
