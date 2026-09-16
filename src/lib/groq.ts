/**
 * Groq transport.
 *
 * Two deliberate constraints:
 *
 * 1. **The endpoint is hardcoded.** `GROQ_BASE_URL` is NOT read, on purpose. A
 *    base-URL environment variable is a redirect primitive: anything that can
 *    set one on the deployment can point a request carrying a live API key at a
 *    host it controls. There is no legitimate need for it here, so the lever
 *    does not exist.
 *
 * 2. **Model ids are discovered, never assumed.** Groq retires models with
 *    little notice - at the time of writing `llama-3.3-70b-versatile`, the id
 *    most tutorials hardcode, is no longer on the account's model list at all.
 *    So the live catalogue is fetched, obviously-unsuitable entries are filtered
 *    out by capability, and a *preference order* is applied over whatever
 *    survives. If every preferred id is gone the app still works on whatever is
 *    live, which is the entire point.
 */

import { RateLimitError, RetryableError } from './scheduler-types';
import type { ChatMessage } from './tokens';

/** Hardcoded. See the note above about GROQ_BASE_URL. */
export const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';

/** Models that are not general-purpose chat models, by id. */
const NON_CHAT = /whisper|orpheus|tts|stt|prompt-guard|safeguard|guard|embed|rerank|moderation/i;

/** Below this a model cannot hold a retrieved-passage prompt. */
const MIN_CONTEXT_WINDOW = 8192;

/**
 * Preference order for the drafting call - the one that reads passages and
 * writes the answer. Intersected with the live catalogue; unknown ids are
 * simply skipped.
 */
const DRAFT_PREFERENCE = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
  'groq/compound',
  'groq/compound-mini',
];

/**
 * Preference order for verification calls. These run up to 100-wide against a
 * per-minute token ceiling, so the smallest capable model wins: the job is a
 * yes/no on one short passage, not composition.
 */
const VERIFY_PREFERENCE = [
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
  'groq/compound-mini',
  'openai/gpt-oss-120b',
];

export interface GroqModel {
  id: string;
  contextWindow: number;
  ownedBy: string;
}

export interface ModelChoice {
  draft: string;
  verify: string;
  /** Every live chat-capable model, for display. */
  available: GroqModel[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class GroqConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GroqConfigError';
  }
}

/** Non-retryable API failure (4xx that is not 429). */
export class GroqRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GroqRequestError';
    this.status = status;
  }
}

function apiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new GroqConfigError(
      'GROQ_API_KEY is not set. Add it to .env.local (see .env.example) and restart.',
    );
  }
  return key.trim();
}

/** Seconds-or-`1.5s` style values from Groq's rate-limit headers, in ms. */
export function parseRetryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after') ?? headers.get('x-ratelimit-reset-tokens');
  if (!raw) return undefined;
  const match = /^\s*([\d.]+)\s*(ms|s|m)?\s*$/.exec(raw);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = match[2] ?? 's';
  if (unit === 'ms') return value;
  if (unit === 'm') return value * 60_000;
  return value * 1000;
}

async function throwForStatus(res: Response): Promise<never> {
  const body = await res.text().catch(() => '');
  const detail = body.slice(0, 400);
  // A reasoning model that ran out of output budget before closing its JSON.
  // This is transient in exactly the way a retry can fix, because the caller
  // escalates the output allowance on each attempt.
  if (res.status === 400 && /json_validate_failed|failed to generate json/i.test(detail)) {
    throw new RetryableError(`Groq could not finish its JSON inside the output budget: ${detail.slice(0, 160)}`);
  }
  if (res.status === 429) {
    throw new RateLimitError(`Groq rate limit: ${detail || 'too many tokens per minute'}`, parseRetryAfterMs(res.headers));
  }
  if (res.status >= 500 || res.status === 408) {
    throw new RetryableError(`Groq ${res.status}: ${detail}`);
  }
  throw new GroqRequestError(res.status, `Groq ${res.status}: ${detail}`);
}

interface RawModel {
  id?: unknown;
  context_window?: unknown;
  owned_by?: unknown;
}

/** Fetch the account's live model catalogue, filtered to usable chat models. */
export async function listChatModels(fetchImpl: FetchLike = fetch): Promise<GroqModel[]> {
  let res: Response;
  try {
    res = await fetchImpl(GROQ_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey()}` },
    });
  } catch (err) {
    throw new RetryableError(`Could not reach Groq: ${(err as Error).message}`);
  }
  if (!res.ok) await throwForStatus(res);

  const payload = (await res.json()) as { data?: RawModel[] };
  const rows = Array.isArray(payload.data) ? payload.data : [];

  return rows
    .map((m) => ({
      id: typeof m.id === 'string' ? m.id : '',
      contextWindow: typeof m.context_window === 'number' ? m.context_window : 0,
      ownedBy: typeof m.owned_by === 'string' ? m.owned_by : 'unknown',
    }))
    .filter((m) => m.id.length > 0 && !NON_CHAT.test(m.id) && m.contextWindow >= MIN_CONTEXT_WINDOW)
    .sort((a, b) => b.contextWindow - a.contextWindow || a.id.localeCompare(b.id));
}

/** First live id from `preference`, else the largest-context live model. */
export function pickModel(available: GroqModel[], preference: string[]): string {
  const live = new Set(available.map((m) => m.id));
  const preferred = preference.find((id) => live.has(id));
  if (preferred) return preferred;
  const fallback = available[0];
  if (!fallback) {
    throw new GroqConfigError(
      'Groq returned no chat-capable models for this key. Check the key has model access.',
    );
  }
  return fallback.id;
}

let cache: { at: number; value: ModelChoice } | null = null;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Resolve which models to use. Cached briefly so a 20-question run does not
 * re-list the catalogue 20 times; the TTL is short enough that a retirement is
 * picked up within minutes.
 */
export async function resolveModels(
  fetchImpl: FetchLike = fetch,
  now: number = Date.now(),
): Promise<ModelChoice> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;

  const available = await listChatModels(fetchImpl);
  const override = process.env.GROQ_MODEL?.trim();
  const draft = override && available.some((m) => m.id === override)
    ? override
    : pickModel(available, DRAFT_PREFERENCE);
  const value: ModelChoice = {
    draft,
    verify: pickModel(available, VERIFY_PREFERENCE),
    available,
  };
  cache = { at: now, value };
  return value;
}

/** Drop the cached catalogue. Used by tests. */
export function resetModelCache(): void {
  cache = null;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxOutputTokens: number;
  /** Ask for a JSON object response. Falls back silently if unsupported. */
  json?: boolean;
  /**
   * Reasoning budget for models that think before answering.
   *
   * This matters more than it looks. Groq's `gpt-oss` models spend
   * `max_completion_tokens` on hidden reasoning BEFORE emitting any JSON, so a
   * tight output cap makes them run out mid-thought and the request fails with
   * `json_validate_failed`. Measured on openai/gpt-oss-20b for a one-line
   * entailment verdict: 149 reasoning tokens at the default, 33 at 'low'.
   * A yes/no judgement does not need deep deliberation, so 'low' is both
   * cheaper and far more reliable here.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  temperature?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

export interface ChatResponse {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface RawCompletion {
  model?: unknown;
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
}

/**
 * One chat completion.
 *
 * Throws `RateLimitError` on 429 (carrying `retry-after`) and `RetryableError`
 * on 5xx or a transport failure, which is exactly the vocabulary the scheduler
 * retries on. Anything else throws `GroqRequestError` and is treated as final.
 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const key = apiKey();

  const send = async (opts: { jsonMode: boolean; reasoning: boolean }): Promise<Response> => {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0,
      max_completion_tokens: req.maxOutputTokens,
    };
    if (opts.jsonMode) body.response_format = { type: 'json_object' };
    if (opts.reasoning && req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
    try {
      return await fetchImpl(GROQ_CHAT_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'AbortError') throw e;
      throw new RetryableError(`Could not reach Groq: ${e.message}`);
    }
  };

  let jsonMode = req.json === true;
  let reasoning = req.reasoningEffort !== undefined;
  let res = await send({ jsonMode, reasoning });

  // Not every live model accepts every optional parameter, and the set of live
  // models changes without notice. Rather than pinning a capability table that
  // will go stale, detect the specific refusal and drop just that parameter.
  // At most two retries, and only on a 400 that names the parameter.
  for (let attempt = 0; attempt < 2 && !res.ok && res.status === 400; attempt += 1) {
    const peek = await res.clone().text().catch(() => '');
    if (reasoning && /reasoning_effort|reasoning/i.test(peek)) {
      reasoning = false;
      res = await send({ jsonMode, reasoning });
      continue;
    }
    if (jsonMode && /response_format|json_object|json mode/i.test(peek)) {
      jsonMode = false;
      res = await send({ jsonMode, reasoning });
      continue;
    }
    break;
  }

  if (!res.ok) await throwForStatus(res);

  const payload = (await res.json()) as RawCompletion;
  const content = payload.choices?.[0]?.message?.content;
  const usage = payload.usage ?? {};
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

  return {
    content: typeof content === 'string' ? content : '',
    model: typeof payload.model === 'string' ? payload.model : req.model,
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    totalTokens: num(usage.total_tokens),
  };
}
