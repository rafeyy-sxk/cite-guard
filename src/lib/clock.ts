/**
 * An injectable clock.
 *
 * The scheduler is mostly *timing* logic — a rolling 60-second token window,
 * exponential backoff, honouring `retry-after`. Testing that against the real
 * clock would mean either sleeping for real (slow, flaky) or not testing it at
 * all. Every time-dependent path therefore takes a `Clock`, and the tests pass
 * a `ManualClock` they drive by hand.
 */

export interface Clock {
  /** Milliseconds since an arbitrary epoch. Monotonic within one clock. */
  now(): number;
  /** Resolve after `ms`. Rejects with the signal's reason if aborted first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export class AbortedError extends Error {
  constructor(message = 'Aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortedError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new AbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

interface PendingTimer {
  at: number;
  resolve: () => void;
  reject: (err: Error) => void;
  onAbort?: () => void;
  signal?: AbortSignal;
}

/**
 * A clock the test drives. `advance()` fires due timers in chronological order
 * and flushes the microtask queue between each one, so a chain of
 * sleep -> retry -> sleep unwinds exactly as it would in production.
 */
export class ManualClock implements Clock {
  private current: number;
  private timers: PendingTimer[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  /** Number of sleeps currently outstanding. */
  get pending(): number {
    return this.timers.length;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortedError());
        return;
      }
      const timer: PendingTimer = { at: this.current + Math.max(0, ms), resolve, reject };
      if (signal) {
        const onAbort = () => {
          this.timers = this.timers.filter((t) => t !== timer);
          reject(new AbortedError());
        };
        timer.signal = signal;
        timer.onAbort = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.timers.push(timer);
    });
  }

  /** Let queued promise callbacks run. Not a time change. */
  static async flush(rounds = 4): Promise<void> {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** Move time forward by `ms`, firing every timer that comes due on the way. */
  async advance(ms: number): Promise<void> {
    const target = this.current + Math.max(0, ms);
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = Math.max(this.current, due.at);
      if (due.signal && due.onAbort) due.signal.removeEventListener('abort', due.onAbort);
      due.resolve();
      await ManualClock.flush();
    }
    this.current = target;
    await ManualClock.flush();
  }

  /**
   * Drive the clock until `promise` settles or the step budget runs out.
   * Guards against a scheduler bug parking the run forever: the test fails with
   * a clear message instead of hanging until the vitest timeout.
   */
  async runUntilSettled<T>(promise: Promise<T>, stepMs = 250, maxSteps = 4000): Promise<T> {
    let settled = false;
    const tracked = promise.then(
      (v) => {
        settled = true;
        return v;
      },
      (e) => {
        settled = true;
        throw e;
      },
    );
    // Swallow rejection on the tracking copy; the caller awaits `tracked`.
    tracked.catch(() => undefined);
    await ManualClock.flush();
    let steps = 0;
    while (!settled) {
      if (steps >= maxSteps) {
        throw new Error(
          `runUntilSettled: promise still pending after ${maxSteps} steps (virtual t=${this.current}ms, ${this.timers.length} timers outstanding)`,
        );
      }
      await this.advance(stepMs);
      steps += 1;
    }
    return tracked;
  }
}
