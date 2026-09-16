import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROQ_CHAT_URL,
  GROQ_MODELS_URL,
  GroqRequestError,
  chat,
  listChatModels,
  parseRetryAfterMs,
  pickModel,
  resetModelCache,
  resolveModels,
} from '../src/lib/groq';
import { RetryableError } from '../src/lib/scheduler-types';
import { completion, jsonResponse } from './helpers';

/** The live catalogue as returned on 2026-09-16, including the non-chat rows. */
const LIVE_CATALOGUE = {
  data: [
    { id: 'whisper-large-v3', context_window: 448, owned_by: 'OpenAI' },
    { id: 'canopylabs/orpheus-v1-english', context_window: 4000, owned_by: 'Canopy Labs' },
    { id: 'meta-llama/llama-prompt-guard-2-86m', context_window: 512, owned_by: 'Meta' },
    { id: 'allam-2-7b', context_window: 4096, owned_by: 'SDAIA' },
    { id: 'openai/gpt-oss-120b', context_window: 131072, owned_by: 'OpenAI' },
    { id: 'openai/gpt-oss-20b', context_window: 131072, owned_by: 'OpenAI' },
    { id: 'openai/gpt-oss-safeguard-20b', context_window: 131072, owned_by: 'OpenAI' },
    { id: 'qwen/qwen3.8-27b', context_window: 131042, owned_by: 'Alibaba Cloud' },
    { id: 'groq/compound', context_window: 131072, owned_by: 'Groq' },
  ],
};

beforeEach(() => {
  vi.stubEnv('GROQ_API_KEY', 'gsk_test_key_not_real');
  resetModelCache();
});

afterEach(() => {
  resetModelCache();
});

describe('groq: endpoint is fixed', () => {
  it('should hardcode the Groq URLs', () => {
    expect(GROQ_CHAT_URL).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(GROQ_MODELS_URL).toBe('https://api.groq.com/openai/v1/models');
  });

  it('should ignore GROQ_BASE_URL entirely', async () => {
    vi.stubEnv('GROQ_BASE_URL', 'https://attacker.example.com/v1');
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => completion('{"ok":true}'));
    await chat({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      maxOutputTokens: 10,
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(GROQ_CHAT_URL);
  });
});

describe('groq: model discovery', () => {
  it('should drop speech, guard and small-context models', async () => {
    const ids = (await listChatModels(async () => jsonResponse(LIVE_CATALOGUE))).map((m) => m.id);
    expect(ids).toContain('openai/gpt-oss-120b');
    expect(ids).toContain('qwen/qwen3.8-27b');
    expect(ids).not.toContain('whisper-large-v3');
    expect(ids).not.toContain('canopylabs/orpheus-v1-english');
    expect(ids).not.toContain('meta-llama/llama-prompt-guard-2-86m');
    expect(ids).not.toContain('openai/gpt-oss-safeguard-20b');
    expect(ids).not.toContain('allam-2-7b');
  });

  it('should pick a live model from the preference list', () => {
    const available = [
      { id: 'groq/compound', contextWindow: 131072, ownedBy: 'Groq' },
      { id: 'openai/gpt-oss-20b', contextWindow: 131072, ownedBy: 'OpenAI' },
    ];
    expect(pickModel(available, ['openai/gpt-oss-20b', 'groq/compound'])).toBe('openai/gpt-oss-20b');
  });

  it('should fall back to a live model when every preferred id has been retired', () => {
    const available = [{ id: 'brand/new-model-2027', contextWindow: 200000, ownedBy: 'X' }];
    // This is the whole point: hardcoding llama-3.3-70b-versatile would 404 today.
    expect(pickModel(available, ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'])).toBe('brand/new-model-2027');
  });

  it('should throw a clear error when no chat model is available', () => {
    expect(() => pickModel([], ['anything'])).toThrow(/no chat-capable models/);
  });

  it('should pick a large model to draft and a small one to verify', async () => {
    const models = await resolveModels(async () => jsonResponse(LIVE_CATALOGUE));
    expect(models.draft).toBe('openai/gpt-oss-120b');
    expect(models.verify).toBe('openai/gpt-oss-20b');
  });

  it('should cache the catalogue and re-fetch after the TTL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(LIVE_CATALOGUE));
    await resolveModels(fetchImpl, 1_000);
    await resolveModels(fetchImpl, 2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await resolveModels(fetchImpl, 1_000 + 6 * 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('should honour a GROQ_MODEL override only when that id is live', async () => {
    vi.stubEnv('GROQ_MODEL', 'qwen/qwen3.8-27b');
    expect((await resolveModels(async () => jsonResponse(LIVE_CATALOGUE))).draft).toBe('qwen/qwen3.8-27b');
    resetModelCache();
    vi.stubEnv('GROQ_MODEL', 'a-model-that-was-retired');
    expect((await resolveModels(async () => jsonResponse(LIVE_CATALOGUE))).draft).toBe('openai/gpt-oss-120b');
  });
});

describe('groq: error mapping', () => {
  it('should map 429 to a RateLimitError carrying retry-after', async () => {
    const fetchImpl = async () =>
      new Response('rate limited', { status: 429, headers: { 'retry-after': '2.5' } });
    await expect(
      chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 5, fetchImpl }),
    ).rejects.toMatchObject({ name: 'RateLimitError', retryAfterMs: 2500 });
  });

  it('should map 5xx to a retryable error', async () => {
    const fetchImpl = async () => new Response('boom', { status: 503 });
    await expect(
      chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 5, fetchImpl }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it('should map an ordinary 4xx to a non-retryable error', async () => {
    const fetchImpl = async () => new Response('bad model', { status: 404 });
    await expect(
      chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 5, fetchImpl }),
    ).rejects.toBeInstanceOf(GroqRequestError);
  });

  it('should map a transport failure to a retryable error', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(
      chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 5, fetchImpl }),
    ).rejects.toBeInstanceOf(RetryableError);
  });

  it('should parse retry-after in seconds, milliseconds and the Groq reset header', () => {
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '3' }))).toBe(3000);
    expect(parseRetryAfterMs(new Headers({ 'retry-after': '250ms' }))).toBe(250);
    expect(parseRetryAfterMs(new Headers({ 'x-ratelimit-reset-tokens': '2.377s' }))).toBe(2377);
    expect(parseRetryAfterMs(new Headers({}))).toBeUndefined();
  });

  it('should throw a config error when the key is missing', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    await expect(listChatModels(async () => jsonResponse({}))).rejects.toThrow(/GROQ_API_KEY/);
  });
});

describe('groq: chat requests', () => {
  it('should report the tokens the API actually billed', async () => {
    const res = await chat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 5,
      fetchImpl: async () => completion('{"a":1}', 167),
    });
    expect(res.totalTokens).toBe(167);
    expect(res.content).toBe('{"a":1}');
  });

  it('should retry once without json mode when a model rejects response_format', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      calls.push(body);
      if (body.includes('response_format')) {
        return new Response('response_format is not supported by this model', { status: 400 });
      }
      return completion('{"ok":true}');
    });

    const res = await chat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 5,
      json: true,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(calls[0]).toContain('response_format');
    expect(calls[1]).not.toContain('response_format');
    expect(res.content).toBe('{"ok":true}');
  });

  it('should not swallow an unrelated 400', async () => {
    const fetchImpl = async () => new Response('model_not_found', { status: 400 });
    await expect(
      chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 5, json: true, fetchImpl }),
    ).rejects.toThrow(/model_not_found/);
  });
});

describe('groq: reasoning models', () => {
  it('should send reasoning_effort when asked', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => completion('{"ok":true}'));
    await chat({
      model: 'openai/gpt-oss-20b',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 160,
      reasoningEffort: 'low',
      fetchImpl,
    });
    expect(String(fetchImpl.mock.calls[0]![1]?.body)).toContain('"reasoning_effort":"low"');
  });

  it('should omit reasoning_effort when not asked', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => completion('{"ok":true}'));
    await chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10, fetchImpl });
    expect(String(fetchImpl.mock.calls[0]![1]?.body)).not.toContain('reasoning_effort');
  });

  it('should drop reasoning_effort when a model rejects it', async () => {
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');
      bodies.push(body);
      if (body.includes('reasoning_effort')) {
        return new Response('reasoning_effort is not supported for this model', { status: 400 });
      }
      return completion('{"ok":true}');
    });

    const res = await chat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
      reasoningEffort: 'low',
      fetchImpl,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toContain('reasoning_effort');
    expect(res.content).toBe('{"ok":true}');
  });

  it('should treat json_validate_failed as retryable, not final', async () => {
    // This exact 400 ended a live run before the output budget was raised: a
    // reasoning model spends max_completion_tokens thinking before it emits JSON.
    const body = JSON.stringify({
      error: { message: 'Failed to generate JSON.', code: 'json_validate_failed' },
    });
    const fetchImpl = async () => new Response(body, { status: 400 });
    await expect(
      chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10, json: true, fetchImpl }),
    ).rejects.toBeInstanceOf(RetryableError);
  });
});
