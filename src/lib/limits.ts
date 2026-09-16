/**
 * Hard size caps.
 *
 * cite-guard runs on serverless functions, so every limit here exists to keep a
 * single request inside a platform ceiling rather than to be stingy. Vercel
 * rejects request bodies over 4.5 MB before our code ever runs, which would
 * surface as an opaque 413; we cap well below that and return our own message.
 */

/** Largest single uploaded/fetched document, in characters. */
export const MAX_DOC_CHARS = 400_000;

/** Largest combined corpus across all documents, in characters. */
export const MAX_TOTAL_CHARS = 1_200_000;

/** Largest accepted upload or fetched body, in bytes. Vercel's own cap is 4.5 MB. */
export const MAX_BODY_BYTES = 2_000_000;

/** Largest number of documents held at once. */
export const MAX_DOCS = 20;

/** Largest number of questions in one run. */
export const MAX_QUESTIONS = 25;

/** Safety valve on total scheduled claims in a single run. */
export const MAX_CLAIMS = 250;

/** Retrieval floor: below this query-term coverage we refuse to answer. */
export const RETRIEVAL_COVERAGE_FLOOR = 0.34;

/** Chunks handed to the model per question. */
export const RETRIEVE_TOP_K = 6;

export class LimitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LimitError';
    this.code = code;
  }
}

/** Throw a user-readable error when a document is too large to accept. */
export function assertDocSize(chars: number, totalCharsAlready: number): void {
  if (chars > MAX_DOC_CHARS) {
    throw new LimitError(
      'doc_too_large',
      `That document is ${chars.toLocaleString()} characters. The limit is ${MAX_DOC_CHARS.toLocaleString()} — split it and add the parts separately.`,
    );
  }
  if (chars + totalCharsAlready > MAX_TOTAL_CHARS) {
    throw new LimitError(
      'corpus_too_large',
      `Adding that document would put the corpus over ${MAX_TOTAL_CHARS.toLocaleString()} characters. Remove a source first.`,
    );
  }
}

/** Throw when a raw body exceeds what a serverless function will accept. */
export function assertBodySize(bytes: number): void {
  if (bytes > MAX_BODY_BYTES) {
    throw new LimitError(
      'body_too_large',
      `That file is ${(bytes / 1_000_000).toFixed(1)} MB. The limit is ${(MAX_BODY_BYTES / 1_000_000).toFixed(1)} MB because serverless requests are capped — paste the text or split the file.`,
    );
  }
}
