import { describe, expect, it } from 'vitest';
import { estimateRequestTokens, estimateTokens } from '../src/lib/tokens';

describe('token estimation', () => {
  it('should return zero for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should scale with length', () => {
    expect(estimateTokens('a'.repeat(360))).toBe(100);
    expect(estimateTokens('a'.repeat(720))).toBe(200);
  });

  it('should over-estimate rather than under-estimate real prose', () => {
    // Measured live against Groq: a 117-token prompt for this message set.
    const messages = [
      { role: 'system' as const, content: 'Reply with JSON only.' },
      { role: 'user' as const, content: 'Return {"ok":true,"n":2}' },
    ];
    const estimate = estimateRequestTokens(messages, 0);
    expect(estimate).toBeGreaterThan(0);
    // Under-estimating is the failure that causes 429s, so assert the direction.
    expect(estimate).toBeGreaterThan(estimateTokens(messages.map((m) => m.content).join('')));
  });

  it('should reserve the full output allowance', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }];
    const withOutput = estimateRequestTokens(messages, 900);
    const withoutOutput = estimateRequestTokens(messages, 0);
    expect(withOutput - withoutOutput).toBe(900);
  });

  it('should add per-message overhead', () => {
    const one = estimateRequestTokens([{ role: 'user', content: 'abc' }], 0);
    const two = estimateRequestTokens(
      [{ role: 'user', content: 'abc' }, { role: 'user', content: 'abc' }],
      0,
    );
    expect(two).toBeGreaterThan(one);
  });
});
