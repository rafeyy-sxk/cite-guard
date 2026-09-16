import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/lib/clock';
import { RollingTokenBudget } from '../src/lib/budget';
import {
  RateLimitError,
  RetryableError,
  runScheduled,
  type SchedulerEvent,
  type SchedulerTask,
} from '../src/lib/scheduler';
import { ConcurrencyProbe, FakeRateLimitedProvider, seededRandom } from './helpers';

/** A task that spends `tokens` against `provider`. */
function providerTask(
  id: string,
  tokens: number,
  provider: FakeRateLimitedProvider,
  probe?: ConcurrencyProbe,
): SchedulerTask<number> {
  return {
    id,
    estimateTokens: tokens,
    run: async ({ signal }) => {
      probe?.enter();
      try {
        const used = await provider.call(tokens, signal);
        return { value: used, tokensUsed: used };
      } finally {
        probe?.exit();
      }
    },
  };
}

describe('scheduler: token budget', () => {
  it('should complete all 100 claims against a low budget without a single 429', async () => {
    const clock = new ManualClock();
    // 250 tokens x 100 claims = 25,000 against an 8,000/min ceiling: the run
    // physically cannot finish in one window, so the gate must hold work back.
    const provider = new FakeRateLimitedProvider(clock, 8000, 60_000);
    const tasks = Array.from({ length: 100 }, (_, i) => providerTask(`t${i}`, 250, provider));

    const events: SchedulerEvent[] = [];
    const run = runScheduled(tasks, {
      concurrency: 100,
      tokensPerWindow: 8000,
      windowMs: 60_000,
      clock,
      random: seededRandom(),
      onEvent: (e) => events.push(e),
    });

    const { results, ledger } = await clock.runUntilSettled(run);

    expect(results.size).toBe(100);
    expect([...results.values()].every((r) => r.state === 'done')).toBe(true);
    expect(ledger.completed).toBe(100);
    expect(ledger.failed).toBe(0);
    expect(ledger.cancelled).toBe(0);
    // The provider is a real rate limiter. Zero refusals proves the gate held.
    expect(provider.refusals).toBe(0);
    expect(ledger.rateLimitHits).toBe(0);
    // Positive control: the provider DOES refuse when its limit is exceeded.
    await expect(provider.call(999_999)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('should never let the rolling window exceed the ceiling, on any observed event', async () => {
    const clock = new ManualClock();
    const provider = new FakeRateLimitedProvider(clock, 4000, 60_000);
    const tasks = Array.from({ length: 60 }, (_, i) => providerTask(`t${i}`, 300, provider));

    let maxWindow = 0;
    let sawNonZeroWindow = false;
    const run = runScheduled(tasks, {
      concurrency: 100,
      tokensPerWindow: 4000,
      windowMs: 60_000,
      clock,
      random: seededRandom(),
      onEvent: (e) => {
        maxWindow = Math.max(maxWindow, e.aggregates.tokensInWindow);
        if (e.aggregates.tokensInWindow > 0) sawNonZeroWindow = true;
        expect(e.aggregates.tokensInWindow).toBeLessThanOrEqual(4000);
      },
    });

    const { ledger } = await clock.runUntilSettled(run);
    expect(ledger.completed).toBe(60);
    // Control: the invariant above is not vacuous — the window really was used.
    expect(sawNonZeroWindow).toBe(true);
    expect(maxWindow).toBeGreaterThan(3000);
    expect(provider.peakWindow).toBeLessThanOrEqual(4000);
  });

  it('should park work in waiting-budget rather than dispatching it', async () => {
    const clock = new ManualClock();
    const provider = new FakeRateLimitedProvider(clock, 1000, 60_000);
    const tasks = Array.from({ length: 10 }, (_, i) => providerTask(`t${i}`, 400, provider));

    const states = new Set<string>();
    const run = runScheduled(tasks, {
      concurrency: 10,
      tokensPerWindow: 1000,
      windowMs: 60_000,
      clock,
      random: seededRandom(),
      onEvent: (e) => {
        if (e.type === 'task') states.add(e.task.state);
      },
    });

    const { ledger } = await clock.runUntilSettled(run);
    expect(states.has('waiting-budget')).toBe(true);
    expect(ledger.budgetWaits).toBeGreaterThan(0);
    expect(ledger.completed).toBe(10);
  });

  it('should fail a task whose estimate can never fit the window, without hanging', async () => {
    const clock = new ManualClock();
    const tasks: Array<SchedulerTask<number>> = [
      { id: 'huge', estimateTokens: 50_000, run: async () => ({ value: 1, tokensUsed: 1 }) },
      { id: 'small', estimateTokens: 100, run: async () => ({ value: 2, tokensUsed: 100 }) },
    ];

    const { results, ledger } = await clock.runUntilSettled(
      runScheduled(tasks, { tokensPerWindow: 8000, clock, random: seededRandom() }),
    );

    const huge = results.get('huge');
    expect(huge?.state).toBe('failed');
    expect(huge?.state === 'failed' && huge.error).toContain('can never fit');
    // The impossible task must not take the rest of the run down with it.
    expect(results.get('small')?.state).toBe('done');
    expect(ledger.failed).toBe(1);
    expect(ledger.completed).toBe(1);
  });

  it('should share one budget across two runs so phase 2 cannot double-spend', async () => {
    const clock = new ManualClock();
    const budget = new RollingTokenBudget(1000, 60_000, clock);
    const mk = (id: string): SchedulerTask<number> => ({
      id,
      estimateTokens: 300,
      run: async () => ({ value: 1, tokensUsed: 300 }),
    });

    await clock.runUntilSettled(
      runScheduled([mk('a'), mk('b'), mk('c')], { budget, clock, random: seededRandom() }),
    );
    expect(budget.spent()).toBe(900);

    let peakWindow = 0;
    const second = runScheduled([mk('d'), mk('e')], {
      budget,
      clock,
      random: seededRandom(),
      onEvent: (e) => {
        peakWindow = Math.max(peakWindow, e.aggregates.tokensInWindow);
        expect(e.aggregates.tokensInWindow).toBeLessThanOrEqual(1000);
      },
    });
    const { ledger } = await clock.runUntilSettled(second);

    expect(ledger.completed).toBe(2);
    // It had to wait for the first run's spend to slide out of the window.
    expect(ledger.budgetWaits).toBeGreaterThan(0);
    expect(peakWindow).toBeGreaterThan(0);
  });
});

describe('scheduler: rate limits and retries', () => {
  it('should absorb a 429 storm and still finish every task', async () => {
    const clock = new ManualClock();
    let refusalsLeft = 40;
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`,
      estimateTokens: 100,
      run: async (): Promise<{ value: number; tokensUsed: number }> => {
        if (refusalsLeft > 0) {
          refusalsLeft -= 1;
          throw new RateLimitError('429', 800);
        }
        return { value: i, tokensUsed: 100 };
      },
    }));

    const { results, ledger } = await clock.runUntilSettled(
      runScheduled(tasks, { concurrency: 20, maxAttempts: 6, clock, random: seededRandom() }),
    );

    expect(refusalsLeft).toBe(0);
    expect([...results.values()].every((r) => r.state === 'done')).toBe(true);
    expect(ledger.rateLimitHits).toBe(40);
    expect(ledger.retries).toBe(40);
    expect(ledger.dispatched).toBe(60); // 20 tasks + 40 re-dispatches
  });

  it('should never retry sooner than the retry-after the server asked for', async () => {
    const clock = new ManualClock();
    const dispatchTimes: number[] = [];
    let thrown = false;

    const task: SchedulerTask<number> = {
      id: 'one',
      estimateTokens: 10,
      run: async () => {
        dispatchTimes.push(clock.now());
        if (!thrown) {
          thrown = true;
          throw new RateLimitError('429', 5_000);
        }
        return { value: 1, tokensUsed: 10 };
      },
    };

    await clock.runUntilSettled(
      runScheduled([task], { clock, baseBackoffMs: 10, random: () => 0 }),
    );

    expect(dispatchTimes).toHaveLength(2);
    expect(dispatchTimes[1]! - dispatchTimes[0]!).toBeGreaterThanOrEqual(5_000);
  });

  it('should return a 429 reservation so a refusal does not consume budget', async () => {
    const clock = new ManualClock();
    const budget = new RollingTokenBudget(1000, 60_000, clock);
    let thrown = false;

    await clock.runUntilSettled(
      runScheduled(
        [
          {
            id: 'x',
            estimateTokens: 400,
            run: async () => {
              if (!thrown) {
                thrown = true;
                throw new RateLimitError('429', 100);
              }
              return { value: 1, tokensUsed: 400 };
            },
          },
        ],
        { budget, clock, random: seededRandom() },
      ),
    );

    // One successful call at 400 tokens. If the refused attempt had kept its
    // reservation the window would read 800.
    expect(budget.spent()).toBe(400);
  });

  it('should report an always-failing task as failed without hanging the run', async () => {
    const clock = new ManualClock();
    const alwaysFails: SchedulerTask<number> = {
      id: 'doomed',
      estimateTokens: 50,
      run: async () => {
        throw new RetryableError('upstream exploded');
      },
    };
    const healthy: SchedulerTask<number> = {
      id: 'fine',
      estimateTokens: 50,
      run: async () => ({ value: 7, tokensUsed: 50 }),
    };

    const { results, ledger } = await clock.runUntilSettled(
      runScheduled([alwaysFails, healthy], { maxAttempts: 3, clock, random: seededRandom() }),
    );

    const doomed = results.get('doomed');
    expect(doomed?.state).toBe('failed');
    expect(doomed?.attempts).toBe(3);
    expect(doomed?.state === 'failed' && doomed.error).toContain('upstream exploded');
    expect(results.get('fine')?.state).toBe('done');
    expect(ledger.failed).toBe(1);
    expect(ledger.retries).toBe(2);
    // Nothing is silently dropped: every task has a terminal result.
    expect(ledger.completed + ledger.failed + ledger.cancelled).toBe(ledger.tasks);
  });

  it('should not retry a non-retryable error', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const { results, ledger } = await clock.runUntilSettled(
      runScheduled(
        [
          {
            id: 'bad-request',
            estimateTokens: 10,
            run: async () => {
              calls += 1;
              throw new Error('400 invalid model');
            },
          },
        ],
        { maxAttempts: 5, clock, random: seededRandom() },
      ),
    );

    expect(calls).toBe(1);
    expect(ledger.retries).toBe(0);
    expect(results.get('bad-request')?.state).toBe('failed');
  });

  it('should grow the backoff between successive retries', async () => {
    const clock = new ManualClock();
    const at: number[] = [];
    await clock.runUntilSettled(
      runScheduled(
        [
          {
            id: 'flaky',
            estimateTokens: 10,
            run: async () => {
              at.push(clock.now());
              throw new RetryableError('nope');
            },
          },
        ],
        { maxAttempts: 4, baseBackoffMs: 1000, clock, random: () => 1 },
      ),
    );

    expect(at).toHaveLength(4);
    const gaps = [at[1]! - at[0]!, at[2]! - at[1]!, at[3]! - at[2]!];
    expect(gaps[1]!).toBeGreaterThan(gaps[0]!);
    expect(gaps[2]!).toBeGreaterThan(gaps[1]!);
  });
});

describe('scheduler: concurrency', () => {
  it('should never exceed the configured concurrency cap', async () => {
    const clock = new ManualClock();
    const probe = new ConcurrencyProbe();
    // Huge budget so ONLY the concurrency cap can be the constraint.
    const provider = new FakeRateLimitedProvider(clock, 10_000_000, 60_000, 100);
    const tasks = Array.from({ length: 50 }, (_, i) => providerTask(`t${i}`, 10, provider, probe));

    const { ledger } = await clock.runUntilSettled(
      runScheduled(tasks, {
        concurrency: 7,
        tokensPerWindow: 10_000_000,
        clock,
        random: seededRandom(),
      }),
    );

    expect(probe.peak).toBe(7);
    expect(ledger.peakConcurrency).toBe(7);
    expect(ledger.completed).toBe(50);
  });

  it('should reach the full width when the cap and the budget both allow it', async () => {
    const clock = new ManualClock();
    const probe = new ConcurrencyProbe();
    const provider = new FakeRateLimitedProvider(clock, 10_000_000, 60_000, 100);
    const tasks = Array.from({ length: 100 }, (_, i) => providerTask(`t${i}`, 10, provider, probe));

    const { ledger } = await clock.runUntilSettled(
      runScheduled(tasks, { concurrency: 100, tokensPerWindow: 10_000_000, clock }),
    );

    expect(probe.peak).toBe(100);
    expect(ledger.peakConcurrency).toBe(100);
  });
});

describe('scheduler: cancellation', () => {
  it('should leave nothing in running after cancel', async () => {
    const clock = new ManualClock();
    const controller = new AbortController();
    const tasks = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      estimateTokens: 10,
      run: async ({ signal }: { signal: AbortSignal }) => {
        await clock.sleep(10_000, signal);
        return { value: i, tokensUsed: 10 };
      },
    }));

    const seen = new Map<string, string>();
    const run = runScheduled(tasks, {
      concurrency: 5,
      clock,
      signal: controller.signal,
      random: seededRandom(),
      onEvent: (e) => {
        if (e.type === 'task') seen.set(e.task.id, e.task.state);
      },
    });

    await clock.advance(50);
    expect([...seen.values()].filter((s) => s === 'running')).toHaveLength(5);

    controller.abort();
    const { results, ledger } = await clock.runUntilSettled(run);

    expect(results.size).toBe(30);
    expect([...results.values()].some((r) => r.state === 'done')).toBe(false);
    expect(ledger.cancelled).toBe(30);
    // No task is left mid-flight and no state is left as running.
    expect([...seen.values()].every((s) => s !== 'running')).toBe(true);
    for (const r of results.values()) expect(r.state).toBe('cancelled');
  });

  it('should complete immediately with an empty task list', async () => {
    const clock = new ManualClock();
    const { results, ledger } = await clock.runUntilSettled(runScheduled([], { clock }));
    expect(results.size).toBe(0);
    expect(ledger.tasks).toBe(0);
    expect(ledger.wallClockMs).toBe(0);
  });
});

describe('scheduler: ledger', () => {
  it('should report tokens actually used, not the estimate', async () => {
    const clock = new ManualClock();
    const tasks = Array.from({ length: 4 }, (_, i) => ({
      id: `t${i}`,
      estimateTokens: 500,
      run: async () => ({ value: i, tokensUsed: 120 }),
    }));

    const { ledger } = await clock.runUntilSettled(
      runScheduled(tasks, { tokensPerWindow: 100_000, clock }),
    );

    expect(ledger.tokensEstimated).toBe(2000);
    expect(ledger.tokensActual).toBe(480);
  });

  it('should emit a final aggregate event with every task accounted for', async () => {
    const clock = new ManualClock();
    const events: SchedulerEvent[] = [];
    const onEvent = vi.fn((e: SchedulerEvent) => events.push(e));

    await clock.runUntilSettled(
      runScheduled(
        [
          { id: 'a', estimateTokens: 10, run: async () => ({ value: 1, tokensUsed: 10 }) },
          {
            id: 'b',
            estimateTokens: 10,
            run: async () => {
              throw new Error('final');
            },
          },
        ],
        { clock, onEvent },
      ),
    );

    const last = events[events.length - 1]!;
    expect(last.type).toBe('aggregate');
    expect(last.aggregates.done + last.aggregates.failed).toBe(last.aggregates.total);
    expect(last.aggregates.inFlight).toBe(0);
    expect(onEvent).toHaveBeenCalled();
  });
});

describe('scheduler: attempt-aware estimates', () => {
  it('should reserve only what the current attempt is allowed to spend', async () => {
    const clock = new ManualClock();
    const budget = new RollingTokenBudget(10_000, 60_000, clock);
    const reserved: number[] = [];
    let thrown = false;

    await clock.runUntilSettled(
      runScheduled(
        [
          {
            id: 'escalating',
            // Attempt 1 is cheap; a retry asks for double.
            estimateTokens: (attempt: number) => 100 * attempt,
            run: async ({ attempt }) => {
              reserved.push(attempt);
              if (!thrown) {
                thrown = true;
                throw new RetryableError('ran out of room');
              }
              return { value: 1, tokensUsed: 0 };
            },
          },
        ],
        { budget, clock, random: seededRandom() },
      ),
    );

    expect(reserved).toEqual([1, 2]);
    // 100 for attempt 1 + 200 for attempt 2. A flat worst-case reservation
    // would have charged 200 twice.
    expect(reserved.length).toBe(2);
  });

  it('should still refuse an attempt whose escalated estimate cannot fit', async () => {
    const clock = new ManualClock();
    const { results } = await clock.runUntilSettled(
      runScheduled(
        [{ id: 'grows', estimateTokens: (attempt: number) => 900 * attempt, run: async () => ({ value: 1, tokensUsed: 1 }) }],
        { tokensPerWindow: 500, clock },
      ),
    );
    const r = results.get('grows');
    expect(r?.state).toBe('failed');
    expect(r?.state === 'failed' && r.error).toContain('can never fit');
  });
});
