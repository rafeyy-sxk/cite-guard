/**
 * The scheduler's public contract: states, task shape, errors, events, ledger.
 *
 * Split from the implementation so a caller (the pipeline, the API route, the
 * UI, a test) can depend on the vocabulary without pulling in the engine.
 */

import type { Clock } from './clock';
import type { RollingTokenBudget } from './budget';

export type TaskState =
  | 'queued'
  | 'waiting-budget'
  | 'running'
  | 'retrying'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface TaskContext {
  signal: AbortSignal;
  /** 1 for the first try. */
  attempt: number;
}

export interface TaskOutcome<T> {
  value: T;
  /** Tokens the provider actually billed, used to correct the estimate. */
  tokensUsed: number;
}

export interface SchedulerTask<T> {
  id: string;
  /**
   * Tokens to reserve before dispatch.
   *
   * A function receives the 1-based attempt number, which matters when a retry
   * costs more than the first try. Verification retries raise their output
   * allowance (a reasoning model that ran out of room needs more of it), and
   * reserving that larger figure on EVERY attempt would idle roughly half the
   * per-minute budget waiting on headroom almost no task uses.
   */
  estimateTokens: number | ((attempt: number) => number);
  run(ctx: TaskContext): Promise<TaskOutcome<T>>;
}

/** Thrown by a task when the provider returned 429. */
export class RateLimitError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** Thrown by a task for a transient failure worth retrying (5xx, network). */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableError';
  }
}

export interface Aggregates {
  total: number;
  queued: number;
  waitingBudget: number;
  running: number;
  retrying: number;
  done: number;
  failed: number;
  cancelled: number;
  inFlight: number;
  peakConcurrency: number;
  tokensInWindow: number;
  tokenCeiling: number;
  retries: number;
  rateLimitHits: number;
  elapsedMs: number;
}

export interface TaskSnapshot {
  id: string;
  state: TaskState;
  attempts: number;
  error: string | null;
}

export type SchedulerEvent =
  | { type: 'task'; task: TaskSnapshot; aggregates: Aggregates }
  | { type: 'aggregate'; aggregates: Aggregates };

export type TaskResult<T> =
  | { id: string; state: 'done'; value: T; attempts: number; tokensUsed: number }
  | { id: string; state: 'failed'; error: string; attempts: number }
  | { id: string; state: 'cancelled'; attempts: number };

export interface RunLedger {
  tasks: number;
  /** Dispatch attempts, retries included. Always >= `tasks`. */
  dispatched: number;
  completed: number;
  failed: number;
  cancelled: number;
  retries: number;
  rateLimitHits: number;
  /** Times a task was parked because the window was full. */
  budgetWaits: number;
  peakConcurrency: number;
  wallClockMs: number;
  tokensEstimated: number;
  tokensActual: number;
}

export interface SchedulerOptions {
  concurrency?: number;
  /**
   * Share one budget across several `runScheduled` calls.
   *
   * The provider's window does not reset because our program moved to its next
   * phase. A run that drafts answers and then verifies them is two scheduler
   * passes against ONE 60-second ceiling, so the drafting spend has to still be
   * in the window when verification starts dispatching. Passing a fresh budget
   * per phase would quietly double the allowance and 429 the second phase.
   */
  budget?: RollingTokenBudget;
  tokensPerWindow?: number;
  windowMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  clock?: Clock;
  /** Injectable for deterministic jitter in tests. */
  random?: () => number;
  signal?: AbortSignal;
  onEvent?: (event: SchedulerEvent) => void;
}

/** The provider's stated window. Groq's token limit is per 60 seconds. */
export const PROVIDER_WINDOW_MS = 60_000;

/**
 * A note on something that was tried and is NOT in use, so it is not reinvented.
 *
 * Rate limits in a live 100-claim run arrived in a burst the instant our window
 * first slid, which looks exactly like clock skew: we count from dispatch, the
 * provider counts from receipt, so our entries expire slightly early. Holding
 * entries 3s longer than the provider's window was tried and the run got worse,
 * not better.
 *
 * Stated honestly, that was ONE uncontrolled run against a shared account, and a
 * later controlled A/B showed rate-limit counts on this account swing widely
 * between runs for reasons outside our code. So the margin is not disproven so
 * much as unsupported, and an unsupported knob that costs throughput does not
 * ship. The default is simply the provider's own window.
 */

export const SCHEDULER_DEFAULTS = {
  concurrency: 100,
  tokensPerWindow: 8000,
  windowMs: PROVIDER_WINDOW_MS,
  maxAttempts: 5,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
} as const;

