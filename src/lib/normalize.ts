/**
 * Offset-preserving text normalisation.
 *
 * Quote verification has two jobs that pull in opposite directions:
 *
 *  1. Be forgiving about *presentation* — a model that re-types a quote with
 *     straight quotes instead of curly ones, or collapses a line break into a
 *     space, has not fabricated anything.
 *  2. Be able to point at the exact characters in the ORIGINAL text so the UI
 *     can highlight them.
 *
 * A normaliser that just returns a string satisfies (1) and destroys (2).
 * `normalize()` therefore returns the folded string *plus* a map from each
 * folded character index back to its index in the input, so a match found in
 * folded space can be projected back onto the raw source.
 *
 * Folding rules, applied in order, and all of them lossy on purpose:
 *   - Unicode NFKD, then combining marks dropped  ("café" -> "cafe")
 *   - lowercase
 *   - every character that is not [a-z0-9] becomes a separator
 *   - runs of separators collapse to a single space; leading/trailing trimmed
 *
 * Because punctuation becomes a *separator* rather than being deleted,
 * "cat.Sat" folds to "cat sat" rather than the bogus "catsat".
 */

export interface NormalizedText {
  /** The folded string: lowercase [a-z0-9] and single spaces. */
  text: string;
  /**
   * `map[i]` is the index in the original input of the character that produced
   * `text[i]`. For a space emitted from a run of separators, it is the index of
   * the first character of that run. Length always equals `text.length`.
   */
  map: number[];
}

const KEEP = /[a-z0-9]/;

/** Fold one input string, keeping a folded-index -> original-index map. */
export function normalize(input: string): NormalizedText {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSeparatorAt = -1;

  for (let i = 0; i < input.length; i += 1) {
    // Decompose a single code point so that an index in the decomposed form
    // still corresponds to index `i` of the input.
    const decomposed = input[i]!.normalize('NFKD').toLowerCase();

    for (const ch of decomposed) {
      // Drop combining marks left behind by NFKD (U+0300..U+036F and friends).
      if (/\p{M}/u.test(ch)) continue;

      if (KEEP.test(ch)) {
        if (pendingSeparatorAt !== -1) {
          if (out.length > 0) {
            out.push(' ');
            map.push(pendingSeparatorAt);
          }
          pendingSeparatorAt = -1;
        }
        out.push(ch);
        map.push(i);
      } else if (pendingSeparatorAt === -1) {
        pendingSeparatorAt = i;
      }
    }
  }

  return { text: out.join(''), map };
}

/** Fold a string without building an offset map. Cheaper; same folding rules. */
export function normalizeText(input: string): string {
  return normalize(input).text;
}

/** Number of whitespace-separated tokens in a folded string. */
export function foldedWordCount(folded: string): number {
  if (folded.length === 0) return 0;
  return folded.split(' ').length;
}

/**
 * Project a range in folded space back onto the original string.
 *
 * `foldedEnd` is exclusive. The returned `end` is exclusive and points one past
 * the last original character that contributed to the match, so
 * `original.slice(start, end)` reproduces the matched text with its original
 * casing and punctuation intact.
 */
export function projectRange(
  normalized: NormalizedText,
  foldedStart: number,
  foldedEnd: number,
): { start: number; end: number } | null {
  if (foldedStart < 0 || foldedEnd > normalized.text.length || foldedStart >= foldedEnd) {
    return null;
  }
  const start = normalized.map[foldedStart];
  const lastIndex = normalized.map[foldedEnd - 1];
  if (start === undefined || lastIndex === undefined) return null;
  return { start, end: lastIndex + 1 };
}
