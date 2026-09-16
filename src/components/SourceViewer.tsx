'use client';

import { useEffect, useRef } from 'react';
import type { SourceDoc, SourceSpan } from '@/lib/types';

interface Props {
  doc: SourceDoc;
  span: SourceSpan;
  onClose: () => void;
}

/** Characters of surrounding document shown either side of the highlight. */
const CONTEXT_CHARS = 1400;

/**
 * The source document with the cited span highlighted.
 *
 * This is the payoff for keeping exact offsets through chunking, folding and
 * matching: the highlight is a slice of the original text at the offsets the
 * verifier computed, not a re-search of the quote in the browser. If the offsets
 * were wrong, it would be visibly wrong here.
 */
export function SourceViewer({ doc, span, onClose }: Props) {
  const markRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    dialogRef.current?.focus();
  }, [span]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const from = Math.max(0, span.start - CONTEXT_CHARS);
  const to = Math.min(doc.text.length, span.end + CONTEXT_CHARS);
  const before = doc.text.slice(from, span.start);
  const highlighted = doc.text.slice(span.start, span.end);
  const after = doc.text.slice(span.end, to);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      style={{ background: 'rgb(0 0 0 / 0.45)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Source: ${doc.title}`}
        className="cg-card flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--color-line)' }}>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{doc.title}</h3>
            <p className="text-[11px] tabular-nums" style={{ color: 'var(--color-ink-faint)' }}>
              characters {span.start.toLocaleString()}–{span.end.toLocaleString()}
              {doc.url ? ` · ${new URL(doc.url).hostname}` : ''}
            </p>
          </div>
          <button type="button" className="cg-btn shrink-0" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="overflow-y-auto px-4 py-4">
          <pre className="whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed" style={{ color: 'var(--color-ink-soft)' }}>
            {from > 0 && <span style={{ color: 'var(--color-ink-faint)' }}>…</span>}
            {before}
            <mark
              ref={markRef}
              className="rounded px-0.5"
              style={{ background: 'var(--color-accent-soft)', color: 'var(--color-ink)', fontWeight: 600 }}
            >
              {highlighted}
            </mark>
            {after}
            {to < doc.text.length && <span style={{ color: 'var(--color-ink-faint)' }}>…</span>}
          </pre>
        </div>
      </div>
    </div>
  );
}
