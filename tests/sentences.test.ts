import { describe, expect, it } from 'vitest';
import { splitSentences } from '../src/lib/sentences';

describe('sentence splitting', () => {
  it('should split on terminators followed by whitespace', () => {
    const s = splitSentences('One thing happened. Then another! And a third?');
    expect(s.map((x) => x.text)).toEqual(['One thing happened.', 'Then another!', 'And a third?']);
  });

  it('should keep offsets exact', () => {
    const text = '  First sentence.   Second one.  ';
    for (const s of splitSentences(text)) expect(text.slice(s.start, s.end)).toBe(s.text);
  });

  it('should not split on a decimal point', () => {
    expect(splitSentences('The value is 5.448 times water.')).toHaveLength(1);
  });

  it('should not split on a known abbreviation', () => {
    expect(splitSentences('Dr. Cavendish met Mr. Coulomb in Paris.')).toHaveLength(1);
  });

  it('should not split on dotted initials', () => {
    expect(splitSentences('J. R. R. Tolkien wrote it.')).toHaveLength(1);
  });

  it('should keep a closing quote with its sentence', () => {
    const s = splitSentences('He said "it works." Then he left.');
    expect(s).toHaveLength(2);
    expect(s[0]?.text).toBe('He said "it works."');
  });

  it('should split on a blank line even without a terminator', () => {
    const s = splitSentences('A heading\n\nA following sentence.');
    expect(s).toHaveLength(2);
    expect(s[0]?.text).toBe('A heading');
  });

  it('should return nothing for empty or whitespace input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  ')).toEqual([]);
  });

  it('should keep a trailing fragment with no terminator', () => {
    const s = splitSentences('Complete one. Trailing fragment with no stop');
    expect(s).toHaveLength(2);
    expect(s[1]?.text).toBe('Trailing fragment with no stop');
  });
});
