/**
 * Test doubles.
 *
 * No test in this suite touches the network or reads an API key. The Groq
 * transport is replaced by a fake that models the one behaviour that matters —
 * a rolling token limit that returns 429 when you exceed it — so the scheduler
 * is tested against a rate limiter rather than against a mock that always says
 * yes.
 */

import { RateLimitError } from '../src/lib/scheduler-types';
import type { Clock } from '../src/lib/clock';

/**
 * A provider with a sliding token window, like Groq's.
 *
 * `call()` records a spend and throws `RateLimitError` when the window is
 * already full. If the scheduler's own budget gate works, this should never
 * throw — which makes "rateLimitHits === 0" a meaningful assertion rather than
 * a tautology.
 */
export class FakeRateLimitedProvider {
  private spends: Array<{ at: number; tokens: number }> = [];
  calls = 0;
  refusals = 0;

  constructor(
    private readonly clock: Clock,
    readonly limit: number,
    readonly windowMs: number,
    /** Simulated latency per call, in virtual ms. */
    private readonly latencyMs = 40,
  ) {}

  private spent(now: number): number {
    this.spends = this.spends.filter((s) => s.at > now - this.windowMs);
    return this.spends.reduce((sum, s) => sum + s.tokens, 0);
  }

  /** Highest the window ever reached. Asserted against the ceiling in tests. */
  peakWindow = 0;

  async call(tokens: number, signal?: AbortSignal): Promise<number> {
    const now = this.clock.now();
    if (this.spent(now) + tokens > this.limit) {
      this.refusals += 1;
      throw new RateLimitError('429 token rate limit', 1000);
    }
    this.spends.push({ at: now, tokens });
    this.peakWindow = Math.max(this.peakWindow, this.spent(now));
    this.calls += 1;
    await this.clock.sleep(this.latencyMs, signal);
    return tokens;
  }
}

/** Tracks how many task bodies are executing at once. */
export class ConcurrencyProbe {
  current = 0;
  peak = 0;

  enter(): void {
    this.current += 1;
    this.peak = Math.max(this.peak, this.current);
  }

  exit(): void {
    this.current -= 1;
  }
}

/** Deterministic stand-in for Math.random: cycles through fixed values. */
export function seededRandom(values: number[] = [0.1, 0.5, 0.9, 0.3, 0.7]): () => number {
  let i = 0;
  return () => {
    const v = values[i % values.length]!;
    i += 1;
    return v;
  };
}

/** Build a Response-like object for mocking `fetch`. */
export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** A Groq chat-completions payload. */
export function completion(content: string, totalTokens = 100): Response {
  return jsonResponse({
    model: 'test-model',
    choices: [{ message: { content } }],
    usage: {
      prompt_tokens: Math.floor(totalTokens * 0.8),
      completion_tokens: Math.ceil(totalTokens * 0.2),
      total_tokens: totalTokens,
    },
  });
}
