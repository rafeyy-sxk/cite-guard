/**
 * End-to-end check against live Groq and a live Wikipedia article.
 *
 * Two questions are asked on purpose:
 *   1. one the article answers, to show verified sentences with real citations;
 *   2. one it does not cover at all, which is the control — the interesting
 *      result is that the answer is withheld rather than invented.
 *
 * Run: pnpm e2e:live
 */

import { bodyToText, extractTitle } from '../src/lib/extract';
import { runAsk } from '../src/lib/pipeline';
import { assessUrl } from '../src/lib/ssrf';
import type { CheckedSentence, SourceDoc } from '../src/lib/types';
import { describeKey, loadEnv } from './env';

const ARTICLE = 'https://en.wikipedia.org/wiki/Cavendish_experiment';

/** Answerable from the article. */
const COVERED =
  'What did the Cavendish experiment measure, when was it performed, and what apparatus did it use?';

/**
 * The control that matters.
 *
 * It shares enough vocabulary with the article to retrieve passages, so the
 * model IS asked to answer it - but the article never states a build cost or a
 * funding patron. The correct behaviour is an explicit refusal or a
 * struck-through sentence. A confident published answer would be the failure.
 */
const RETRIEVES_BUT_UNANSWERABLE =
  'How much did the Cavendish torsion balance apparatus cost to build in pounds, and which patron funded the experiment?';

/** Not in the article at all; this one should not even reach the model. */
const NOT_COVERED =
  'What was the annual salary of Henry Cavendish in pounds, and who was his literary agent?';

function describe(sentence: CheckedSentence): string {
  if (sentence.status === 'verified') {
    return `  VERIFIED   ${sentence.text}\n             ^ ${sentence.chunkId} chars ${sentence.span.start}-${sentence.span.end}: "${sentence.sourceText.slice(0, 110)}"`;
  }
  return `  WITHHELD   ${sentence.text}\n             ^ ${sentence.reason}: ${sentence.detail}`;
}

async function main(): Promise<void> {
  loadEnv();
  console.log(describeKey());

  const verdict = assessUrl(ARTICLE);
  if (!verdict.ok) throw new Error(verdict.reason);

  console.log(`\nFetching ${ARTICLE}`);
  const res = await fetch(ARTICLE, { headers: { 'User-Agent': 'cite-guard/1.0 live-check' } });
  if (!res.ok) throw new Error(`Wikipedia returned HTTP ${res.status}`);
  const html = await res.text();
  const text = bodyToText(html, res.headers.get('content-type'));

  const doc: SourceDoc = {
    id: 'wiki',
    title: extractTitle(html) ?? 'Cavendish experiment',
    origin: 'url',
    text,
    url: ARTICLE,
  };
  console.log(`Loaded "${doc.title}": ${doc.text.length.toLocaleString()} characters\n`);

  const started = Date.now();
  const result = await runAsk(
    {
      docs: [doc],
      questions: [COVERED, RETRIEVES_BUT_UNANSWERABLE, NOT_COVERED],
      concurrency: 100,
      tokensPerWindow: 8000,
      topK: 4,
    },
    (event) => {
      if (event.type === 'phase') console.log(`[phase] ${event.detail}`);
      if (event.type === 'models') console.log(`[models] draft=${event.draft} verify=${event.verify}`);
    },
  );

  for (const q of result.questions) {
    console.log(`\n=== ${q.question}`);
    console.log(`    outcome: ${q.outcome} · coverage: ${q.coverage.verified}/${q.coverage.total}`);
    if (q.notice) console.log(`    notice: ${q.notice}`);
    for (const s of q.sentences) console.log(describe(s));
  }

  console.log('\n=== LEDGER');
  console.log(JSON.stringify(result.ledger, null, 2));
  console.log(`\nwall clock (script): ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error('live-check failed:', err.message);
  process.exit(1);
});
