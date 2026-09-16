'use client';

import { useRef, useState } from 'react';
import { MAX_BODY_BYTES, MAX_DOCS, MAX_DOC_CHARS } from '@/lib/limits';
import type { SourceDoc } from '@/lib/types';

interface Props {
  docs: SourceDoc[];
  onAdd: (doc: SourceDoc) => void;
  onRemove: (id: string) => void;
  disabled: boolean;
}

type Tab = 'paste' | 'file' | 'url';

const ACCEPTED_FILE = '.txt,.md,.markdown,text/plain,text/markdown';

let counter = 0;
const nextId = (): string => `s${Date.now().toString(36)}${(counter += 1)}`;

export function SourcesPanel({ docs, onAdd, onRemove, disabled }: Props) {
  const [tab, setTab] = useState<Tab>('paste');
  const [pasted, setPasted] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const atCapacity = docs.length >= MAX_DOCS;

  const addPasted = (): void => {
    const text = pasted.trim();
    if (text.length === 0) return;
    if (text.length > MAX_DOC_CHARS) {
      setError(`That is ${text.length.toLocaleString()} characters; the limit is ${MAX_DOC_CHARS.toLocaleString()}.`);
      return;
    }
    onAdd({ id: nextId(), title: `Pasted text ${docs.length + 1}`, origin: 'paste', text });
    setPasted('');
    setError(null);
  };

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files).slice(0, MAX_DOCS - docs.length)) {
      if (file.size > MAX_BODY_BYTES) {
        setError(`"${file.name}" is ${(file.size / 1_000_000).toFixed(1)} MB. The limit is ${(MAX_BODY_BYTES / 1_000_000).toFixed(1)} MB.`);
        continue;
      }
      const text = await file.text();
      if (text.trim().length === 0) {
        setError(`"${file.name}" has no text in it.`);
        continue;
      }
      onAdd({ id: nextId(), title: file.name, origin: 'file', text: text.slice(0, MAX_DOC_CHARS) });
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const addUrl = async (): Promise<void> => {
    if (url.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/fetch-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = (await res.json()) as { title?: string; text?: string; url?: string; error?: string };
      if (!res.ok || !data.text) {
        setError(data.error ?? `Could not fetch that page (HTTP ${res.status}).`);
        return;
      }
      onAdd({ id: nextId(), title: data.title ?? url, origin: 'url', text: data.text, url: data.url ?? url });
      setUrl('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="cg-card p-4">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Sources</h2>
        <span className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
          {docs.length}/{MAX_DOCS}
        </span>
      </header>

      <div className="mb-3 flex gap-1" role="tablist">
        {(['paste', 'file', 'url'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            type="button"
            onClick={() => setTab(t)}
            className="rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize"
            style={{
              background: tab === t ? 'var(--color-accent-soft)' : 'transparent',
              color: tab === t ? 'var(--color-accent)' : 'var(--color-ink-faint)',
            }}
          >
            {t === 'file' ? 'upload' : t}
          </button>
        ))}
      </div>

      {tab === 'paste' && (
        <div className="space-y-2">
          <textarea
            className="cg-input font-mono text-xs"
            rows={6}
            placeholder="Paste the text you want to ask questions about."
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            disabled={disabled || atCapacity}
          />
          <button type="button" className="cg-btn w-full" onClick={addPasted} disabled={disabled || atCapacity || pasted.trim().length === 0}>
            Add pasted text
          </button>
        </div>
      )}

      {tab === 'file' && (
        <div className="space-y-2">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_FILE}
            multiple
            className="cg-input text-xs"
            onChange={(e) => void addFiles(e.target.files)}
            disabled={disabled || atCapacity}
          />
          <p className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
            .txt and .md only, up to {(MAX_BODY_BYTES / 1_000_000).toFixed(1)} MB each. Files are read in your browser and sent with the question; nothing is written to disk on the server.
          </p>
        </div>
      )}

      {tab === 'url' && (
        <div className="space-y-2">
          <input
            className="cg-input"
            placeholder="https://en.wikipedia.org/wiki/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addUrl();
            }}
            disabled={disabled || busy || atCapacity}
          />
          <button type="button" className="cg-btn w-full" onClick={() => void addUrl()} disabled={disabled || busy || atCapacity || url.trim().length === 0}>
            {busy ? 'Fetching…' : 'Fetch page'}
          </button>
          <p className="text-[11px]" style={{ color: 'var(--color-ink-faint)' }}>
            Public http and https pages only. Private addresses and redirects into them are refused.
          </p>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-md px-2 py-1.5 text-[11px]" style={{ background: 'var(--color-bad-soft)', color: 'var(--color-bad)' }}>
          {error}
        </p>
      )}

      {docs.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {docs.map((doc) => (
            <li key={doc.id} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-xs" style={{ background: 'var(--color-surface-2)' }}>
              <span className="min-w-0 flex-1 truncate" title={doc.title}>
                {doc.title}
              </span>
              <span className="shrink-0 tabular-nums" style={{ color: 'var(--color-ink-faint)' }}>
                {(doc.text.length / 1000).toFixed(1)}k
              </span>
              <button type="button" onClick={() => onRemove(doc.id)} disabled={disabled} className="shrink-0 px-1 text-sm leading-none" style={{ color: 'var(--color-ink-faint)' }} aria-label={`Remove ${doc.title}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
