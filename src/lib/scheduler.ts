/**
 * A work scheduler for rate-limited, embarrassingly parallel model calls.
 *
 * Verification is the ideal shape for this: every claim is independent, so the
 * only thing stopping us checking a hundred at once is the provider's ceiling.
 * On Groq's free tier that ceiling is ~8,000 tokens per minute, measured live
 * (`x-ratelimit-limit-tokens: 8000`). A hundred requests fired at once do not
 * fail gracefully against that - they 429, and naive retry makes it worse.
 *
 * So the scheduler enforces three things at once:
 *
 *  1. **Concurrency.** At most `concurrency` requests in flight (default 100).
 *  2. **Token budget.** Tokens are estimated and *reserved before dispatch*
 *     against a rolling 60-second window. Work that does not fit waits at the
 *     gate in `waiting-budget` rather than being sent and rejected. Preventing a
 *     429 is strictly cheaper than absorbing one.
 *  3. **Retries that terminate.** A 429 honours `retry-after`, returns its
 *     reservation (the request was never processed, so it cost nothing), and is
 *     re-queued with jittered backoff. A task that exhausts `maxAttempts` is
 *     reported `failed` - it is never dropped, and it never wedges the run.
 *
 * Every wait goes through the injected `Clock`, so the whole of this file is
 * testable without a real minute passing.
 */

import { AbortedError, systemClock } from './clock';
import { RollingTokenBudget } from './budget';
import {
  RateLimitError,
  RetryableError,
  SCHEDULER_DEFAULTS,
  type Aggregates,
  type RunLedger,
  type SchedulerOptions,
  type SchedulerTask,
  type TaskResult,
  type TaskState,
} from './scheduler-types';

export * from './scheduler-types';

interface Record_<T> {
  task: SchedulerTask<T>;
  state: TaskState;
  attempts: number;
  error: string | null;
  controller: AbortController | null;
  reserveKey: string | null;
  result: TaskResult<T> | null;
}

export interface SchedulerRun<T> {
  results: Map<string, TaskResult<T>>;
  ledger: RunLedger;
}

export async function runScheduled<T>(
  tasks: SchedulerTask<T>[],
  options: SchedulerOptions = {},
): Promise<SchedulerRun<T>> {
  const concurrency = Math.max(1, options.concurrency ?? SCHEDULER_DEFAULTS.concurrency);
  const tokensPerWindow = options.tokensPerWindow ?? SCHEDULER_DEFAULTS.tokensPerWindow;
  const windowMs = options.windowMs ?? SCHEDULER_DEFAULTS.windowMs;
  const maxAttempts = Math.max(1, options.maxAttempts ?? SCHEDULER_DEFAULTS.maxAttempts);
  const baseBackoffMs = options.baseBackoffMs ?? SCHEDULER_DEFAULTS.baseBackoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? SCHEDULER_DEFAULTS.maxBackoffMs;
  const clock = options.clock ?? systemClock;
  const random = options.random ?? Math.random;
  const onEvent = options.onEvent;

  const budget = options.budget ?? new RollingTokenBudget(tokensPerWindow, windowMs, clock);
  // When a budget is shared the ceiling it was built with is authoritative, so
  // the aggregates report the real limit rather than this call's default.
  const ceiling = budget.limit;
  const startedAt = clock.now();

  const records = new Map<string, Record_<T>>();
  const queue: Array<Record_<T>> = [];
  for (const task of tasks) {
    const rec: Record_<T> = {
      task,
      state: 'queued',
      attempts: 0,
      error: null,
      controller: null,
      reserveKey: null,
      result: null,
    };
    records.set(task.id, rec);
    queue.push(rec);
  }

  const ledger: RunLedger = {
    tasks: tasks.length,
    dispatched: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    retries: 0,
    rateLimitHits: 0,
    budgetWaits: 0,
    peakConcurrency: 0,
    wallClockMs: 0,
    tokensEstimated: 0,
    tokensActual: 0,
  };

  let inFlight = 0;
  let pendingRetries = 0;
  let finished = false;
  let cancelling = false;
  let wakeAt: number | null = null;
  let resolveRun!: () => void;
  const runDone = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });

  /** Tokens to reserve for a given attempt of a task. */
  const estimateFor = (task: SchedulerTask<T>, attempt: number): number =>
    typeof task.estimateTokens === 'function' ? task.estimateTokens(attempt) : task.estimateTokens;

  const counts = (): Aggregates => {
    const a: Aggregates = {
      total: records.size,
      queued: 0,
      waitingBudget: 0,
      running: 0,
      retrying: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      inFlight,
      peakConcurrency: ledger.peakConcurrency,
      tokensInWindow: budget.spent(),
      tokenCeiling: ceiling,
      retries: ledger.retries,
      rateLimitHits: ledger.rateLimitHits,
      elapsedMs: clock.now() - startedAt,
    };
    for (const rec of records.values()) {
      if (rec.state === 'queued') a.queued += 1;
      else if (rec.state === 'waiting-budget') a.waitingBudget += 1;
      else if (rec.state === 'running') a.running += 1;
      else if (rec.state === 'retrying') a.retrying += 1;
      else if (rec.state === 'done') a.done += 1;
      else if (rec.state === 'failed') a.failed += 1;
      else a.cancelled += 1;
    }
    return a;
  };

  const setState = (rec: Record_<T>, state: TaskState): void => {
    rec.state = state;
    onEvent?.({
      type: 'task',
      task: { id: rec.task.id, state, attempts: rec.attempts, error: rec.error },
      aggregates: counts(),
    });
  };

  const maybeFinish = (): void => {
    if (finished) return;
    if (inFlight > 0 || pendingRetries > 0 || queue.length > 0) return;
    finished = true;
    ledger.wallClockMs = clock.now() - startedAt;
    onEvent?.({ type: 'aggregate', aggregates: counts() });
    resolveRun();
  };

  const failTask = (rec: Record_<T>, message: string): void => {
    rec.error = message;
    rec.result = { id: rec.task.id, state: 'failed', error: message, attempts: rec.attempts };
    ledger.failed += 1;
    setState(rec, 'failed');
  };

  const cancelTask = (rec: Record_<T>): void => {
    if (rec.result) return;
    rec.result = { id: rec.task.id, state: 'cancelled', attempts: rec.attempts };
    ledger.cancelled += 1;
    setState(rec, 'cancelled');
  };

  const backoffDelay = (attempt: number, retryAfterMs?: number): number => {
    const exponential = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, attempt - 1));
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      // Never wait less than the server asked for. The added jitter is what
      // stops a hundred tasks waking on the same millisecond and 429ing again.
      return retryAfterMs + random() * Math.min(exponential, 1000);
    }
    // Equal jitter: half the window fixed, half random. Spreads retries without
    // ever collapsing the delay to zero.
    return exponential * (0.5 + 0.5 * random());
  };

  const scheduleWake = (at: number): void => {
    if (wakeAt !== null && wakeAt <= at) return;
    wakeAt = at;
    const delay = Math.max(0, at - clock.now());
    clock.sleep(delay).then(
      () => {
        wakeAt = null;
        pump();
      },
      () => {
        wakeAt = null;
      },
    );
  };

  const onAttemptError = (rec: Record_<T>, reserveKey: string, err: unknown): void => {
    const aborted = cancelling || err instanceof AbortedError || (err as Error)?.name === 'AbortError';
    if (aborted) {
      budget.release(reserveKey);
      cancelTask(rec);
      return;
    }

    const isRateLimit = err instanceof RateLimitError;
    if (isRateLimit) {
      ledger.rateLimitHits += 1;
      // A 429 is refused before the model runs, so those tokens were never
      // spent. Holding the reservation would throttle us against a phantom.
      budget.release(reserveKey);
    }
    // Any other error may have consumed tokens server-side; the reservation is
    // deliberately kept so the ceiling is respected under uncertainty.

    const retryable = isRateLimit || err instanceof RetryableError;
    const message = err instanceof Error ? err.message : String(err);

    if (!retryable || rec.attempts >= maxAttempts) {
      failTask(rec, `${message} (after ${rec.attempts} attempt(s))`);
      return;
    }

    ledger.retries += 1;
    rec.error = message;
    setState(rec, 'retrying');
    pendingRetries += 1;
    const delay = backoffDelay(rec.attempts, isRateLimit ? (err as RateLimitError).retryAfterMs : undefined);
    clock.sleep(delay, options.signal).then(
      () => {
        pendingRetries -= 1;
        if (cancelling) cancelTask(rec);
        else {
          setState(rec, 'queued');
          queue.push(rec);
        }
        pump();
      },
      () => {
        pendingRetries -= 1;
        cancelTask(rec);
        pump();
      },
    );
  };

  const dispatch = (rec: Record_<T>): void => {
    rec.attempts += 1;
    const reserveKey = `${rec.task.id}#${rec.attempts}`;
    rec.reserveKey = reserveKey;
    ledger.dispatched += 1;
    ledger.tokensEstimated += estimateFor(rec.task, rec.attempts);

    inFlight += 1;
    ledger.peakConcurrency = Math.max(ledger.peakConcurrency, inFlight);

    const controller = new AbortController();
    rec.controller = controller;
    if (options.signal?.aborted) controller.abort();

    setState(rec, 'running');

    void (async () => {
      try {
        const outcome = await rec.task.run({ signal: controller.signal, attempt: rec.attempts });
        return { ok: true as const, outcome };
      } catch (err) {
        return { ok: false as const, err };
      }
    })().then((settled) => {
      inFlight -= 1;
      rec.controller = null;
      if (settled.ok) {
        budget.reconcile(reserveKey, settled.outcome.tokensUsed);
        ledger.tokensActual += settled.outcome.tokensUsed;
        ledger.completed += 1;
        rec.result = {
          id: rec.task.id,
          state: 'done',
          value: settled.outcome.value,
          attempts: rec.attempts,
          tokensUsed: settled.outcome.tokensUsed,
        };
        setState(rec, 'done');
      } else {
        onAttemptError(rec, reserveKey, settled.err);
      }
      pump();
    });
  };

  const pump = (): void => {
    if (finished) return;

    if (cancelling) {
      while (queue.length > 0) cancelTask(queue.shift()!);
      maybeFinish();
      return;
    }

    while (inFlight < concurrency && queue.length > 0) {
      const rec = queue[0]!;
      const estimate = estimateFor(rec.task, rec.attempts + 1);
      const reservation = budget.reserve(`${rec.task.id}#${rec.attempts + 1}`, estimate);

      if (reservation.ok) {
        queue.shift();
        dispatch(rec);
        continue;
      }

      if (reservation.reason === 'exceeds_ceiling') {
        // Waiting can never make room for this one. Fail it now with a message
        // that says what to change, rather than parking the run forever.
        queue.shift();
        rec.attempts += 1;
        failTask(
          rec,
          `Estimated ${estimate} tokens exceeds the ${ceiling}-token window ceiling; this request can never fit.`,
        );
        continue;
      }

      // Head-of-line wait. The queue is FIFO and tasks here are near-identical
      // in size, so blocking on the head is fair; letting smaller tasks jump it
      // would starve the largest claim in the run.
      if (rec.state !== 'waiting-budget') {
        ledger.budgetWaits += 1;
        setState(rec, 'waiting-budget');
      }
      scheduleWake(reservation.retryAt);
      break;
    }

    maybeFinish();
  };

  const onAbort = (): void => {
    if (cancelling || finished) return;
    cancelling = true;
    for (const rec of records.values()) {
      if (rec.state === 'running' && rec.controller) rec.controller.abort();
    }
    pump();
  };

  if (options.signal) {
    if (options.signal.aborted) cancelling = true;
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }

  pump();
  await runDone;
  options.signal?.removeEventListener('abort', onAbort);

  const results = new Map<string, TaskResult<T>>();
  for (const [id, rec] of records) {
    results.set(id, rec.result ?? { id, state: 'cancelled', attempts: rec.attempts });
  }
  return { results, ledger };
}
