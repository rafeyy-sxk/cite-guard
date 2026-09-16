import { lookup } from 'node:dns/promises';
import { NextResponse } from 'next/server';
import { bodyToText, extractTitle } from '@/lib/extract';
import { MAX_BODY_BYTES, MAX_DOC_CHARS } from '@/lib/limits';
import { fetchUrlSchema, firstIssue } from '@/lib/schemas';
import { assertResolvesPublicly, assessUrl } from '@/lib/ssrf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Redirects are followed by hand so every hop can be re-checked. */
const MAX_REDIRECTS = 4;

const ACCEPTED_TYPES = /text\/html|text\/plain|text\/markdown|application\/xhtml|application\/json/i;

async function guard(raw: string): Promise<URL> {
  const verdict = assessUrl(raw);
  if (!verdict.ok) throw new Error(verdict.reason);
  await assertResolvesPublicly(verdict.url.hostname, async (host) => {
    const answers = await lookup(host, { all: true });
    return answers.map((a) => ({ address: a.address }));
  });
  return verdict.url;
}

/**
 * Fetch a page and return its readable text.
 *
 * The SSRF check runs on the original URL AND on every redirect target, because
 * a permitted host is free to redirect to the cloud metadata endpoint. That is
 * why `redirect: 'manual'` is used rather than letting fetch follow the chain.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Send a JSON body with a "url" field.' }, { status: 400 });
  }

  const parsed = fetchUrlSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  let target: URL;
  try {
    target = await guard(parsed.data.url);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  try {
    let response: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const res = await fetch(target.toString(), {
        redirect: 'manual',
        headers: {
          // Identify honestly. Some sites serve a different page to unknown agents.
          'User-Agent': 'cite-guard/1.0 (+https://github.com/) document fetcher',
          Accept: 'text/html,text/plain,text/markdown;q=0.9,*/*;q=0.1',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) return NextResponse.json({ error: 'That page redirected without a destination.' }, { status: 502 });
        if (hop === MAX_REDIRECTS) {
          return NextResponse.json({ error: 'That URL redirected too many times.' }, { status: 502 });
        }
        target = await guard(new URL(location, target).toString());
        continue;
      }

      response = res;
      break;
    }

    if (!response) return NextResponse.json({ error: 'That URL could not be fetched.' }, { status: 502 });
    if (!response.ok) {
      return NextResponse.json({ error: `That page returned HTTP ${response.status}.` }, { status: 502 });
    }

    const contentType = response.headers.get('content-type');
    if (contentType && !ACCEPTED_TYPES.test(contentType)) {
      return NextResponse.json(
        { error: `That URL is ${contentType.split(';')[0]}, not a text page. Only HTML, text and markdown are read.` },
        { status: 415 },
      );
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: `That page is ${(declared / 1_000_000).toFixed(1)} MB, over the ${(MAX_BODY_BYTES / 1_000_000).toFixed(1)} MB limit.` },
        { status: 413 },
      );
    }

    const raw = await response.text();
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'That page is too large to read.' }, { status: 413 });
    }

    const text = bodyToText(raw, contentType).slice(0, MAX_DOC_CHARS);
    if (text.trim().length === 0) {
      return NextResponse.json({ error: 'That page had no readable text in it.' }, { status: 422 });
    }

    return NextResponse.json({
      title: extractTitle(raw) ?? target.hostname + target.pathname,
      text,
      url: target.toString(),
      truncated: raw.length > MAX_DOC_CHARS,
    });
  } catch (err) {
    const message = (err as Error).name === 'TimeoutError' ? 'That page took too long to respond.' : (err as Error).message;
    return NextResponse.json({ error: `Could not fetch that page: ${message}` }, { status: 502 });
  }
}
