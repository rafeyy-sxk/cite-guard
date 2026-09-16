import { describe, expect, it } from 'vitest';
import { chunkCorpus, chunkDocument } from '../src/lib/chunk';
import type { SourceDoc } from '../src/lib/types';

function doc(text: string, id = 'd1'): SourceDoc {
  return { id, title: 'T', origin: 'paste', text };
}

describe('chunker: degenerate input', () => {
  it('should return no chunks for empty text', () => {
    expect(chunkDocument(doc(''))).toEqual([]);
  });

  it('should return no chunks for whitespace-only text', () => {
    expect(chunkDocument(doc('   \n\n\t  '))).toEqual([]);
  });

  it('should return exactly one chunk for text shorter than the target', () => {
    const chunks = chunkDocument(doc('One short sentence about gravity.'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('One short sentence about gravity.');
  });

  it('should handle a single character', () => {
    const chunks = chunkDocument(doc('x'));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.start).toBe(0);
    expect(chunks[0]?.end).toBe(1);
  });
});

describe('chunker: offsets are exact', () => {
  it('should produce chunks that slice back out of the original text', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} has some words in it.`).join('\n\n');
    const chunks = chunkDocument(doc(text), { targetChars: 200, overlapChars: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(text.slice(c.start, c.end)).toBe(c.text);
    }
  });

  it('should keep offsets exact through unicode', () => {
    const text = 'Café résumé naïve — done.\n\nSecond über paragraph with emoji \u{1F600} inside.';
    const chunks = chunkDocument(doc(text), { targetChars: 40, overlapChars: 10 });
    for (const c of chunks) expect(text.slice(c.start, c.end)).toBe(c.text);
  });

  it('should advance through the document rather than looping', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = chunkDocument(doc(text), { targetChars: 120, overlapChars: 30 });
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.start).toBeGreaterThan(chunks[i - 1]!.start);
      expect(chunks[i]!.end).toBeGreaterThan(chunks[i - 1]!.end);
    }
    expect(chunks[chunks.length - 1]!.end).toBe(text.length);
  });
});

describe('chunker: large and pathological input', () => {
  it('should split a huge document into many bounded chunks', () => {
    const text = Array.from({ length: 800 }, (_, i) => `Paragraph ${i} contains a reasonable amount of text for testing.`).join('\n\n');
    const chunks = chunkDocument(doc(text), { targetChars: 1000, overlapChars: 150 });
    expect(chunks.length).toBeGreaterThan(30);
    // Overlap means a chunk can exceed the target slightly; it must not run away.
    for (const c of chunks) expect(c.end - c.start).toBeLessThan(1000 + 150 + 200);
  });

  it('should hard-split an unbroken run with no sentence boundaries', () => {
    const text = 'a'.repeat(5000);
    const chunks = chunkDocument(doc(text), { targetChars: 500, overlapChars: 0 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.map((c) => c.text).join('').length).toBeGreaterThanOrEqual(5000);
  });

  it('should cover the whole document with no gap between consecutive chunks', () => {
    const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} of the source document.`).join('\n\n');
    const chunks = chunkDocument(doc(text), { targetChars: 200, overlapChars: 50 });
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.start).toBeLessThanOrEqual(chunks[i - 1]!.end);
    }
  });
});

describe('chunker: corpus', () => {
  it('should renumber chunks with short unique ids across documents', () => {
    const chunks = chunkCorpus(
      [doc('First document text here.', 'a'), doc('Second document text here.', 'b')],
    );
    expect(chunks.map((c) => c.id)).toEqual(['c0', 'c1']);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(chunks.length);
    expect(chunks[0]?.docId).toBe('a');
    expect(chunks[1]?.docId).toBe('b');
  });

  it('should return an empty array for an empty corpus', () => {
    expect(chunkCorpus([])).toEqual([]);
  });
});
