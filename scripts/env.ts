/**
 * Minimal .env loader for the live scripts.
 *
 * The app itself relies on the platform (Next.js in dev, Vercel in production)
 * to populate `process.env`. These scripts run under plain tsx, which does not,
 * so they read `.env.local` themselves. The key is never printed, only its
 * presence and prefix.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(file = '.env.local'): void {
  if (process.env.GROQ_API_KEY) return;
  let raw: string;
  try {
    raw = readFileSync(resolve(process.cwd(), file), 'utf8');
  } catch {
    throw new Error(`No GROQ_API_KEY in the environment and no ${file} to read it from.`);
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2]!.replace(/^["']|["']$/g, '');
    if (!process.env[match[1]!]) process.env[match[1]!] = value;
  }
  if (!process.env.GROQ_API_KEY) throw new Error(`${file} does not define GROQ_API_KEY.`);
}

/** Confirm a key is loaded without ever revealing it. */
export function describeKey(): string {
  const key = process.env.GROQ_API_KEY ?? '';
  return `GROQ_API_KEY present: ${key.length > 0} (prefix ${key.slice(0, 4)}, length ${key.length})`;
}
