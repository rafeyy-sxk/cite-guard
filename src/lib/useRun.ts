'use client';

/**
 * Client side of the run: POST the sources, read the NDJSON stream, keep the
 * board in sync.
 *
 * The one non-obvious thing here is event batching. A 100-claim run emits
 * several hundred state transitions in a few seconds, and calling `setState`
 * on each one makes React re-render the board hundreds of times for frames the
 * user never sees. Events are therefore accumulated in a ref and flushed once
 * per animation frame, which keeps the board live without the jank.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunEvent } from './pipeline';
import type { Aggregates, TaskState } from './scheduler-types';
import type { RunResult } from './types';

export interface BoardTask {
  id: string;
  label: string;
  state: TaskState;
  attempts: number;
  phase: 'draft' | 'verify';
}

export interface RunState {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  phase: string;
  models: { draft: string; verify: string } | null;
  tasks: BoardTask[];
  aggregates: Aggregates | null;
  result: RunResult | null;
  error: string | null;
}

const IDLE: RunState = {
  status: 'idle',
  phase: '',
  models: null,
  tasks: [],
  aggregates: null,
  result: null,
  error: null,
};

export interface StartPayload {
  docs: unknown[];
  questions: string[];
  concurrency: number;
  tokensPerWindow: number;
  entailment: boolean;
}

export function useRun(): {
  state: RunState;
  start: (payload: StartPayload) => Promise<void>;
  cancel: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<RunState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<RunEvent[]>([]);
  const frameRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const flush = useCallback(() => {
    frameRef.current = null;
    const events = pendingRef.current;
    pendingRef.current = [];
    if (events.length === 0 || !mountedRef.current) return;

    setState((prev) => {
      const tasks = new Map(prev.tasks.map((t) => [t.id, t]));
      let next: RunState = { ...prev };

      for (const event of events) {
        switch (event.type) {
          case 'models':
            next.models = { draft: event.draft, verify: event.verify };
            break;
          case 'phase':
            next.phase = event.detail;
            break;
          case 'claims':
            for (const claim of event.claims) {
              const existing = tasks.get(claim.id);
              tasks.set(claim.id, {
                id: claim.id,
                label: claim.text,
                state: existing?.state ?? 'queued',
                attempts: existing?.attempts ?? 0,
                phase: 'verify',
              });
            }
            break;
          case 'scheduler': {
            next.aggregates = event.event.aggregates;
            if (event.event.type === 'task') {
              const t = event.event.task;
              const existing = tasks.get(t.id);
              tasks.set(t.id, {
                id: t.id,
                label: existing?.label ?? t.id,
                state: t.state,
                attempts: t.attempts,
                phase: event.phase,
              });
            }
            break;
          }
          case 'result':
            next.result = event.result;
            next.status = 'done';
            break;
          case 'error':
            next.error = event.message;
            next.status = 'error';
            break;
        }
      }

      next = { ...next, tasks: [...tasks.values()] };
      return next;
    });
  }, []);

  const push = useCallback(
    (event: RunEvent) => {
      pendingRef.current.push(event);
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flush);
      }
    },
    [flush],
  );

  const reset = useCallback(() => {
    pendingRef.current = [];
    setState(IDLE);
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    setState((prev) => (prev.status === 'running' ? { ...prev, status: 'cancelled', phase: 'Cancelled' } : prev));
  }, []);

  const start = useCallback(
    async (payload: StartPayload) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      pendingRef.current = [];
      setState({ ...IDLE, status: 'running', phase: 'Starting' });

      try {
        const res = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
          setState((prev) => ({ ...prev, status: 'error', error: String(detail.error ?? `HTTP ${res.status}`) }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.trim().length === 0) continue;
            try {
              push(JSON.parse(line) as RunEvent);
            } catch {
              // A truncated line is re-joined on the next chunk; ignore it here.
            }
          }
        }

        flush();
        setState((prev) => (prev.status === 'running' ? { ...prev, status: 'done' } : prev));
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setState((prev) => ({ ...prev, status: 'error', error: (err as Error).message }));
      }
    },
    [flush, push],
  );

  return { state, start, cancel, reset };
}
