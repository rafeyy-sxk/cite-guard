/**
 * A real parallel verification run against live Groq.
 *
 * Builds N independent claims from a live Wikipedia article and pushes all of
 * them through the scheduler at once, against the account's real ~8,000
 * tokens-per-minute ceiling. Every call is a genuine model call; nothing is
 * simulated.
 *
 * Half the claims are honest (the quote is the sentence's own source text) and
 * half are mismatched (a real quote from a different part of the article), so
 * the entailment judge has something to actually decide.
 *
 * Run: pnpm scale:live [claims] [tokensPerWindow]
 */

import { chunkCorpus } from '../src/lib/chunk';
import { bodyToText } from '../src/lib/extract';
import { chat, resolveModels } from '../src/lib/groq';
import {
  VERIFY_MAX_OUTPUT_TOKENS,
  buildEntailmentMessages,
  outputBudgetForAttempt,
  parseEntailmentResponse,
} from '../src/lib/prompt';
import { runScheduled, type SchedulerTask } from '../src/lib/scheduler';
import { splitSentences } from '../src/lib/sentences';
import { estimateRequestTokens } from '../src/lib/tokens';
import { describeKey, loadEnv } from './env';

const ARTICLE = 'https://en.wikipedia.org/wiki/Cavendish_experiment';

interface Claim {
  id: string;
  statement: string;
  passage: string;
  honest: boolean;
}

async function buildClaims(count: number): Promise<Claim[]> {
  const res = await fetch(ARTICLE, { headers: { 'User-Agent': 'cite-guard/1.0 scale-check' } });
  const text = bodyToText(await res.text(), res.headers.get('content-type'));
  const chunks = chunkCorpus([{ id: 'wiki', title: 'Cavendish experiment', origin: 'url', text }]);

  const sentences = chunks
    .flatMap((c) => splitSentences(c.text).map((s) => s.text))
    .filter((s) => s.length > 90 && s.length < 320);

  const claims: Claim[] = [];
  for (let i = 0; i < count; i += 1) {
    const statement = sentences[i % sentences.length]!;
    const honest = i % 2 === 0;
    // A mismatched claim gets a REAL passage from elsewhere in the article, so
    // the mechanical check would pass and only the judge can separate them.
    const passage = honest ? statement : sentences[(i * 7 + 13) % sentences.length]!;
    claims.push({ id: `claim-${i}`, statement, passage, honest });
  }
  return claims;
}

async function main(): Promise<void> {
  loadEnv();
  console.log(describeKey());

  const count = Number(process.argv[2] ?? 100);
  const tokensPerWindow = Number(process.argv[3] ?? 8000);

  const models = await resolveModels();
  console.log(`model for verification: ${models.verify}`);

  const claims = await buildClaims(count);
  console.log(`built ${claims.length} claims from the live article (${claims.filter((c) => c.honest).length} honest, ${claims.filter((c) => !c.honest).length} mismatched)`);
  console.log(`ceiling: ${tokensPerWindow} tokens / 60s · concurrency: 100\n`);

  const tasks: Array<SchedulerTask<{ supported: boolean; reason: string }>> = claims.map((claim) => {
    const messages = buildEntailmentMessages(claim.statement, claim.passage);
    return {
      id: claim.id,
      estimateTokens: (attempt: number) =>
        estimateRequestTokens(messages, outputBudgetForAttempt(VERIFY_MAX_OUTPUT_TOKENS, attempt)),
      run: async ({ signal, attempt }) => {
        const res = await chat({
          model: models.verify,
          messages,
          maxOutputTokens: outputBudgetForAttempt(VERIFY_MAX_OUTPUT_TOKENS, attempt),
          json: true,
          reasoningEffort: 'low',
          signal,
        });
        return { value: parseEntailmentResponse(res.content), tokensUsed: res.totalTokens };
      },
    };
  });

  let lastLog = 0;
  const started = Date.now();

  const { results, ledger } = await runScheduled(tasks, {
    concurrency: 100,
    tokensPerWindow,
    // Left at the default, which holds entries slightly longer than Groq's own
    // 60s window to absorb dispatch-vs-receipt clock skew.
    maxAttempts: 6,
    onEvent: (event) => {
      const now = Date.now();
      if (now - lastLog < 2000) return;
      lastLog = now;
      const a = event.aggregates;
      console.log(
        `t+${((now - started) / 1000).toFixed(0).padStart(3)}s  running=${String(a.running).padStart(3)} waiting=${String(a.waitingBudget + a.queued).padStart(3)} retrying=${String(a.retrying).padStart(2)} done=${String(a.done).padStart(3)} failed=${a.failed}  tokens60s=${String(a.tokensInWindow).padStart(5)}/${a.tokenCeiling}  429s=${a.rateLimitHits}`,
      );
    },
  });

  const done = [...results.values()].filter((r) => r.state === 'done');
  const failed = [...results.values()].filter((r) => r.state === 'failed');
  const supported = done.filter((r) => r.state === 'done' && (r.value as { supported: boolean }).supported).length;

  // Did the judge actually separate the honest claims from the mismatched ones?
  let honestSupported = 0;
  let mismatchedSupported = 0;
  for (const claim of claims) {
    const r = results.get(claim.id);
    if (r?.state !== 'done') continue;
    const ok = (r.value as { supported: boolean }).supported;
    if (claim.honest && ok) honestSupported += 1;
    if (!claim.honest && ok) mismatchedSupported += 1;
  }

  console.log('\n=== LEDGER (all figures counted by the scheduler during the run)');
  console.log(`claims dispatched ....... ${ledger.tasks}`);
  console.log(`model calls made ........ ${ledger.dispatched}  (tasks + retries)`);
  console.log(`completed ............... ${ledger.completed}`);
  console.log(`failed .................. ${ledger.failed}`);
  console.log(`cancelled ............... ${ledger.cancelled}`);
  console.log(`dropped ................. ${ledger.tasks - ledger.completed - ledger.failed - ledger.cancelled}`);
  console.log(`retries absorbed ........ ${ledger.retries}`);
  console.log(`429s absorbed ........... ${ledger.rateLimitHits}`);
  console.log(`times held at the gate .. ${ledger.budgetWaits}`);
  console.log(`peak concurrency ........ ${ledger.peakConcurrency}`);
  console.log(`wall clock .............. ${(ledger.wallClockMs / 1000).toFixed(1)}s`);
  console.log(`tokens reserved ......... ${ledger.tokensEstimated.toLocaleString()}`);
  console.log(`tokens actually billed .. ${ledger.tokensActual.toLocaleString()}`);
  console.log('\n=== VERDICTS');
  console.log(`supported ............... ${supported} of ${done.length} completed`);
  console.log(`honest claims upheld .... ${honestSupported} of ${claims.filter((c) => c.honest).length}`);
  console.log(`mismatched claims upheld  ${mismatchedSupported} of ${claims.filter((c) => !c.honest).length}  (lower is better)`);
  if (failed.length > 0) {
    console.log(`\nfirst failure: ${failed[0]!.state === 'failed' ? failed[0]!.error : ''}`);
  }
}

main().catch((err) => {
  console.error('scale-check failed:', err.message);
  process.exit(1);
});
