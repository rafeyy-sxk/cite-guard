/**
 * Okapi BM25 over the chunked corpus.
 *
 * Retrieval here is deliberately not an embedding API. A hosted embedder would
 * add a second vendor, a second key, a second rate limit and a per-query cost,
 * and for question answering over a corpus the user pasted thirty seconds ago
 * — where the question usually reuses the document's own vocabulary — lexical
 * scoring is the right tool, not a compromise.
 *
 * BM25 formula, standard parameterisation:
 *
 *   score(D,Q) = sum over q in Q of
 *       IDF(q) * ( f(q,D) * (k1 + 1) ) / ( f(q,D) + k1 * (1 - b + b * |D| / avgdl) )
 *
 *   IDF(q) = ln( 1 + (N - n(q) + 0.5) / (n(q) + 0.5) )
 *
 * The probabilistic IDF above is always positive, so a term appearing in every
 * chunk contributes ~0 rather than a negative score that would make a matching
 * chunk rank *below* a non-matching one.
 */

import type { Chunk, ScoredChunk } from './types';
import { normalizeText } from './normalize';

const K1 = 1.5;
const B = 0.75;

/**
 * Words carrying no retrieval signal. Kept short on purpose — an aggressive
 * list throws away real query terms ("no", "not", "all" change a question's
 * meaning), and BM25's IDF already suppresses common words.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'in',
  'into', 'is', 'it', 'its', 'of', 'on', 'or', 'she', 'that', 'the', 'their',
  'them', 'there', 'these', 'they', 'this', 'to', 'was', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
]);

/** Fold, split, drop stopwords and single characters. */
export function tokenize(text: string): string[] {
  const folded = normalizeText(text);
  if (folded.length === 0) return [];
  return folded.split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

interface IndexedChunk {
  chunk: Chunk;
  termFreq: Map<string, number>;
  length: number;
}

export class BM25Index {
  private readonly docs: IndexedChunk[] = [];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;

  constructor(chunks: Chunk[]) {
    let totalLength = 0;
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      const termFreq = new Map<string, number>();
      for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
      for (const t of termFreq.keys()) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
      this.docs.push({ chunk, termFreq, length: tokens.length });
      totalLength += tokens.length;
    }
    this.avgLength = this.docs.length > 0 ? totalLength / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  /** Probabilistic IDF, floored at 0 so a ubiquitous term cannot score negative. */
  private idf(term: string): number {
    const n = this.docFreq.get(term) ?? 0;
    const N = this.docs.length;
    return Math.max(0, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  /**
   * Rank chunks against `query`.
   *
   * Returns at most `topK` chunks with a non-zero score, best first. Ties break
   * on document order so results are stable across runs — a flapping order
   * would make the whole app non-reproducible.
   */
  search(query: string, topK = 6): ScoredChunk[] {
    const queryTerms = tokenize(query);
    if (queryTerms.length === 0 || this.docs.length === 0) return [];

    const distinct = [...new Set(queryTerms)];
    const scored: Array<ScoredChunk & { order: number }> = [];

    this.docs.forEach((doc, order) => {
      let score = 0;
      let present = 0;
      for (const term of distinct) {
        const f = doc.termFreq.get(term) ?? 0;
        if (f === 0) continue;
        present += 1;
        const denom = f + K1 * (1 - B + (B * doc.length) / (this.avgLength || 1));
        score += this.idf(term) * ((f * (K1 + 1)) / denom);
      }
      if (score <= 0) return;
      scored.push({
        chunk: doc.chunk,
        score,
        coverage: present / distinct.length,
        order,
      });
    });

    scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
    return scored.slice(0, topK).map(({ chunk, score, coverage }) => ({ chunk, score, coverage }));
  }
}
