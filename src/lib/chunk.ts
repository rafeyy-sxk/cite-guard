/**
 * Document chunking with exact offsets.
 *
 * Two constraints shape this:
 *  1. Every chunk must be a verbatim slice of the source, and `start`/`end` must
 *     index into the original string. The UI highlights spans in the raw text,
 *     so an offset that drifts by one character is a visible bug.
 *  2. Chunks should break on natural boundaries. A quote split across a chunk
 *     edge cannot be verified against a single chunk, which shows up as a false
 *     "unverified" — the most expensive failure this app can have.
 *
 * Hence: segment on paragraphs, sub-segment long paragraphs on sentences, then
 * greedily pack segments up to a target size with a trailing overlap so text
 * near a boundary appears whole in one of the two neighbouring chunks.
 */

import type { Chunk, SourceDoc } from './types';
import { splitSentences } from './sentences';

export interface ChunkOptions {
  /** Soft ceiling on chunk size in characters. */
  targetChars?: number;
  /** Characters of trailing context repeated at the start of the next chunk. */
  overlapChars?: number;
  /** A trailing chunk shorter than this is merged back into the previous one. */
  minChars?: number;
}

const DEFAULTS = { targetChars: 1100, overlapChars: 200, minChars: 120 } as const;

interface Segment {
  start: number;
  end: number;
}

/** Paragraph segments, sub-split on sentences when longer than `maxLen`. */
function segment(text: string, maxLen: number): Segment[] {
  const segments: Segment[] = [];
  const paragraphRe = /\n[ \t]*\r?\n/g;
  const bounds: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = paragraphRe.exec(text)) !== null) {
    bounds.push({ start: last, end: m.index });
    last = m.index + m[0].length;
  }
  bounds.push({ start: last, end: text.length });

  for (const p of bounds) {
    if (p.end <= p.start) continue;
    if (p.end - p.start <= maxLen) {
      segments.push(p);
      continue;
    }
    const inner = splitSentences(text.slice(p.start, p.end));
    if (inner.length <= 1) {
      // One unbroken run (minified text, a huge table row). Hard-split it so a
      // pathological document cannot produce one enormous chunk.
      for (let i = p.start; i < p.end; i += maxLen) {
        segments.push({ start: i, end: Math.min(p.end, i + maxLen) });
      }
      continue;
    }
    for (const s of inner) segments.push({ start: p.start + s.start, end: p.start + s.end });
  }
  return segments.filter((s) => text.slice(s.start, s.end).trim().length > 0);
}

/** Split one document into overlapping, offset-accurate chunks. */
export function chunkDocument(doc: SourceDoc, options: ChunkOptions = {}): Chunk[] {
  const targetChars = options.targetChars ?? DEFAULTS.targetChars;
  const overlapChars = options.overlapChars ?? DEFAULTS.overlapChars;
  const minChars = options.minChars ?? DEFAULTS.minChars;

  const text = doc.text;
  if (text.trim().length === 0) return [];

  const segments = segment(text, targetChars);
  if (segments.length === 0) return [];

  const ranges: Segment[] = [];
  let current: Segment | null = null;

  for (const seg of segments) {
    if (current === null) {
      current = { start: seg.start, end: seg.end };
      continue;
    }
    if (seg.end - current.start <= targetChars) {
      current.end = seg.end;
      continue;
    }
    ranges.push(current);
    // Back up into the chunk just closed so the boundary text is not orphaned.
    const overlapStart = Math.max(current.start, current.end - overlapChars);
    current = { start: Math.min(overlapStart, seg.start), end: seg.end };
  }
  if (current !== null) ranges.push(current);

  // Fold a runt tail back into its predecessor rather than emitting a chunk too
  // small to retrieve on.
  if (ranges.length > 1) {
    const tail = ranges[ranges.length - 1]!;
    if (tail.end - tail.start < minChars) {
      ranges[ranges.length - 2]!.end = tail.end;
      ranges.pop();
    }
  }

  return ranges.map((r, index) => ({
    id: `${doc.id}#${index}`,
    docId: doc.id,
    docTitle: doc.title,
    text: text.slice(r.start, r.end),
    start: r.start,
    end: r.end,
    index,
  }));
}

/**
 * Chunk a whole corpus and renumber the chunks `c0`, `c1`, ... .
 *
 * The short id is deliberate: it is what the model is asked to cite, and every
 * character of it is prompt budget spent on every request. `docId` still carries
 * provenance, so nothing is lost by shortening the label.
 */
export function chunkCorpus(docs: SourceDoc[], options: ChunkOptions = {}): Chunk[] {
  return docs
    .flatMap((doc) => chunkDocument(doc, options))
    .map((chunk, i) => ({ ...chunk, id: `c${i}` }));
}
