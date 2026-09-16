'use client';

import type { RunLedgerSummary } from '@/lib/types';

const REASON_LABEL: Record<string, string> = {
  no_citation: 'no quote offered',
  missing_source: 'cited a passage that does not exist',
  quote_too_short: 'quote too short to prove anything',
  quote_not_found: 'quote not found in any source',
  not_entailed: 'quote real but does not support the claim',
  check_failed: 'independent check could not complete',
};

function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs" style={{ color: 'var(--color-ink-soft)' }}>
        {label}
      </span>
      <span
        className="text-xs font-semibold tabular-nums"
        style={{ color: tone === 'good' ? 'var(--color-good)' : tone === 'bad' ? 'var(--color-bad)' : 'var(--color-ink)' }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The run ledger.
 *
 * Every number here is counted by the scheduler during the run, not estimated
 * afterwards. `tokensActual` is the sum of `usage.total_tokens` the API reported
 * back, which is why it differs from the estimate the budget gate reserved.
 */
export function Ledger({ ledger }: { ledger: RunLedgerSummary }) {
  const reasons = Object.entries(ledger.mechanical.byReason).filter(([, n]) => (n ?? 0) > 0);

  return (
    <section className="cg-card p-4">
      <h2 className="mb-2 text-sm font-semibold">Run ledger</h2>
      <div className="grid gap-x-8 sm:grid-cols-2">
        <div>
          <Row label="Questions asked" value={String(ledger.questions)} />
          <Row label="Model calls made" value={String(ledger.modelCalls)} />
          <Row label="Claims checked mechanically" value={String(ledger.mechanical.checked)} />
          <Row label="Claims sent for independent check" value={String(ledger.claimsDispatched)} />
          <Row label="Sentences verified" value={String(ledger.verified)} tone={ledger.verified > 0 ? 'good' : undefined} />
          <Row label="Sentences withheld" value={String(ledger.unverified)} tone={ledger.unverified > 0 ? 'bad' : undefined} />
        </div>
        <div>
          <Row label="Checks that failed outright" value={String(ledger.failed)} tone={ledger.failed > 0 ? 'bad' : undefined} />
          <Row label="Retries absorbed" value={String(ledger.retriesAbsorbed)} />
          <Row label="Rate limits absorbed" value={String(ledger.rateLimitHits)} />
          <Row label="Times work waited for budget" value={String(ledger.budgetWaits)} />
          <Row label="Peak concurrency" value={String(ledger.peakConcurrency)} />
          <Row label="Wall clock" value={`${(ledger.wallClockMs / 1000).toFixed(1)}s`} />
          <Row label="Tokens billed / reserved" value={`${ledger.tokensActual.toLocaleString()} / ${ledger.tokensEstimated.toLocaleString()}`} />
        </div>
      </div>

      {reasons.length > 0 && (
        <div className="mt-3 border-t pt-2" style={{ borderColor: 'var(--color-line)' }}>
          <p className="mb-1 text-[11px] font-semibold" style={{ color: 'var(--color-ink-soft)' }}>
            Why sentences were withheld
          </p>
          <ul className="space-y-0.5">
            {reasons.map(([reason, n]) => (
              <li key={reason} className="flex items-baseline justify-between gap-3 text-[11px]">
                <span style={{ color: 'var(--color-ink-soft)' }}>{REASON_LABEL[reason] ?? reason}</span>
                <span className="font-semibold tabular-nums">{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
