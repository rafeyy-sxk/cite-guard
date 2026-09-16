import { describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../src/lib/clock';
import { runAsk, type RunEvent } from '../src/lib/pipeline';
import { RateLimitError } from '../src/lib/scheduler-types';
import type { SourceDoc } from '../src/lib/types';

const DOC_TEXT = [
  'The Cavendish experiment was performed in 1797 and 1798 by the British scientist Henry Cavendish.',
  '',
  'He was the first to measure the force of gravity between masses in a laboratory, and the first to',
  'produce an accurate value for the gravitational constant.',
  '',
  'The apparatus used a torsion balance suspended from a wire, with two lead spheres attached to the',
  'ends of a horizontal beam. Cavendish reported the density of the Earth as 5.448 times that of water.',
].join('\n');

const DOCS: SourceDoc[] = [{ id: 'd1', title: 'Cavendish experiment', origin: 'paste', text: DOC_TEXT }];

const REAL_QUOTE = 'the first to measure the force of gravity between masses in a laboratory';
const OTHER_REAL_QUOTE = 'a torsion balance suspended from a wire';

const models = { draft: 'draft-model', verify: 'verify-model', available: [] };

interface ChatArgs {
  model: string;
  messages: Array<{ role: string; content: string }>;
}

/** Build a chat double that answers drafting and entailment calls differently. */
function chatDouble(opts: {
  draft: (question: string) => string;
  entail?: (statement: string) => string;
  tokens?: number;
}) {
  return vi.fn(async (req: ChatArgs) => {
    const user = req.messages[1]?.content ?? '';
    const isDraft = user.includes('QUESTION:');
    const content = isDraft
      ? opts.draft(user.split('QUESTION:')[1]?.trim() ?? '')
      : (opts.entail ?? (() => '{"supported":true,"reason":"passage states it"}'))(user);
    return {
      content,
      model: req.model,
      promptTokens: 80,
      completionTokens: 20,
      totalTokens: opts.tokens ?? 100,
    };
  });
}

function collect(): { emit: (e: RunEvent) => void; events: RunEvent[] } {
  const events: RunEvent[] = [];
  return { emit: (e) => events.push(e), events };
}

describe('pipeline: a normal answered question', () => {
  it('should publish sentences whose quotes are found in the source', async () => {
    const clock = new ManualClock();
    const { emit, events } = collect();
    const chat = chatDouble({
      draft: () =>
        JSON.stringify({
          sufficient: true,
          sentences: [{ text: 'Cavendish first measured gravity between masses in a lab.', passage: 'c0', quote: REAL_QUOTE }],
        }),
    });

    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions: ['What did Cavendish measure?'] },
        emit,
        { chat: chat as never, resolveModels: (async () => models) as never, clock },
      ),
    );

    expect(result.questions[0]?.outcome).toBe('answered');
    expect(result.questions[0]?.coverage).toEqual({ verified: 1, total: 1, ratio: 1 });
    expect(result.questions[0]?.sentences[0]?.status).toBe('verified');
    expect(result.ledger.verified).toBe(1);
    expect(result.ledger.unverified).toBe(0);
    expect(events.some((e) => e.type === 'result')).toBe(true);
    expect(events.some((e) => e.type === 'models')).toBe(true);
  });

  it('should attach the entailment verdict to a verified sentence', async () => {
    const clock = new ManualClock();
    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions: ['What did Cavendish measure?'] },
        () => undefined,
        {
          chat: chatDouble({
            draft: () =>
              JSON.stringify({ sufficient: true, sentences: [{ text: 'He measured gravity.', passage: 'c0', quote: REAL_QUOTE }] }),
            entail: () => '{"supported":true,"reason":"stated directly"}',
          }) as never,
          resolveModels: (async () => models) as never,
          clock,
        },
      ),
    );

    const sentence = result.questions[0]!.sentences[0]!;
    expect(sentence.status).toBe('verified');
    expect(sentence.status === 'verified' && sentence.entailment?.supported).toBe(true);
    expect(sentence.status === 'verified' && sentence.entailment?.reason).toBe('stated directly');
  });
});

describe('pipeline: the honest empty state', () => {
  it('should refuse to answer when nothing retrieves above the floor', async () => {
    const clock = new ManualClock();
    const chat = chatDouble({ draft: () => '{"sufficient":true,"sentences":[]}' });

    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions: ['What is the best recipe for sourdough bread?'] },
        () => undefined,
        { chat: chat as never, resolveModels: (async () => models) as never, clock },
      ),
    );

    expect(result.questions[0]?.outcome).toBe('no_relevant_source');
    expect(result.questions[0]?.sentences).toEqual([]);
    expect(result.questions[0]?.notice).toContain('Nothing in these sources');
    // The decisive part: no model call was made at all for that question.
    expect(chat).not.toHaveBeenCalled();
    expect(result.ledger.modelCalls).toBe(0);
  });

  it('should report model_declined when the model says the passages do not answer it', async () => {
    const clock = new ManualClock();
    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions: ['What was the gravitational constant value Cavendish published?'] },
        () => undefined,
        {
          chat: chatDouble({ draft: () => '{"sufficient":false,"sentences":[]}' }) as never,
          resolveModels: (async () => models) as never,
          clock,
        },
      ),
    );

    expect(result.questions[0]?.outcome).toBe('model_declined');
    expect(result.questions[0]?.notice).toContain('do not answer');
  });
});

describe('pipeline: unsupported sentences are struck through, never published', () => {
  it('should strike through a sentence whose quote is fabricated', async () => {
    const clock = new ManualClock();
    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions: ['What did Cavendish measure?'] },
        () => undefined,
        {
          chat: chatDouble({
            draft: () =>
              JSON.stringify({
                sufficient: true,
                sentences: [
                  { text: 'He measured gravity between masses.', passage: 'c0', quote: REAL_QUOTE },
                  { text: 'He also invented the electric telegraph in 1802.', passage: 'c0', quote: 'Cavendish invented the electric telegraph in 1802' },
                ],
              }),
          }) as never,
          resolveModels: (async () => models) as never,
          clock,
        },
      ),
    );

    const sentences = result.questions[0]!.sentences;
    expect(sentences).toHaveLength(2);
    expect(sentences[0]?.status).toBe('verified');
    expect(sentences[1]?.status).toBe('unverified');
    expect(sentences[1]?.status === 'unverified' && sentences[1].reason).toBe('quote_not_found');
    expect(result.questions[0]?.coverage).toEqual({ verified: 1, total: 2, ratio: 0.5 });
    expect(result.ledger.mechanical.rejected).toBe(1);
    expect(result.ledger.mechanical.byReason.quote_not_found).toBe(1);
  });

  it('should strike through a real quote that does not support the claim', async () => {
    const clock = new ManualClock();
    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions: ['What did Cavendish measure?'] },
        () => undefined,
        {
          chat: chatDouble({
            draft: () =>
              JSON.stringify({
                sufficient: true,
                sentences: [{ text: 'Cavendish won the Nobel Prize for this work.', passage: 'c0', quote: REAL_QUOTE }],
              }),
            entail: () => '{"supported":false,"reason":"passage never mentions a prize"}',
          }) as never,
          resolveModels: (async () => models) as never,
          clock,
        },
      ),
    );

    const s = result.questions[0]!.sentences[0]!;
    expect(s.status).toBe('unverified');
    expect(s.status === 'unverified' && s.reason).toBe('not_entailed');
    expect(s.status === 'unverified' && s.detail).toContain('never mentions a prize');
    // The located passage is still carried so the reader can judge for themselves.
    expect(s.status === 'unverified' && s.sourceText).toContain('force of gravity');
    expect(result.ledger.verified).toBe(0);
  });

  it('should fail closed when the independent check cannot complete', async () => {
    const clock = new ManualClock();
    const chat = vi.fn(async (req: ChatArgs) => {
      const user = req.messages[1]?.content ?? '';
      if (user.includes('QUESTION:')) {
        return {
          content: JSON.stringify({ sufficient: true, sentences: [{ text: 'He measured gravity.', passage: 'c0', quote: REAL_QUOTE }] }),
          model: req.model,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 100,
        };
      }
      throw new RateLimitError('429 forever', 500);
    });

    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions: ['What did Cavendish measure?'] },
        () => undefined,
        { chat: chat as never, resolveModels: (async () => models) as never, clock, random: () => 0.5 },
      ),
    );

    const s = result.questions[0]!.sentences[0]!;
    expect(s.status).toBe('unverified');
    expect(s.status === 'unverified' && s.reason).toBe('check_failed');
    expect(result.ledger.failed).toBe(1);
    expect(result.ledger.rateLimitHits).toBeGreaterThan(0);
    // Control: the same claim verifies when the check does complete.
    expect(result.ledger.mechanical.passed).toBe(1);
  });

  it('should say so plainly when no sentence at all could be traced', async () => {
    const clock = new ManualClock();
    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions: ['What did Cavendish measure?'] },
        () => undefined,
        {
          chat: chatDouble({
            draft: () =>
              JSON.stringify({
                sufficient: true,
                sentences: [{ text: 'Invented claim.', passage: 'c0', quote: 'a quote that is nowhere in this document at all' }],
              }),
          }) as never,
          resolveModels: (async () => models) as never,
          clock,
        },
      ),
    );

    expect(result.questions[0]?.coverage.verified).toBe(0);
    expect(result.questions[0]?.notice).toContain('Not one sentence');
  });
});

describe('pipeline: verification at scale', () => {
  it('should verify 100 claims across 20 questions under a low token ceiling', async () => {
    const clock = new ManualClock();
    // Every question retrieves, and each draft returns five cited sentences.
    const questions = Array.from({ length: 20 }, (_, i) => `What gravity measurement apparatus did Cavendish use, part ${i}?`);
    const chat = chatDouble({
      draft: () =>
        JSON.stringify({
          sufficient: true,
          sentences: Array.from({ length: 5 }, (_, j) => ({
            text: `Supported statement number ${j}.`,
            passage: 'c0',
            quote: j % 2 === 0 ? REAL_QUOTE : OTHER_REAL_QUOTE,
          })),
        }),
      tokens: 120,
    });

    let maxWindow = 0;
    const emit = (e: RunEvent): void => {
      if (e.type === 'scheduler') maxWindow = Math.max(maxWindow, e.event.aggregates.tokensInWindow);
    };

    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions, concurrency: 100, tokensPerWindow: 8000 },
        emit,
        { chat: chat as never, resolveModels: (async () => models) as never, clock, random: () => 0.5 },
      ),
      250,
      8000,
    );

    expect(result.ledger.claimsDispatched).toBe(100);
    expect(result.ledger.verified).toBe(100);
    expect(result.ledger.unverified).toBe(0);
    expect(result.ledger.failed).toBe(0);
    expect(result.ledger.mechanical.checked).toBe(100);
    // 20 drafting calls + 100 verification calls, none dropped.
    expect(result.ledger.modelCalls).toBe(120);
    expect(maxWindow).toBeLessThanOrEqual(8000);
    expect(maxWindow).toBeGreaterThan(0);
    expect(result.ledger.peakConcurrency).toBeGreaterThan(1);
  });

  it('should skip phase 2 entirely when entailment is switched off', async () => {
    const clock = new ManualClock();
    const chat = chatDouble({
      draft: () => JSON.stringify({ sufficient: true, sentences: [{ text: 'He measured gravity.', passage: 'c0', quote: REAL_QUOTE }] }),
    });

    const result = await clock.runUntilSettled(
      runAsk(
        { docs: DOCS, questions: ['What did Cavendish measure?'], entailment: false },
        () => undefined,
        { chat: chat as never, resolveModels: (async () => models) as never, clock },
      ),
    );

    expect(result.entailmentEnabled).toBe(false);
    expect(result.ledger.claimsDispatched).toBe(0);
    expect(result.ledger.modelCalls).toBe(1);
    expect(result.questions[0]?.sentences[0]?.status).toBe('verified');
  });
});
