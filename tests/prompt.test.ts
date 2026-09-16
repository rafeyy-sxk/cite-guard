import { describe, expect, it } from 'vitest';
import {
  buildDraftMessages,
  buildEntailmentMessages,
  extractJsonObject,
  parseDraftResponse,
  outputBudgetForAttempt,
  parseEntailmentResponse,
} from '../src/lib/prompt';
import type { ScoredChunk } from '../src/lib/types';

const retrieved: ScoredChunk[] = [
  {
    chunk: { id: 'c0', docId: 'd', docTitle: 'Doc A', text: 'Alpha beta gamma.', start: 0, end: 17, index: 0 },
    score: 3,
    coverage: 1,
  },
];

describe('prompt building', () => {
  it('should label passages with the ids the model must cite', () => {
    const messages = buildDraftMessages('What is alpha?', retrieved);
    expect(messages[1]!.content).toContain('[c0]');
    expect(messages[1]!.content).toContain('Doc A');
    expect(messages[1]!.content).toContain('What is alpha?');
  });

  it('should tell the model an honest refusal is acceptable', () => {
    expect(buildDraftMessages('q', retrieved)[0]!.content).toContain('"sufficient": false');
  });

  it('should show the entailment judge only the passage and the statement', () => {
    const messages = buildEntailmentMessages('The sky is blue.', 'The sky appears blue.');
    const user = messages[1]!.content;
    expect(user).toContain('The sky is blue.');
    expect(user).toContain('The sky appears blue.');
    // It must not see the question or the rest of the answer.
    expect(user).not.toContain('QUESTION');
  });
});

describe('json extraction', () => {
  it('should parse a bare JSON object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('should parse JSON wrapped in a code fence', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('should parse JSON preceded by prose', () => {
    expect(extractJsonObject('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('should handle braces inside strings', () => {
    expect(extractJsonObject('{"a":"a } brace","b":2}')).toEqual({ a: 'a } brace', b: 2 });
  });

  it('should handle escaped quotes inside strings', () => {
    expect(extractJsonObject('{"a":"he said \\"hi\\"","b":1}')).toEqual({ a: 'he said "hi"', b: 1 });
  });

  it('should return null for unparseable input', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('{"a":')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
  });
});

describe('draft response parsing', () => {
  it('should read text, passage and quote', () => {
    const r = parseDraftResponse('{"sufficient":true,"sentences":[{"text":"A fact.","passage":"c0","quote":"alpha beta gamma"}]}');
    expect(r.sufficient).toBe(true);
    expect(r.claims).toEqual([{ text: 'A fact.', chunkId: 'c0', quote: 'alpha beta gamma' }]);
  });

  it('should accept alternative field names models actually emit', () => {
    const r = parseDraftResponse('{"sentences":[{"sentence":"A fact.","chunk_id":"c1","evidence":"some words"}]}');
    expect(r.claims[0]).toEqual({ text: 'A fact.', chunkId: 'c1', quote: 'some words' });
  });

  it('should carry a missing quote through as null rather than dropping the sentence', () => {
    const r = parseDraftResponse('{"sentences":[{"text":"Uncited claim."}]}');
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]?.quote).toBeNull();
    expect(r.claims[0]?.chunkId).toBeNull();
  });

  it('should split a multi-sentence entry into separate claims', () => {
    const r = parseDraftResponse('{"sentences":[{"text":"First fact. Second fact.","passage":"c0","quote":"q"}]}');
    expect(r.claims.map((c) => c.text)).toEqual(['First fact.', 'Second fact.']);
    expect(r.claims.every((c) => c.chunkId === 'c0')).toBe(true);
  });

  it('should report insufficient when the model declines', () => {
    const r = parseDraftResponse('{"sufficient":false,"sentences":[]}');
    expect(r.sufficient).toBe(false);
    expect(r.claims).toEqual([]);
  });

  it('should treat unparseable output as insufficient, never as an answer', () => {
    expect(parseDraftResponse('the model rambled').claims).toEqual([]);
    expect(parseDraftResponse('the model rambled').sufficient).toBe(false);
  });

  it('should skip malformed rows without discarding good ones', () => {
    const r = parseDraftResponse('{"sentences":[null,{"text":""},{"text":"Good.","passage":"c0","quote":"q words here"},42]}');
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]?.text).toBe('Good.');
  });
});

describe('entailment response parsing', () => {
  it('should read a supported verdict', () => {
    expect(parseEntailmentResponse('{"supported":true,"reason":"passage states it"}')).toEqual({
      supported: true,
      reason: 'passage states it',
    });
  });

  it('should read an unsupported verdict', () => {
    expect(parseEntailmentResponse('{"supported":false,"reason":"adds a number"}').supported).toBe(false);
  });

  it('should fail closed on unreadable output', () => {
    expect(parseEntailmentResponse('maybe?').supported).toBe(false);
    expect(parseEntailmentResponse('').supported).toBe(false);
    expect(parseEntailmentResponse('{"supported":"yes"}').supported).toBe(false);
  });
});

describe('output budget escalation', () => {
  it('should use the base allowance on the first attempt', () => {
    expect(outputBudgetForAttempt(160, 1)).toBe(160);
  });

  it('should raise the allowance on a retry', () => {
    expect(outputBudgetForAttempt(160, 2)).toBe(320);
    expect(outputBudgetForAttempt(160, 3)).toBe(320);
  });
});
