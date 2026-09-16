'use client';

import type { BoardTask } from '@/lib/useRun';
import type { Aggregates } from '@/lib/scheduler-types';

interface Props {
  phase: string;
  tasks: BoardTask[];
  aggregates: Aggregates | null;
  running: boolean;
}

const STATE_STYLE: Record<BoardTask['state'], { label: string; bg: string; fg: string }> = {
  queued: { label: 'queued', bg: 'var(--color-surface-2)', fg: 'var(--color-ink-faint)' },
  'waiting-budget': { label: 'waiting on budget', bg: 'var(--color-warn-soft)', fg: 'var(--color-warn)' },
  running: { label: 'running', bg: 'var(--color-accent-soft)', fg: 'var(--color-accent)' },
  retrying: { label: 'retrying', bg: 'var(--color-warn-soft)', fg: 'var(--color-warn)' },
  done: { label: 'verified', bg: 'var(--color-good-soft)', fg: 'var(--color-good)' },
  failed: { label: 'failed', bg: 'var(--color-bad-soft)', fg: 'var(--color-bad)' },
  cancelled: { label: 'cancelled', bg: 'var(--color-surface-2)', fg: 'var(--color-ink-faint)' },
};

const ORDER: BoardTask['state'][] = ['running', 'retrying', 'waiting-budget', 'queued', 'done', 'failed', 'cancelled'];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg px-2.5 py-2" style={{ background: 'var(--color-surface-2)' }}>
      <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--color-ink-faint)' }}>
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
      {hint && (
        <div className="text-[10px] tabular-nums" style={{ color: 'var(--color-ink-faint)' }}>
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * The board while verification runs.
 *
 * It shows the token meter next to the ceiling deliberately: "waiting on budget"
 * is otherwise indistinguishable from "stuck", and the whole point of the
 * scheduler is that waiting there is the correct behaviour rather than a stall.
 */
export function LiveBoard({ phase, tasks, aggregates, running }: Props) {
  if (!running && tasks.length === 0) return null;

  const byState = new Map<BoardTask['state'], number>();
  for (const t of tasks) byState.set(t.state, (byState.get(t.state) ?? 0) + 1);

  const tokenPct = aggregates && aggregates.tokenCeiling > 0
    ? Math.min(100, (aggregates.tokensInWindow / aggregates.tokenCeiling) * 100)
    : 0;

  return (
    <section className="cg-card p-4" aria-live="polite">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Verification</h2>
        <span className="text-[11px]" style={{ color: 'var(--color-ink-soft)' }}>
          {phase}
        </span>
      </header>

      {aggregates && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="In flight" value={String(aggregates.inFlight)} hint={`peak ${aggregates.peakConcurrency}`} />
            <Stat label="Done" value={`${aggregates.done}/${aggregates.total}`} hint={aggregates.failed > 0 ? `${aggregates.failed} failed` : undefined} />
            <Stat label="Waiting" value={String(aggregates.waitingBudget + aggregates.queued)} hint={`${aggregates.retrying} retrying`} />
            <Stat label="Retries" value={String(aggregates.retries)} hint={`${aggregates.rateLimitHits} rate limited`} />
          </div>

          <div className="mt-3">
            <div className="mb-1 flex items-baseline justify-between text-[11px]">
              <span style={{ color: 'var(--color-ink-soft)' }}>Tokens in the last 60 seconds</span>
              <span className="tabular-nums" style={{ color: 'var(--color-ink-faint)' }}>
                {aggregates.tokensInWindow.toLocaleString()} / {aggregates.tokenCeiling.toLocaleString()}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: 'var(--color-surface-2)' }}>
              <div
                className="h-full rounded-full transition-[width] duration-300"
                style={{ width: `${tokenPct}%`, background: tokenPct > 85 ? 'var(--color-warn)' : 'var(--color-accent)' }}
              />
            </div>
          </div>
        </>
      )}

      {tasks.length > 0 && (
        <>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {ORDER.filter((s) => (byState.get(s) ?? 0) > 0).map((s) => (
              <span key={s} className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: STATE_STYLE[s].bg, color: STATE_STYLE[s].fg }}>
                {byState.get(s)} {STATE_STYLE[s].label}
              </span>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap gap-1" role="list" aria-label="Per-claim verification state">
            {tasks.map((task) => (
              <span
                key={task.id}
                role="listitem"
                title={`${task.label}\n${STATE_STYLE[task.state].label}${task.attempts > 1 ? ` · attempt ${task.attempts}` : ''}`}
                className="h-2.5 w-2.5 rounded-[3px]"
                style={{ background: STATE_STYLE[task.state].fg, opacity: task.state === 'queued' ? 0.35 : 1 }}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
