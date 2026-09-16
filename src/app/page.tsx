'use client';

import { useMemo, useState } from 'react';
import { AnswerList } from '@/components/AnswerList';
import { Ledger } from '@/components/Ledger';
import { LiveBoard } from '@/components/LiveBoard';
import { SourceViewer } from '@/components/SourceViewer';
import { SourcesPanel } from '@/components/SourcesPanel';
import { ThemeToggle } from '@/components/ThemeToggle';
import { MAX_QUESTIONS } from '@/lib/limits';
import type { SourceDoc, SourceSpan } from '@/lib/types';
import { useRun } from '@/lib/useRun';

const DEFAULT_CONCURRENCY = 100;
const DEFAULT_TOKENS_PER_WINDOW = 8000;

export default function Page() {
  const [docs, setDocs] = useState<SourceDoc[]>([]);
  const [questionText, setQuestionText] = useState('');
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [tokensPerWindow, setTokensPerWindow] = useState(DEFAULT_TOKENS_PER_WINDOW);
  const [entailment, setEntailment] = useState(true);
  const [viewing, setViewing] = useState<SourceSpan | null>(null);

  const { state, start, cancel, reset } = useRun();

  const questions = useMemo(
    () =>
      questionText
        .split('\n')
        .map((q) => q.trim())
        .filter((q) => q.length >= 3)
        .slice(0, MAX_QUESTIONS),
    [questionText],
  );

  const running = state.status === 'running';
  const canRun = docs.length > 0 && questions.length > 0 && !running;

  const viewingDoc = viewing ? docs.find((d) => d.id === viewing.docId) ?? null : null;

  const run = (): void => {
    void start({
      docs: docs.map((d) => ({ id: d.id, title: d.title, origin: d.origin, text: d.text, ...(d.url ? { url: d.url } : {}) })),
      questions,
      concurrency,
      tokensPerWindow,
      entailment,
    });
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">cite-guard</h1>
          <p className="mt-1 max-w-xl text-sm" style={{ color: 'var(--color-ink-soft)' }}>
            Ask questions about your own documents. Every sentence of the answer has to be traceable to a
            verbatim span in a source. Anything that is not gets struck through instead of published.
          </p>
        </div>
        <ThemeToggle />
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <div className="space-y-4">
          <SourcesPanel
            docs={docs}
            onAdd={(doc) => setDocs((prev) => [...prev, doc])}
            onRemove={(id) => setDocs((prev) => prev.filter((d) => d.id !== id))}
            disabled={running}
          />

          <section className="cg-card p-4">
            <header className="mb-2 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">Questions</h2>
              <span className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
                {questions.length}/{MAX_QUESTIONS}
              </span>
            </header>
            <textarea
              className="cg-input text-xs"
              rows={5}
              placeholder={'One question per line.\nWhat did the experiment measure?\nWhen was it performed?'}
              value={questionText}
              onChange={(e) => setQuestionText(e.target.value)}
              disabled={running}
            />

            <details className="mt-3">
              <summary className="cursor-pointer text-[11px] font-semibold" style={{ color: 'var(--color-ink-soft)' }}>
                Scheduler settings
              </summary>
              <div className="mt-2 space-y-2.5">
                <label className="block">
                  <span className="text-[11px]" style={{ color: 'var(--color-ink-soft)' }}>
                    Max claims in flight: <strong className="tabular-nums">{concurrency}</strong>
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={concurrency}
                    onChange={(e) => setConcurrency(Number(e.target.value))}
                    className="mt-1 w-full"
                    disabled={running}
                  />
                </label>
                <label className="block">
                  <span className="text-[11px]" style={{ color: 'var(--color-ink-soft)' }}>
                    Tokens per minute: <strong className="tabular-nums">{tokensPerWindow.toLocaleString()}</strong>
                  </span>
                  <input
                    type="range"
                    min={1000}
                    max={30000}
                    step={500}
                    value={tokensPerWindow}
                    onChange={(e) => setTokensPerWindow(Number(e.target.value))}
                    className="mt-1 w-full"
                    disabled={running}
                  />
                  <span className="text-[10px]" style={{ color: 'var(--color-ink-faint)' }}>
                    Groq&rsquo;s free tier reports 8,000. Lowering this makes the budget gate visible.
                  </span>
                </label>
                <label className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--color-ink-soft)' }}>
                  <input type="checkbox" checked={entailment} onChange={(e) => setEntailment(e.target.checked)} disabled={running} />
                  Second pass: check each quote actually supports its sentence
                </label>
              </div>
            </details>

            <div className="mt-3 flex gap-2">
              <button type="button" className="cg-btn cg-btn-primary flex-1" onClick={run} disabled={!canRun}>
                {running ? 'Running…' : 'Ask'}
              </button>
              {running ? (
                <button type="button" className="cg-btn" onClick={cancel}>
                  Cancel
                </button>
              ) : (
                state.result && (
                  <button type="button" className="cg-btn" onClick={reset}>
                    Clear
                  </button>
                )
              )}
            </div>

            {state.models && (
              <p className="mt-2 text-[10px] tabular-nums" style={{ color: 'var(--color-ink-faint)' }}>
                drafting: {state.models.draft} · checking: {state.models.verify}
              </p>
            )}
          </section>
        </div>

        <div className="space-y-4">
          {state.error && (
            <div className="cg-card p-4" style={{ borderColor: 'var(--color-bad)' }}>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--color-bad)' }}>
                That run did not complete
              </h2>
              <p className="mt-1 text-xs" style={{ color: 'var(--color-ink-soft)' }}>
                {state.error}
              </p>
            </div>
          )}

          <LiveBoard phase={state.phase} tasks={state.tasks} aggregates={state.aggregates} running={running} />

          {state.result && (
            <>
              <AnswerList questions={state.result.questions} onShowSource={setViewing} />
              <Ledger ledger={state.result.ledger} />
            </>
          )}

          {!state.result && !running && !state.error && (
            <section className="cg-card p-8 text-center">
              <h2 className="text-sm font-semibold">Nothing to show yet</h2>
              <p className="mx-auto mt-1 max-w-md text-xs" style={{ color: 'var(--color-ink-soft)' }}>
                Add a source on the left, write one question per line, then press Ask. Answers arrive with
                every sentence either cited to an exact span or struck through with the reason.
              </p>
            </section>
          )}
        </div>
      </div>

      {viewing && viewingDoc && <SourceViewer doc={viewingDoc} span={viewing} onClose={() => setViewing(null)} />}
    </main>
  );
}
