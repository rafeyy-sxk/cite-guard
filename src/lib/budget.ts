/**
 * A rolling-window token budget.
 *
 * Groq's free tier caps tokens per minute (measured live on this key:
 * `x-ratelimit-limit-tokens: 8000`). The cap is a *sliding* window, not a bucket
 * that refills on the minute, so the only way to stay under it is to remember
 * what was spent and when.
 *
 * The critical design point is that tokens are **reserved before dispatch, not
 * recorded after completion**. With 100 requests in flight, recording on
 * completion means all 100 pass the gate while the window still reads zero, and
 * the ceiling is blown before the first response arrives. So:
 *
 *   reserve(id, estimate)  -> gate decision, estimate enters the window NOW
 *   reconcile(id, actual)  -> swap the estimate for the billed figure, same timestamp
 *   release(id)            -> the request never reached the model; take it back
 *
 * `reconcile` only ever RAISES an entry, never lowers it. See the note on
 * `reconcile` below for the measurement behind that asymmetry.
 */

import type { Clock } from './clock';

export interface BudgetEntry {
  id: string;
  /** Clock time the reservation was made. Never changes after reconciliation. */
  at: number;
  tokens: number;
}

export type ReserveResult =
  | { ok: true }
  /** No room right now. Retry at or after `retryAt`, when the window slides. */
  | { ok: false; reason: 'window_full'; retryAt: number }
  /** Bigger than the whole window; waiting cannot help. */
  | { ok: false; reason: 'exceeds_ceiling' };

export class RollingTokenBudget {
  private entries: BudgetEntry[] = [];

  constructor(
    /** Tokens permitted per window. */
    readonly limit: number,
    /** Window length in milliseconds. */
    readonly windowMs: number,
    private readonly clock: Clock,
  ) {}

  /** Drop entries that have slid out of the window. */
  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    if (this.entries.length > 0 && this.entries[0]!.at <= cutoff) {
      this.entries = this.entries.filter((e) => e.at > cutoff);
    }
  }

  /** Tokens spent inside the trailing window as of now. */
  spent(): number {
    const now = this.clock.now();
    this.prune(now);
    return this.entries.reduce((sum, e) => sum + e.tokens, 0);
  }

  /** Live entries, for assertions and for the UI meter. */
  snapshot(): BudgetEntry[] {
    this.prune(this.clock.now());
    return this.entries.map((e) => ({ ...e }));
  }

  /**
   * Try to take `tokens` out of the current window.
   *
   * On refusal, `retryAt` is the moment the oldest entry leaves the window —
   * the earliest time the answer could possibly change. Polling before then is
   * guaranteed to get the same answer, so the scheduler sleeps exactly that long.
   */
  reserve(id: string, tokens: number): ReserveResult {
    if (tokens > this.limit) return { ok: false, reason: 'exceeds_ceiling' };

    const now = this.clock.now();
    this.prune(now);
    const spent = this.entries.reduce((sum, e) => sum + e.tokens, 0);

    if (spent + tokens > this.limit) {
      const oldest = this.entries[0];
      return {
        ok: false,
        reason: 'window_full',
        // No entries yet but still refused means `tokens > limit`, already
        // handled above; the fallback keeps the type total.
        retryAt: oldest ? oldest.at + this.windowMs : now + this.windowMs,
      };
    }

    this.entries.push({ id, at: now, tokens });
    return { ok: true };
  }

  /**
   * Raise an entry to the figure the API actually billed. Never lowers it.
   *
   * The reasoning: a provider admits a request against `prompt +
   * max_completion_tokens`, not against what the completion turns out to cost.
   * Handing back the unused output allowance the moment a response lands would
   * create headroom that exists only on our side of the window, and we would
   * dispatch into it and be refused.
   *
   * How strong is the evidence? A controlled back-to-back A/B over 100 live
   * claims - same document, same claims, same ceiling, only this method
   * differing - gave 0 rate limits and 100 model calls raise-only, against 1
   * rate limit and 101 model calls when lowering. So the direction is right but
   * the effect is small. It is kept because it is free: identical wall clock
   * (241.3s vs 240.9s) and one fewer call. It is NOT the reason an earlier
   * uncontrolled run saw 26 rate limits; that was account variance.
   *
   * Raising still matters: an actual that exceeds its estimate is real spend the
   * window has to account for.
   */
  reconcile(id: string, actualTokens: number): void {
    const entry = this.entries.find((e) => e.id === id);
    if (entry) entry.tokens = Math.max(entry.tokens, Math.max(0, actualTokens));
  }

  /** Give a reservation back — used when a request is rejected unprocessed (429). */
  release(id: string): void {
    const index = this.entries.findIndex((e) => e.id === id);
    if (index !== -1) this.entries.splice(index, 1);
  }
}
