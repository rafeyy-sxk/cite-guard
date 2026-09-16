/**
 * Request schemas.
 *
 * Every API route parses its body through one of these before anything else
 * touches it. The limits are not decoration: they are what stops a single
 * request exceeding the serverless body cap, or queueing more work than the
 * token budget could drain inside the function timeout.
 */

import { z } from 'zod';
import { MAX_DOCS, MAX_DOC_CHARS, MAX_QUESTIONS, MAX_TOTAL_CHARS } from './limits';

export const sourceDocSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  origin: z.enum(['paste', 'file', 'url']),
  text: z.string().max(MAX_DOC_CHARS),
  url: z.string().max(2048).optional(),
});

export const askRequestSchema = z
  .object({
    docs: z.array(sourceDocSchema).min(1).max(MAX_DOCS),
    questions: z.array(z.string().trim().min(3).max(500)).min(1).max(MAX_QUESTIONS),
    concurrency: z.number().int().min(1).max(200).optional(),
    tokensPerWindow: z.number().int().min(500).max(1_000_000).optional(),
    topK: z.number().int().min(1).max(20).optional(),
    entailment: z.boolean().optional(),
  })
  .refine(
    (v) => v.docs.reduce((sum, d) => sum + d.text.length, 0) <= MAX_TOTAL_CHARS,
    { message: `The sources add up to more than ${MAX_TOTAL_CHARS.toLocaleString()} characters. Remove one and try again.` },
  )
  .refine((v) => v.docs.some((d) => d.text.trim().length > 0), {
    message: 'Every source is empty, so there is nothing to answer from.',
  });

export type AskRequestBody = z.infer<typeof askRequestSchema>;

export const fetchUrlSchema = z.object({
  url: z.string().min(1).max(2048),
});

/** Turn a zod failure into one sentence a person can act on. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'That request was not in the expected shape.';
  const path = issue.path.join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}
