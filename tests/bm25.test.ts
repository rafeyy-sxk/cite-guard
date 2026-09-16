import { describe, expect, it } from 'vitest';
import { BM25Index, tokenize } from '../src/lib/bm25';
import type { Chunk } from '../src/lib/types';

/** A corpus with a deliberately known ranking. */
const CORPUS: Array<[string, string]> = [
  ['c0', 'The photovoltaic panel converts sunlight directly into electricity using semiconductors.'],
  ['c1', 'Wind turbines convert kinetic energy in moving air into electricity using a generator.'],
  ['c2', 'A photovoltaic cell loses efficiency as its temperature rises, so photovoltaic arrays are ventilated.'],
  ['c3', 'Baking sourdough requires a mature starter, a long bulk ferment, and a very hot oven.'],
  ['c4', 'Grid electricity is distributed at high voltage to reduce transmission losses.'],
];

function chunks(): Chunk[] {
  return CORPUS.map(([id, text], index) => ({
    id,
    docId: 'd',
    docTitle: 'doc',
    text,
    start: index * 1000,
    end: index * 1000 + text.length,
    index,
  }));
}

describe('bm25: tokenizer', () => {
  it('should fold case, punctuation and accents', () => {
    expect(tokenize('Photovoltaic, PHOTOVOLTAIC; café!')).toEqual(['photovoltaic', 'photovoltaic', 'cafe']);
  });

  it('should drop stopwords and single characters', () => {
    expect(tokenize('the a of X turbine')).toEqual(['turbine']);
  });

  it('should keep numbers, which carry real retrieval signal', () => {
    expect(tokenize('revenue rose 42 percent in 2024')).toContain('42');
    expect(tokenize('revenue rose 42 percent in 2024')).toContain('2024');
  });

  it('should return an empty list for whitespace-only input', () => {
    expect(tokenize('   \n\t ')).toEqual([]);
  });
});

describe('bm25: ranking', () => {
  it('should rank the repeated-term chunk above the single-mention chunk', () => {
    const results = new BM25Index(chunks()).search('photovoltaic efficiency temperature');
    expect(results.map((r) => r.chunk.id).slice(0, 2)).toEqual(['c2', 'c0']);
  });

  it('should produce the expected order on a known query', () => {
    const results = new BM25Index(chunks()).search('electricity generator wind');
    expect(results[0]?.chunk.id).toBe('c1');
    expect(results.map((r) => r.chunk.id)).not.toContain('c3');
  });

  it('should score an unrelated chunk at zero and omit it entirely', () => {
    const results = new BM25Index(chunks()).search('sourdough starter oven');
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.id).toBe('c3');
  });

  it('should report coverage as the fraction of query terms present', () => {
    const results = new BM25Index(chunks()).search('photovoltaic sourdough');
    const c2 = results.find((r) => r.chunk.id === 'c2');
    expect(c2?.coverage).toBeCloseTo(0.5, 5);
    const c3 = results.find((r) => r.chunk.id === 'c3');
    expect(c3?.coverage).toBeCloseTo(0.5, 5);
  });

  it('should give full coverage when every query term is present', () => {
    const results = new BM25Index(chunks()).search('photovoltaic panel sunlight');
    expect(results[0]?.chunk.id).toBe('c0');
    expect(results[0]?.coverage).toBeCloseTo(1, 5);
  });

  it('should respect topK', () => {
    expect(new BM25Index(chunks()).search('electricity', 2)).toHaveLength(2);
  });

  it('should return nothing for an all-stopword query', () => {
    expect(new BM25Index(chunks()).search('the and of')).toEqual([]);
  });

  it('should return nothing for an empty index', () => {
    expect(new BM25Index([]).search('photovoltaic')).toEqual([]);
  });

  it('should never score a matching chunk below a non-matching one', () => {
    // A term present in every chunk has IDF ~0; it must not push scores negative.
    const all = chunks().map((c) => ({ ...c, text: `${c.text} electricity` }));
    const results = new BM25Index(all).search('electricity');
    expect(results.every((r) => r.score >= 0)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('should break ties deterministically across repeated searches', () => {
    const index = new BM25Index(chunks());
    const a = index.search('electricity').map((r) => r.chunk.id);
    const b = index.search('electricity').map((r) => r.chunk.id);
    expect(a).toEqual(b);
  });
});
