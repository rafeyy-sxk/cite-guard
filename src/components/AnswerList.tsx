'use client';

import type { CheckedSentence, QuestionResult, SourceSpan } from '@/lib/types';

interface Props {
  questions: QuestionResult[];
  onShowSource: (span: SourceSpan) => void;
}

const OUTCOME_NOTE: Record<string, string> = {
  no_relevant_source: 'Not answered — nothing relevant retrieved',
  model_declined: 'Not answered — the model declined',
  draft_failed: 'Not answered — the call did not complete',
};

function Coverage({ verified, total }: { verified: number; total: number }) {
  if (total === 0) return null;
  const complete = verified === total;
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{
        background: complete ? 'var(--color-good-soft)' : 'var(--color-warn-soft)',
        color: complete ? 'var(--color-good)' : 'var(--color-warn)',
      }}
    >
      {verified} of {total} sentence{total === 1 ? '' : 's'} verified
    </span>
  );
}

function Sentence({ sentence, onShowSource }: { sentence: CheckedSentence; onShowSource: (s: SourceSpan) => void }) {
  if (sentence.status === 'verified') {
    return (
      <span>
        {sentence.text}{' '}
        <button
          type="button"
          onClick={() => onShowSource(sentence.span)}
          title={`Source: “${sentence.sourceText.slice(0, 220)}”`}
          className="rounded px-1 align-baseline text-[10px] font-semibold"
          style={{ background: 'var(--color-accent-soft)', color: 'var(--color-accent)' }}
        >
          {sentence.chunkId}
          {sentence.relocated ? '*' : ''}
        </button>{' '}
      </span>
    );
  }

  return (
    <span>
      <span className="cg-struck" style={{ color: 'var(--color-ink-faint)' }}>
        {sentence.text}
      </span>{' '}
      <span
        className="rounded px-1 align-baseline text-[10px] font-semibold"
        style={{ background: 'var(--color-bad-soft)', color: 'var(--color-bad)' }}
        title={sentence.detail}
      >
        unverified
      </span>{' '}
      {sentence.span && sentence.sourceText && (
        <button
          type="button"
          onClick={() => onShowSource(sentence.span!)}
          className="rounded px-1 align-baseline text-[10px] font-semibold"
          style={{ background: 'var(--color-surface-2)', color: 'var(--color-ink-faint)' }}
        >
          see what it quoted
        </button>
      )}{' '}
    </span>
  );
}

/**
 * The answer.
 *
 * A withheld sentence is shown struck through rather than deleted, with the
 * reason attached. Silently dropping it would hide the most useful signal the
 * app produces — that the model tried to assert something the sources do not
 * support.
 */
export function AnswerList({ questions, onShowSource }: Props) {
  return (
    <div className="space-y-3">
      {questions.map((q) => {
        const unverified = q.sentences.filter((s) => s.status === 'unverified');
        return (
          <article key={q.id} className="cg-card p-4">
            <header className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">{q.question}</h3>
              <Coverage verified={q.coverage.verified} total={q.coverage.total} />
            </header>

            {q.outcome !== 'answered' && (
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-warn)' }}>
                {OUTCOME_NOTE[q.outcome] ?? q.outcome}
              </p>
            )}

            {q.notice && (
              <p className="mb-2 rounded-md px-2.5 py-2 text-xs" style={{ background: 'var(--color-surface-2)', color: 'var(--color-ink-soft)' }}>
                {q.notice}
              </p>
            )}

            {q.sentences.length > 0 && (
              <p className="text-[14px] leading-7">
                {q.sentences.map((s, i) => (
                  <Sentence key={`${q.id}-${i}`} sentence={s} onShowSource={onShowSource} />
                ))}
              </p>
            )}

            {unverified.length > 0 && (
              <ul className="mt-3 space-y-1 border-t pt-2" style={{ borderColor: 'var(--color-line)' }}>
                {unverified.map((s, i) => (
                  <li key={`u-${q.id}-${i}`} className="text-[11px]" style={{ color: 'var(--color-ink-soft)' }}>
                    <span style={{ color: 'var(--color-bad)' }}>✕</span> {s.detail}
                  </li>
                ))}
              </ul>
            )}

            {q.retrieved.length > 0 && (
              <p className="mt-2 text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
                Retrieved {q.retrieved.length} passage{q.retrieved.length === 1 ? '' : 's'} · best term coverage{' '}
                {(q.retrieved[0]!.coverage * 100).toFixed(0)}%
              </p>
            )}
          </article>
        );
      })}
    </div>
  );
}
