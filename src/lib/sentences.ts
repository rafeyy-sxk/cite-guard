/**
 * Sentence splitting with offsets.
 *
 * Used in two places with different stakes:
 *  - splitting a model's answer into the units that get verified individually;
 *  - finding clean break points when chunking a source document.
 *
 * It is a heuristic, not a parser. The failure mode that matters is splitting
 * mid-sentence on an abbreviation, which would hand the verifier a fragment
 * that no quote can support, so known abbreviations are held back explicitly.
 */

export interface Sentence {
  text: string;
  /** Inclusive start offset into the input string. */
  start: number;
  /** Exclusive end offset into the input string. */
  end: number;
}

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'rev', 'hon',
  'inc', 'ltd', 'co', 'corp', 'dept', 'est', 'fig', 'no', 'vol', 'op',
  'approx', 'etc', 'vs', 'al', 'eg', 'ie', 'cf', 'ca', 'circa',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const TERMINATORS = new Set(['.', '!', '?']);

/** True when the '.' at `index` is part of an abbreviation or a decimal. */
function isFalseTerminator(text: string, index: number): boolean {
  if (text[index] !== '.') return false;

  // Decimal point or a version/section number: 3.14, 1.2.3
  const next = text[index + 1];
  const prev = text[index - 1];
  if (next !== undefined && /\d/.test(next) && prev !== undefined && /\d/.test(prev)) return true;

  // Single-letter initials and dotted acronyms: J. R. R., U.S.A.
  if (prev !== undefined && /[A-Za-z]/.test(prev)) {
    const beforePrev = text[index - 2];
    if (beforePrev === undefined || !/[A-Za-z]/.test(beforePrev)) return true;
  }

  // Known abbreviation immediately before the dot.
  let wordStart = index;
  while (wordStart > 0) {
    const ch = text[wordStart - 1];
    if (ch === undefined || !/[A-Za-z]/.test(ch)) break;
    wordStart -= 1;
  }
  const word = text.slice(wordStart, index).toLowerCase();
  return word.length > 0 && ABBREVIATIONS.has(word);
}

/**
 * Split `input` into sentences, preserving exact offsets.
 *
 * A sentence ends at a terminator that is followed by whitespace (or the end of
 * input), or at a blank line. Trailing closing quotes and brackets stay with the
 * sentence they close.
 */
export function splitSentences(input: string): Sentence[] {
  const out: Sentence[] = [];
  let cursor = 0;

  const push = (start: number, end: number): void => {
    const raw = input.slice(start, end);
    const leading = raw.length - raw.trimStart().length;
    const trailing = raw.length - raw.trimEnd().length;
    const s = start + leading;
    const e = end - trailing;
    if (e > s) out.push({ text: input.slice(s, e), start: s, end: e });
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;

    // A blank line always ends a sentence, terminator or not (headings, lists).
    if (ch === '\n') {
      const rest = input.slice(i);
      const blankLine = /^\n[ \t]*\r?\n/.test(rest);
      if (blankLine) {
        push(cursor, i);
        cursor = i + 1;
        continue;
      }
    }

    if (!TERMINATORS.has(ch)) continue;
    if (isFalseTerminator(input, i)) continue;

    // Absorb runs of terminators ("?!", "...") and any closing punctuation.
    let end = i + 1;
    while (end < input.length && (TERMINATORS.has(input[end]!) || /["'’”)\]]/.test(input[end]!))) {
      end += 1;
    }

    const after = input[end];
    if (after === undefined || /\s/.test(after)) {
      push(cursor, end);
      cursor = end;
      i = end - 1;
    }
  }

  push(cursor, input.length);
  return out;
}
