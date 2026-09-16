import { describe, expect, it } from 'vitest';
import { chunkCorpus } from '../src/lib/chunk';
import type { ClaimedSentence, SourceDoc } from '../src/lib/types';
import { normalizeText } from '../src/lib/normalize';
import { VerificationCorpus } from '../src/lib/verify';

const SOURCE_TEXT = [
  'The Cavendish experiment was performed in 1797 and 1798 by the British scientist Henry Cavendish.',
  '',
  'He was the first to measure the force of gravity between masses in a laboratory, and the first to',
  'produce an accurate value for the gravitational constant. The apparatus used a torsion balance',
  'suspended from a wire, with two lead spheres attached to the ends of a horizontal beam.',
  '',
  'Cavendish’s result was expressed as the density of the Earth, which he reported as 5.448 times',
  'the density of water. The modern accepted value is 5.514.',
].join('\n');

const OTHER_TEXT =
  'Torsion balances are also used in electrostatics. Coulomb built one to measure electric force.';

function makeCorpus(): { corpus: VerificationCorpus; chunkIds: string[]; docs: SourceDoc[] } {
  const docs: SourceDoc[] = [
    { id: 'd1', title: 'Cavendish experiment', origin: 'paste', text: SOURCE_TEXT },
    { id: 'd2', title: 'Torsion balance', origin: 'paste', text: OTHER_TEXT },
  ];
  const chunks = chunkCorpus(docs, { targetChars: 300, overlapChars: 60 });
  return { corpus: new VerificationCorpus(docs, chunks), chunkIds: chunks.map((c) => c.id), docs };
}

function claim(text: string, chunkId: string | null, quote: string | null): ClaimedSentence {
  return { text, chunkId, quote };
}

describe('verifier: fabrication is rejected', () => {
  it('should reject a quote that does not appear in any source', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const result = corpus.verify(
      claim(
        'Cavendish measured the gravitational constant using a laser interferometer.',
        chunkIds[0]!,
        'Cavendish used a laser interferometer to obtain his result',
      ),
    );

    expect(result.status).toBe('unverified');
    expect(result.status === 'unverified' && result.reason).toBe('quote_not_found');
  });

  it('should reject a quote that mixes real words into a fabricated sentence', async () => {
    const { corpus, chunkIds } = makeCorpus();
    // Every individual word below is in the source. The sentence is not.
    const result = corpus.verify(
      claim(
        'Cavendish reported the density of the Earth as 9.9 times the density of water.',
        chunkIds[0]!,
        'he reported as 9.448 times the density of water',
      ),
    );
    expect(result.status).toBe('unverified');
    expect(result.status === 'unverified' && result.reason).toBe('quote_not_found');
  });

  it('should reject a citation to a passage id that was never provided', async () => {
    const { corpus } = makeCorpus();
    const result = corpus.verify(
      claim('Something plausible.', 'c999', 'the first to measure the force of gravity between masses'),
    );
    expect(result.status).toBe('unverified');
    expect(result.status === 'unverified' && result.reason).toBe('missing_source');
    expect(result.status === 'unverified' && result.detail).toContain('c999');
  });

  it('should reject a sentence offered with no quote at all', async () => {
    const { corpus, chunkIds } = makeCorpus();
    expect(corpus.verify(claim('No evidence offered.', chunkIds[0]!, null)).status).toBe('unverified');
    expect(corpus.verify(claim('No evidence offered.', chunkIds[0]!, '   ')).status).toBe('unverified');
    const r = corpus.verify(claim('No evidence offered.', null, 'the force of gravity between masses'));
    expect(r.status === 'unverified' && r.reason).toBe('no_citation');
  });
});

describe('verifier: real quotes are accepted despite presentation differences', () => {
  it('should accept a quote that differs only in case', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const result = corpus.verify(
      claim('Cavendish measured gravity in a lab.', chunkIds[0]!, 'THE FIRST TO MEASURE THE FORCE OF GRAVITY BETWEEN MASSES'),
    );
    expect(result.status).toBe('verified');
  });

  it('should accept a quote that differs only in punctuation and quote style', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const result = corpus.verify(
      claim('He reported a density figure.', chunkIds[0]!, "Cavendish's result was expressed as the density of the Earth"),
    );
    expect(result.status).toBe('verified');
    // The source uses a curly apostrophe; the model typed a straight one.
    expect(result.status === 'verified' && result.sourceText).toContain('’');
  });

  it('should accept a quote whose line breaks were collapsed into spaces', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const result = corpus.verify(
      claim(
        'He produced an accurate value for G.',
        chunkIds[0]!,
        'the first to produce an accurate value for the gravitational constant',
      ),
    );
    expect(result.status).toBe('verified');
  });

  it('should accept a quote with different internal whitespace', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const result = corpus.verify(
      claim('It used a torsion balance.', chunkIds[0]!, 'The   apparatus \n used   a torsion balance'),
    );
    expect(result.status).toBe('verified');
  });
});

describe('verifier: the whole quote must match, not a prefix of it', () => {
  it('should reject a quote whose opening words are real but which continues into invention', () => {
    const { corpus, chunkIds } = makeCorpus();
    const result = corpus.verify(
      claim(
        'He reported a density of 12 times water.',
        chunkIds[0]!,
        // "which he reported as" is verbatim from the source; the rest is not.
        'which he reported as 12 times the density of mercury',
      ),
    );
    expect(result.status).toBe('unverified');
    expect(result.status === 'unverified' && result.reason).toBe('quote_not_found');
  });

  it('should return a span covering the ENTIRE quote, not a fragment of it', () => {
    // A generic tripwire: any matcher that accepts a partial match would return
    // a span shorter than the quote, and this fails without naming the defect.
    const { corpus, chunkIds } = makeCorpus();
    const quote = 'the first to measure the force of gravity between masses in a laboratory';
    const result = corpus.verify(claim('Real claim.', chunkIds[0]!, quote));

    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;
    expect(normalizeText(result.sourceText)).toBe(normalizeText(quote));
  });
});

describe('verifier: quote length floor', () => {
  it('should reject a quote that is too short to prove anything', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const result = corpus.verify(claim('Gravity exists.', chunkIds[0]!, 'the force of'));
    expect(result.status).toBe('unverified');
    expect(result.status === 'unverified' && result.reason).toBe('quote_too_short');
  });

  it('should reject a quote of enough words but too few characters', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const result = corpus.verify(claim('Tiny.', chunkIds[0]!, 'a b c d e'));
    expect(result.status === 'unverified' && result.reason).toBe('quote_too_short');
  });

  it('should honour a configured minimum word count', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const c = claim('X.', chunkIds[0]!, 'the force of gravity between masses in a laboratory');
    expect(corpus.verify(c).status).toBe('verified');
    expect(corpus.verify(c, { minQuoteWords: 50 }).status).toBe('unverified');
  });
});

describe('verifier: spans point at the real source text', () => {
  it('should return a span that slices back to the quoted text', async () => {
    const { corpus, chunkIds, docs } = makeCorpus();
    const result = corpus.verify(
      claim('It used lead spheres.', chunkIds[0]!, 'two lead spheres attached to the ends of a horizontal beam'),
    );

    expect(result.status).toBe('verified');
    if (result.status !== 'verified') return;

    const doc = docs.find((d) => d.id === result.span.docId)!;
    const sliced = doc.text.slice(result.span.start, result.span.end);
    expect(sliced).toBe(result.sourceText);
    expect(sliced.toLowerCase()).toContain('lead spheres');
    expect(result.span.end).toBeGreaterThan(result.span.start);
  });

  it('should carry the source punctuation the model normalised away', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const result = corpus.verify(
      claim('It reported 5.448.', chunkIds[0]!, 'which he reported as 5 448 times the density of water'),
    );
    expect(result.status).toBe('verified');
    // The model wrote "5 448"; the source says "5.448". The span shows the source.
    expect(result.status === 'verified' && result.sourceText).toContain('5.448');
  });
});

describe('verifier: relocation across passages', () => {
  it('should accept a real quote cited against the wrong passage and flag it relocated', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const wrongChunk = chunkIds[chunkIds.length - 1]!;
    const result = corpus.verify(
      claim(
        'Cavendish measured gravity between masses.',
        wrongChunk,
        'the first to measure the force of gravity between masses in a laboratory',
      ),
    );

    expect(result.status).toBe('verified');
    expect(result.status === 'verified' && result.relocated).toBe(true);
    expect(result.status === 'verified' && result.claimedChunkId).toBe(wrongChunk);
    expect(result.status === 'verified' && result.chunkId).not.toBe(wrongChunk);
  });

  it('should reject rather than relocate when relocation is disabled', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const wrongChunk = chunkIds[chunkIds.length - 1]!;
    const result = corpus.verify(
      claim('x', wrongChunk, 'the first to measure the force of gravity between masses in a laboratory'),
      { allowRelocation: false },
    );
    expect(result.status).toBe('unverified');
    expect(result.status === 'unverified' && result.reason).toBe('quote_not_found');
  });

  it('should confine a within-chunk match to the cited chunk when it is correct', async () => {
    const { corpus, docs } = makeCorpus();
    const chunks = chunkCorpus(docs, { targetChars: 300, overlapChars: 60 });
    const electroChunk = chunks.find((c) => c.docId === 'd2')!;
    const result = corpus.verify(
      claim('Coulomb used one too.', electroChunk.id, 'Coulomb built one to measure electric force'),
    );
    expect(result.status).toBe('verified');
    expect(result.status === 'verified' && result.relocated).toBe(false);
    expect(result.status === 'verified' && result.span.docId).toBe('d2');
  });
});

describe('verifier: degenerate corpora', () => {
  it('should handle an empty corpus without throwing', async () => {
    const corpus = new VerificationCorpus([], []);
    const result = corpus.verify(claim('Anything at all.', 'c0', 'some quote with enough words here'));
    expect(result.status).toBe('unverified');
    expect(result.status === 'unverified' && result.reason).toBe('missing_source');
  });

  it('should handle a document whose text is empty', async () => {
    const docs: SourceDoc[] = [{ id: 'e', title: 'Empty', origin: 'paste', text: '' }];
    const corpus = new VerificationCorpus(docs, chunkCorpus(docs));
    const result = corpus.verify(claim('x', 'c0', 'a quote of sufficient length to pass'));
    expect(result.status).toBe('unverified');
  });

  it('should never mark a sentence verified without a locatable span', async () => {
    const { corpus, chunkIds } = makeCorpus();
    const attempts = [
      claim('a', chunkIds[0]!, 'entirely invented text that is nowhere in the sources'),
      claim('b', chunkIds[0]!, null),
      claim('c', null, 'the first to measure the force of gravity'),
      claim('d', 'nope', 'the first to measure the force of gravity'),
    ];
    for (const a of attempts) {
      const r = corpus.verify(a);
      expect(r.status).toBe('unverified');
    }
    // Positive control: the same corpus DOES verify a genuine quote.
    expect(
      corpus.verify(claim('real', chunkIds[0]!, 'the first to measure the force of gravity between masses')).status,
    ).toBe('verified');
  });
});
