import { describe, expect, it } from 'vitest';
import { foldedWordCount, normalize, normalizeText, projectRange } from '../src/lib/normalize';

describe('normalize: folding', () => {
  it('should lowercase and strip punctuation to single spaces', () => {
    expect(normalizeText('Hello,   World!!')).toBe('hello world');
  });

  it('should strip accents via NFKD', () => {
    expect(normalizeText('Café naïve')).toBe('cafe naive');
  });

  it('should treat punctuation as a separator, not a deletion', () => {
    expect(normalizeText('cat.Sat')).toBe('cat sat');
  });

  it('should collapse newlines and tabs into single spaces', () => {
    expect(normalizeText('one\n\ttwo   \n three')).toBe('one two three');
  });

  it('should fold curly and straight apostrophes identically', () => {
    expect(normalizeText("Cavendish's")).toBe(normalizeText('Cavendish’s'));
  });

  it('should return an empty string for punctuation-only input', () => {
    expect(normalizeText('--- ... !!!')).toBe('');
    expect(normalizeText('')).toBe('');
  });
});

describe('normalize: offset map', () => {
  it('should keep the map the same length as the folded text', () => {
    const n = normalize('The  quick—brown fox.');
    expect(n.map).toHaveLength(n.text.length);
  });

  it('should project a folded range back onto the original characters', () => {
    const original = 'He said: "The  QUICK   brown fox", loudly.';
    const n = normalize(original);
    const at = n.text.indexOf('quick brown fox');
    const range = projectRange(n, at, at + 'quick brown fox'.length);
    expect(range).not.toBeNull();
    expect(original.slice(range!.start, range!.end)).toBe('QUICK   brown fox');
  });

  it('should project correctly across accented characters', () => {
    const original = 'The café closed early.';
    const n = normalize(original);
    const at = n.text.indexOf('cafe closed');
    const range = projectRange(n, at, at + 'cafe closed'.length)!;
    expect(original.slice(range.start, range.end)).toBe('café closed');
  });

  it('should return null for an out-of-bounds or inverted range', () => {
    const n = normalize('short text');
    expect(projectRange(n, 5, 5)).toBeNull();
    expect(projectRange(n, 0, 9999)).toBeNull();
    expect(projectRange(n, -1, 3)).toBeNull();
  });
});

describe('normalize: word count', () => {
  it('should count folded words', () => {
    expect(foldedWordCount('one two three')).toBe(3);
    expect(foldedWordCount('one')).toBe(1);
    expect(foldedWordCount('')).toBe(0);
  });
});
