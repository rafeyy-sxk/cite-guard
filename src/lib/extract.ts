/**
 * HTML to readable text.
 *
 * Deliberately not a DOM parse: a serverless function should not pull a parser
 * in to strip tags, and the output only has to be good enough to chunk, search
 * and quote. What it must get right is *not* leaking navigation and script
 * content into the corpus, because that becomes text a model can legitimately
 * quote to support nonsense.
 */

const DROP_BLOCKS = /<(script|style|noscript|template|svg|head|nav|footer|form|aside|figcaption)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Landmarks that wrap the actual article, in priority order.
 *
 * This matters more than it sounds. Without it, a Wikipedia page contributes
 * "Jump to content", "Donate", "Create account", "Log in" and the whole sidebar
 * to the corpus - and because those ARE verbatim strings in the source, a model
 * can legitimately quote them to "support" a claim. The mechanical check would
 * pass, correctly, on text that means nothing. Cutting the chrome at ingest is
 * the honest place to fix that.
 */
const MAIN_REGIONS: RegExp[] = [
  /<main\b[^>]*>([\s\S]*)<\/main>/i,
  /<article\b[^>]*>([\s\S]*)<\/article>/i,
  /<div[^>]*\bid=["']?(?:mw-content-text|content|main-content)["']?[^>]*>([\s\S]*)<\/div>/i,
  /<body\b[^>]*>([\s\S]*)<\/body>/i,
];
const COMMENTS = /<!--[\s\S]*?-->/g;
const BLOCK_END = /<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|td)\s*>/gi;
const LINE_BREAK = /<(br|hr)\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', middot: '·', deg: '°',
};

/** Decode the named and numeric entities that actually occur in body text. */
export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match);
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/**
 * Narrow the HTML to its main content region, if it declares one.
 *
 * Greedy matching to the LAST closing tag is deliberate: the region usually
 * contains nested elements of the same kind, and a lazy match would stop at the
 * first inner close and truncate the article.
 */
export function extractMainRegion(html: string): string {
  for (const pattern of MAIN_REGIONS) {
    const match = pattern.exec(html);
    const inner = match?.[1];
    // Guard against a landmark that wraps almost nothing (a stub <main> above
    // the real content); falling through to the whole document is safer than
    // returning an empty corpus.
    if (inner && inner.length > 500) return inner;
  }
  return html;
}

/** Best-effort `<title>`, for naming the source in the UI. */
export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(match[1]!).replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title.slice(0, 200) : null;
}

/** Strip markup and collapse whitespace into paragraph-separated plain text. */
export function htmlToText(html: string): string {
  const text = extractMainRegion(html)
    .replace(COMMENTS, ' ')
    .replace(DROP_BLOCKS, ' ')
    .replace(LINE_BREAK, '\n')
    .replace(BLOCK_END, '\n\n')
    .replace(/<[^>]+>/g, ' ');

  const plain = decodeEntities(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return dropLinkRuns(plain);
}

/** A block too short and too unpunctuated to be prose. */
function looksLikeLink(block: string): boolean {
  const t = block.trim();
  return t.length > 0 && t.length < 28 && !/[.!?:;,]$/.test(t) && t.split(/\s+/).length <= 4;
}

/**
 * Drop runs of link-like blocks.
 *
 * Even inside `<main>`, sites leave lists of bare labels - language switchers,
 * tag clouds, "related" rails. Individually those can be real headings, so the
 * signal used is a RUN of them: `minRun` or more in a row is a list of links,
 * not prose. A shorter run is kept, which preserves genuine headings.
 *
 * Operates on blank-line-separated blocks because that is what `htmlToText`
 * emits - each list item comes through as its own block, not its own line.
 */
export function dropLinkRuns(text: string, minRun = 4): string {
  const blocks = text.split(/\n{2,}/);
  const keep: string[] = [];
  let run: string[] = [];

  const flush = (): void => {
    if (run.length > 0 && run.length < minRun) keep.push(...run);
    run = [];
  };

  for (const block of blocks) {
    if (looksLikeLink(block)) {
      run.push(block);
      continue;
    }
    flush();
    keep.push(block);
  }
  flush();

  return keep.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Route a fetched body to the right extractor based on its content type. */
export function bodyToText(body: string, contentType: string | null): string {
  if (contentType && /html|xml/i.test(contentType)) return htmlToText(body);
  // Plain text and markdown are already what we want; only line endings differ.
  return body.replace(/\r\n?/g, '\n').trim();
}
