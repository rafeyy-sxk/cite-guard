# cite-guard

Question answering over documents you provide, where **every sentence of the answer must be
traceable to a verbatim span in a source**. Anything that cannot be traced is struck through and
labelled, not published.

The difference from the other retrieval demos is that **the check is mechanical**. The model is
required to return the exact passage supporting each sentence it writes, and the app then goes and
*searches for that passage in the source text*. A quote that was never in the document cannot be
found in the document. There is no confidence score to argue with and no second model deciding
whether the first one did well.

---

## Why a string search instead of an LLM judge

A model grading its own output fails hardest exactly where you need it most: a fabricated quote is
the case it is most confident about. Substring search has no such failure mode.

The matcher is not brittle, though, because a brittle checker trains people to ignore it. Comparison
happens in a folded space that ignores case, punctuation, accents and whitespace, while still
mapping back to exact character offsets in the original text:

| The model wrote | The source says | Verdict |
|---|---|---|
| `THE FIRST TO MEASURE THE FORCE OF GRAVITY` | `the first to measure the force of gravity` | verified |
| `Cavendish's result was expressed` | `Cavendish’s result was expressed` (curly) | verified |
| `The apparatus  used \n a torsion balance` | `The apparatus used a torsion balance` | verified |
| `he reported as 9.448 times the density` | `he reported as 5.448 times the density` | **rejected** |
| `Cavendish used a laser interferometer` | (nowhere in the document) | **rejected** |
| `the force of` | present, but 3 words | **rejected, too short** |

`src/lib/normalize.ts` is what makes both halves possible: it returns the folded string *plus* a map
from every folded character index back to its index in the raw input. A match found in folded space
projects back onto exact original offsets, which is how the UI highlights the precise span.

Because a genuine quote can still be lifted out of context, there is a **second, independent pass**:
one small model call per claim, shown only the located passage and the one sentence — never the
question, never the rest of the answer, never the other passages. A judge given the surrounding
argument tends to ratify it. Both gates must pass. Either failure strikes the sentence through, and
a check that cannot be completed **fails closed** — withheld, never silently upgraded to verified.

---

## The engineering: verification at scale

Verification is embarrassingly parallel — every claim is independent. The only thing stopping a
hundred at once is the provider ceiling, measured live on this account:

```
x-ratelimit-limit-tokens: 8000     # per 60 seconds, free tier
```

Firing 100 requests at that does not degrade gracefully; it 429s, and naive retry makes it worse.
So `src/lib/scheduler.ts` and `src/lib/budget.ts` enforce three things at once.

**1. Concurrency.** At most `concurrency` requests in flight, default 100.

**2. A rolling token budget.** The critical design point is that tokens are **reserved before
dispatch, not recorded after completion**. With 100 requests in flight, recording on completion means
all 100 pass the gate while the window still reads zero and the ceiling is blown before the first
response lands. So:

```
reserve(id, estimate)   gate decision; the estimate enters the window NOW
reconcile(id, actual)   swap the estimate for usage.total_tokens, same timestamp
release(id)             the request was never processed (429); take it back
```

Work that does not fit waits at the gate in `waiting-budget`. Preventing a 429 is strictly cheaper
than absorbing one. A task whose estimate exceeds the entire window is failed immediately with a
message saying so, rather than parking the run forever.

**3. Retries that terminate.** A 429 honours `retry-after`, returns its reservation, and is re-queued
with jittered backoff (equal jitter; `retry-after` is a floor, never a ceiling). A task that exhausts
`maxAttempts` is reported **failed** — never dropped, never left hanging.

Three details that came out of running it for real rather than reasoning about it:

- **The budget is shared across phases.** Drafting and verification are two scheduler passes against
  *one* 60-second ceiling. A fresh budget per phase would quietly double the allowance.
- **Reservations are attempt-aware.** Verification retries raise their output allowance, and
  reserving that larger figure on *every* attempt idles roughly a third of the budget on headroom
  almost nothing uses. `estimateTokens` may be a function of the attempt number.
- **Reconciliation is one-way: it can raise an entry, never lower it.** A provider admits a request
  against `prompt + max_completion_tokens`, so giving back the unused output allowance the instant a
  response lands manufactures headroom that exists only on our side. Measured in a controlled A/B
  below — the effect is real but small, and I initially credited it with far more than it deserved.

Everything time-dependent goes through an injected `Clock` (`src/lib/clock.ts`), so the whole
scheduler is tested against a hand-driven virtual clock: no sleeping, no flake, no real minute.

---

## What actually happened on live runs

Every figure below is real output from the scripts in `scripts/`, against live Groq and live
Wikipedia. Where something is deterministic rather than a model call, it says so.

### End-to-end (`pnpm e2e:live`) — real model calls

Source fetched live: `https://en.wikipedia.org/wiki/Cavendish_experiment` — 215,281 bytes of HTML,
**16,926 characters** of text after extraction, 23 chunks. Models chosen from the live catalogue:
`openai/gpt-oss-120b` drafting, `openai/gpt-oss-20b` checking. 8 model calls total.

**Question 1, answerable.** *"What did the Cavendish experiment measure, when was it performed, and
what apparatus did it use?"* → `answered`, **2 of 3 sentences verified**:

```
WITHHELD   The Cavendish experiment measured the force of gravity between masses in the laboratory.
           ^ not_entailed: the quote is genuinely in the source, but it does not support this
             sentence (No mention of Cavendish experiment).
VERIFIED   It was performed in 1797–1798 by English scientist Henry Cavendish.
           ^ c0 chars 154-213: "performed in 1797–1798 by English scientist Henry Cavendish"
VERIFIED   The experiment used a torsion balance apparatus.
           ^ c1 chars 824-874: "who constructed a torsion balance apparatus for it"
```

All three quotes were **real** — the mechanical pass accepted 3 of 3. The second gate rejected one
because the sentence named "the Cavendish experiment" while its quote did not. That is arguably
harsh. **This judge is strict, and a strict judge produces false negatives.** The coverage figure
exists so that cost is visible rather than hidden.

### The control: what happens to something the document does not cover

Two unanswerable questions, refused at two different layers, in the same live run:

**Retrieves passages but is unanswerable** — *"How much did the Cavendish torsion balance apparatus
cost to build in pounds, and which patron funded the experiment?"* This shares enough vocabulary to
retrieve, so the model **was** called. Result: `model_declined`.

> The model was given the closest passages and reported that they do not answer this question.

**Retrieves nothing** — *"What was the annual salary of Henry Cavendish in pounds, and who was his
literary agent?"* Result: `no_relevant_source`, and **no model call was made at all**.

> Nothing in these sources matches this question closely enough to answer from. Rather than write
> something that sounds plausible, cite-guard stops here.

Nothing was published either time. But be precise about what that proves: **on this run the model
chose to decline, so it was the model's honesty on display, not the checker's.** The checker is only
exercised when a model *does* assert something unsupported.

So here is the checker on its own, run against **the same live 16,926-character article**, with the
citations injected by hand and **no model involved** — deterministic, repeatable, and the only thing
under test is `src/lib/verify.ts`:

```
VERIFIED    real quote, verbatim from the article
            span 154-213: "performed in 1797–1798 by English scientist Henry Cavendish"

VERIFIED    same quote retyped lowercase with a plain hyphen for the en dash
            span 154-213: "performed in 1797–1798 by English scientist Henry Cavendish"

STRUCK OUT  one digit changed inside an otherwise real quote  ("1897–1898")
            quote_not_found: does not appear anywhere in the provided sources

STRUCK OUT  wholly fabricated quote — the funding claim the article cannot support
            quote_not_found: does not appear anywhere in the provided sources

STRUCK OUT  real opening words continuing into invention ("...by a team of French engineers")
            quote_not_found: does not appear anywhere in the provided sources

STRUCK OUT  cites a passage id that does not exist
            missing_source: the model cited "c9999", which is not one of the passages it was given

STRUCK OUT  no quote offered at all
            no_citation: the model wrote this sentence without offering a supporting quote
```

Two real quotes verified to the identical span despite different punctuation and case; five
unsupported variants struck through with five distinct reasons. `tests/pipeline.test.ts` covers the
same path through the full pipeline, where a fabricated quote is struck through as `quote_not_found`
and coverage is reported as 1 of 2.

### The parallel run (`pnpm scale:live 100 8000`) — 100 real model calls

100 independent claims built from the live article, every one a real model call, at concurrency 100
against the real 8,000 tokens-per-minute ceiling. 50 claims pair a sentence with its own source text;
50 pair it with a real passage from elsewhere, so the mechanical check passes on all 100 and only the
judge can separate them.

**100 claims, 100 completed, 0 dropped, 0 failed:**

```
claims dispatched ....... 100
model calls made ........ 102   (100 tasks + 2 retries)
completed ............... 100
failed .................. 0
cancelled ............... 0
dropped ................. 0
retries absorbed ........ 2
429s absorbed ........... 2
times held at the gate .. 11
peak concurrency ........ 22
wall clock .............. 241.3s
tokens reserved ......... 37,561
tokens actually billed .. 31,254

honest claims upheld .... 50 of 50
mismatched claims upheld  0 of 50
```

**Peak concurrency was 22, not 100.** The cap was 100; the token ceiling was the binding constraint
throughout. 31,254 billed tokens at 8,000/minute has a floor around 234 seconds however wide you run,
and the run took 241.3s — within 3% of the best the ceiling physically allows. Claiming "100
concurrent model calls" would be false. The true claim is that 100 claims were scheduled
concurrently and in-flight width was governed by the budget, which is the whole reason to build a
scheduler instead of calling `Promise.all`.

### A measurement that corrected me

Five 100-claim runs were made in total. All five completed 100/100 with nothing dropped, and all five
landed within 240.9–252.6s. What moved wildly was the rate-limit count:

| run | configuration | 429s | model calls | wall clock | completed |
|---|---|---:|---:|---:|---:|
| 1 | sequential, reconcile lowers | 26 | 126 | 242.0s | 100/100 |
| 2 | sequential, + 3s window margin | 112 | 212 | 252.6s | 100/100 |
| 3 | sequential, reconcile raise-only | 2 | 102 | 241.3s | 100/100 |
| A | **controlled A/B**, reconcile lowers | **1** | 101 | 240.9s | 100/100 |
| B | **controlled A/B**, reconcile raise-only | **0** | 100 | 241.3s | 100/100 |

Runs 1–3 are sequential and each changed configuration, so I read 26 → 2 as evidence that one-way
reconciliation fixed the rate limits, and wrote that up as the cause.

**Then I ran A and B back to back with only that one method differing, and it was 1 versus 0.** Same
semantics as run 1 produced 26 rate limits once and 1 another time. So the honest conclusion is that
**most of that variance came from the shared account's state, not from my change**, and my original
causal story was wrong. The 3-second window margin in run 2 is in the same position — one
uncontrolled run, not a disproof.

What the controlled test does support is narrow and I will not stretch it: raise-only reconciliation
is directionally better (0 vs 1 rate limits, 100 vs 101 calls) at identical wall clock, so it ships,
and the reasoning behind it stands on its own. Both findings are recorded in the code — in
`RollingTokenBudget.reconcile` and in `src/lib/scheduler-types.ts` — including the part where I was
wrong, so nobody re-derives it from the same bad inference.

The robust results across all five runs are the ones worth quoting: **nothing was ever dropped, every
retry was absorbed, and wall clock sat within a few percent of the ceiling's theoretical floor every
time.**

## Retrieval

BM25 over the chunked corpus, implemented in `src/lib/bm25.ts`. No embedding API — that would add a
second vendor, a second key, a second rate limit and a per-query cost, and for question answering
over a corpus the user pasted thirty seconds ago, where the question reuses the document's own
vocabulary, lexical scoring is the right tool rather than a compromise.

Standard parameterisation (`k1 = 1.5`, `b = 0.75`) with probabilistic IDF floored at zero, so a term
appearing in every chunk contributes ~0 instead of a negative score that would rank a matching chunk
*below* a non-matching one. Ties break on document order, so results are reproducible.

Alongside the raw score, each hit carries **coverage** — the fraction of the query's distinct content
terms present in that chunk. Unlike BM25 score, coverage is comparable across corpora, which is why
the "do not answer this" floor is expressed in it (`RETRIEVAL_COVERAGE_FLOOR = 0.34`).

Chunking (`src/lib/chunk.ts`) segments on paragraphs, sub-segments long paragraphs on sentences, then
packs greedily with a trailing overlap. Every chunk is a verbatim slice and `text.slice(start, end)`
reproduces it exactly — asserted by tests, because a quote straddling a chunk boundary would show up
as a false "unverified", the most expensive failure this app can have.

---

## Security

**URL fetching** (`src/lib/ssrf.ts`, `src/app/api/fetch-url/route.ts`). Handing a server a URL to
fetch is SSRF by default, so the check is an allowlist of schemes (`http`, `https`) and ports
(80, 443) plus a denylist of address ranges, applied at three points: the URL as typed, the addresses
the hostname actually resolves to, and **every redirect hop** — which is why redirects are followed
manually. Blocked: loopback, RFC1918, CGNAT, link-local (including `169.254.169.254`), IPv6
loopback/ULA/link-local/multicast, and IPv4-mapped IPv6 forms like `::ffff:127.0.0.1`. DNS rebinding
is refused if *any* returned address is private, not only if all of them are.

Verified against the running dev server:

```
POST /api/fetch-url, against the running dev server:

http://127.0.0.1:3111/                     -> Only ports 80 and 443 are fetched, not 3111.
http://localhost/admin                     -> That hostname points at this server, so it will not be fetched.
http://169.254.169.254/latest/meta-data/   -> That address is on a private or reserved network.
http://10.0.0.5/                           -> That address is on a private or reserved network.
file:///etc/passwd                         -> Only http and https URLs are fetched, not "file:".
http://[::1]/                              -> That address is on a private or reserved network.

https://en.wikipedia.org/wiki/Torsion_spring -> 200, 15,762 characters extracted from 198,346 of HTML
```

**The Groq endpoint is hardcoded.** `GROQ_BASE_URL` is deliberately not read: a base-URL environment
variable is a redirect primitive, and anything that can set one on a deployment can point a request
carrying a live API key at a host it controls. There is no legitimate need for it here, so the lever
does not exist. A test asserts the request URL is unchanged even with `GROQ_BASE_URL` set.

**Boundaries are validated with zod** (`src/lib/schemas.ts`) before anything touches a request body,
with size caps that keep a request inside the serverless limit and return a readable error instead of
an opaque 413.

---

## Running it

```bash
pnpm install
cp .env.example .env.local        # then put your Groq key in it
pnpm dev                          # http://localhost:3000
```

| script | what it does |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | Next.js |
| `pnpm test` | the full vitest suite — no network, no key |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | eslint |
| `pnpm e2e:live` | `scripts/live-check.ts` — real article, real Groq, prints the answer and the ledger |
| `pnpm scale:live [claims] [tokensPerWindow]` | `scripts/scale-check.ts` — the parallel run above |

The two live scripts need `GROQ_API_KEY`; everything else does not.

### Deploying

Vercel-ready. No runtime filesystem writes (documents live in memory for one request), no
long-running processes, `maxDuration = 60` on the run route, and the client holds the source text so
nothing needs server-side storage.

---

## Tests

186 tests across 13 files. Every one is hermetic: mocked transport, a hand-driven virtual clock, no
network and no API key.

| file | tests | covers |
|---|---:|---|
| `tests/verify.test.ts` | 21 | fabrication rejected, case/punctuation/whitespace accepted, quote floor, exact spans, relocation, empty corpora |
| `tests/groq.test.ts` | 22 | hardcoded endpoint, `GROQ_BASE_URL` ignored, live-catalogue filtering, retired-id fallback, error mapping, reasoning-effort fallback |
| `tests/prompt.test.ts` | 21 | prompt shape, brace-matching JSON extraction, tolerant parsing, fail-closed verdicts |
| `tests/scheduler.test.ts` | 19 | 100 claims under a low budget, window invariant, concurrency cap, 429 storms, cancellation, attempt-aware estimates |
| `tests/extract.test.ts` | 17 | main-region narrowing, chrome removal, entity decoding, link-run filtering |
| `tests/ssrf.test.ts` | 15 | schemes, ports, every private range, IPv4-mapped IPv6, DNS rebinding |
| `tests/bm25.test.ts` | 14 | known-corpus ranking order, IDF floor, coverage, determinism |
| `tests/chunk.test.ts` | 12 | empty/tiny/huge/pathological input, exact offsets, unicode |
| `tests/normalize.test.ts` | 11 | folding rules and offset projection |
| `tests/budget.test.ts` | 10 | ceiling, sliding window, one-way reconciliation, release |
| `tests/pipeline.test.ts` | 10 | end-to-end answering, honest empty state, strike-through, fail-closed, 100 claims |
| `tests/sentences.test.ts` | 9 | abbreviations, decimals, initials, offsets |
| `tests/tokens.test.ts` | 5 | estimation direction and output reservation |

Three properties the suite is built around:

- **Every zero has a positive control.** `provider.refusals === 0` only means something because the
  same fake provider provably *does* refuse when its limit is exceeded — asserted in the same test.
- **The clock is driven, never waited on.** `ManualClock.runUntilSettled` fails with a clear message
  if a run is still pending after its step budget, so a scheduler deadlock surfaces as a named
  failure rather than a timeout.
- **The rate limiter is real.** The test double models a sliding token window and returns 429 when
  you exceed it, so "the gate held" is a measurement, not an assumption.

### Planted-defect check

Quote matching was weakened to require only the first three words of a quote — a plausible
"be more lenient" bug that reintroduces the real vulnerability:

```ts
// src/lib/verify.ts
- const hit = haystack.indexOf(foldedQuote);
+ const hit = haystack.indexOf(foldedQuote.split(' ').slice(0, 3).join(' '));
```

Two named tests failed, exit code 1:

```
FAIL tests/verify.test.ts > verifier: fabrication is rejected
     > should reject a quote that mixes real words into a fabricated sentence
FAIL tests/verify.test.ts > verifier: the whole quote must match, not a prefix of it
     > should reject a quote whose opening words are real but which continues into invention
Tests  2 failed | 19 passed (21)
```

Restored, byte-identical, and the suite returns to 186 passed, exit 0.

---

## Limits, honestly

- **The entailment judge is strict and produces false negatives.** In the live run it withheld a
  sentence whose quote arguably did support most of it. Strict is the right default for this app, but
  it costs coverage, and the coverage figure is shown so that cost is visible.
- **A real quote can still be quoted out of context.** The mechanical gate cannot detect this at all;
  that is exactly what the second pass is for, and the second pass is a model.
- **Peak concurrency is limited by tokens, not by the cap.** On the free tier you will see ~20 in
  flight, not 100. Raise `tokensPerWindow` in the UI to see the cap become the constraint.
- **Rate limits are reduced, not eliminated, and they vary a lot run to run.** Across five 100-claim
  runs the count ranged from 0 to 112 while the code changed very little; most of that is the shared
  account's state, not our scheduler. Our accounting and the provider's can always disagree, which is
  why the retry path exists. What did hold across all five runs: nothing dropped, every retry
  absorbed, wall clock within a few percent of the ceiling's floor.
- **The causal claims about the scheduler are deliberately weak**, because the controlled test only
  supported a weak one. If you need a stronger conclusion, run the A/B with more repetitions on a
  dedicated key.
- **Retrieval is lexical.** A question phrased in entirely different vocabulary from the document
  will retrieve badly and be refused rather than answered. That is the designed failure direction.
- **HTML extraction is regex-based**, not a DOM parse. It narrows to `<main>`/`<article>` and drops
  runs of link-like blocks, which handles Wikipedia-shaped pages well; an unusual layout may still
  leak some navigation text into the corpus.
- **Only `.txt` and `.md` upload.** No PDF, no DOCX.
- **No browser test run.** The UI was exercised against a running dev server over HTTP and the API
  routes were verified live, but no Playwright suite exists and nobody has clicked through it in a
  real browser.
