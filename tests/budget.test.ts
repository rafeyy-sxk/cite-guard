import { describe, expect, it } from 'vitest';
import { ManualClock } from '../src/lib/clock';
import { RollingTokenBudget } from '../src/lib/budget';

describe('rolling token budget', () => {
  it('should admit spend up to the ceiling and refuse the one that crosses it', () => {
    const clock = new ManualClock();
    const b = new RollingTokenBudget(1000, 60_000, clock);
    expect(b.reserve('a', 600).ok).toBe(true);
    expect(b.reserve('b', 400).ok).toBe(true);
    const third = b.reserve('c', 1);
    expect(third.ok).toBe(false);
    expect(third.ok === false && third.reason).toBe('window_full');
  });

  it('should free capacity as the window slides', async () => {
    const clock = new ManualClock();
    const b = new RollingTokenBudget(1000, 60_000, clock);
    b.reserve('a', 1000);
    expect(b.reserve('b', 1).ok).toBe(false);

    await clock.advance(59_999);
    expect(b.reserve('b', 1).ok).toBe(false);

    await clock.advance(2);
    expect(b.spent()).toBe(0);
    expect(b.reserve('b', 1000).ok).toBe(true);
  });

  it('should report retryAt as the moment the oldest entry expires', () => {
    const clock = new ManualClock(10_000);
    const b = new RollingTokenBudget(100, 60_000, clock);
    b.reserve('a', 100);
    const refused = b.reserve('b', 50);
    expect(refused.ok === false && refused.reason === 'window_full' && refused.retryAt).toBe(70_000);
  });

  it('should refuse a request larger than the whole window as impossible', () => {
    const b = new RollingTokenBudget(1000, 60_000, new ManualClock());
    const r = b.reserve('huge', 1001);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('exceeds_ceiling');
  });

  it('should NOT lower a reservation to the billed figure', () => {
    // Lowering it hands back output allowance the provider counted at admission.
    // A controlled 100-claim A/B measured 0 rate limits raise-only vs 1 lowering.
    const b = new RollingTokenBudget(1000, 60_000, new ManualClock());
    b.reserve('a', 800);
    b.reconcile('a', 120);
    expect(b.spent()).toBe(800);
  });

  it('should raise a reservation when the actual cost exceeded the estimate', async () => {
    const clock = new ManualClock();
    const b = new RollingTokenBudget(2000, 60_000, clock);
    b.reserve('a', 300);
    b.reconcile('a', 950);
    expect(b.spent()).toBe(950);

    // The timestamp must not move, or the entry would linger past its window.
    await clock.advance(60_001);
    expect(b.spent()).toBe(0);
  });

  it('should give a reservation back on release', () => {
    const b = new RollingTokenBudget(1000, 60_000, new ManualClock());
    b.reserve('a', 900);
    b.release('a');
    expect(b.spent()).toBe(0);
    expect(b.reserve('b', 1000).ok).toBe(true);
  });

  it('should ignore reconcile and release for unknown ids', () => {
    const b = new RollingTokenBudget(1000, 60_000, new ManualClock());
    b.reserve('a', 100);
    b.reconcile('ghost', 999);
    b.release('ghost');
    expect(b.spent()).toBe(100);
  });

  it('should expose a snapshot for the UI meter', () => {
    const b = new RollingTokenBudget(1000, 60_000, new ManualClock());
    b.reserve('a', 100);
    b.reserve('b', 200);
    expect(b.snapshot().map((e) => e.tokens)).toEqual([100, 200]);
  });
});

describe('provider window', () => {
  it('should default to the provider window with no extra margin', async () => {
    const { PROVIDER_WINDOW_MS, SCHEDULER_DEFAULTS } = await import('../src/lib/scheduler-types');
    expect(SCHEDULER_DEFAULTS.windowMs).toBe(PROVIDER_WINDOW_MS);
    expect(PROVIDER_WINDOW_MS).toBe(60_000);
  });
});
