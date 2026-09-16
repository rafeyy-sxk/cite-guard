/**
 * Token estimation for the budget gate.
 *
 * The scheduler has to decide whether a request fits in the remaining
 * per-minute allowance *before* sending it, and no tokeniser runs client-side
 * for free. So this is a deliberate over-estimate: spending the budget more
 * slowly than necessary costs a little throughput, while under-estimating costs
 * a 429 and a retry. After each response the scheduler reconciles the estimate
 * against `usage.total_tokens`, so the error does not accumulate across a run.
 *
 * Calibration: measured against Groq's reported `usage.prompt_tokens` on live
 * English prose, the 3.6 chars/token divisor over-estimates by roughly 10-20%.
 */

/** Chars per token. Lower than the usual "~4" so we over-estimate, not under. */
const CHARS_PER_TOKEN = 3.6;

/** Per-message framing the chat API adds (role, separators). */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Fixed priming cost of a request. */
const REQUEST_OVERHEAD_TOKENS = 3;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Estimated prompt tokens for a single string. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimated total tokens a chat request will be billed for: the prompt plus
 * the maximum completion we allow. Reserving the full `maxOutputTokens` is the
 * point — the ceiling is on prompt + completion, and we cannot know the
 * completion length in advance, so the budget gate has to assume the worst.
 */
export function estimateRequestTokens(messages: ChatMessage[], maxOutputTokens: number): number {
  const prompt = messages.reduce(
    (sum, m) => sum + estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS,
    REQUEST_OVERHEAD_TOKENS,
  );
  return prompt + Math.max(0, maxOutputTokens);
}
