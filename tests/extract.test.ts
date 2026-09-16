import { describe, expect, it } from 'vitest';
import {
  bodyToText,
  decodeEntities,
  dropLinkRuns,
  extractMainRegion,
  extractTitle,
  htmlToText,
} from '../src/lib/extract';

describe('html extraction', () => {
  it('should drop script, style and navigation content', () => {
    const html = '<nav>Home About</nav><script>alert(1)</script><style>p{color:red}</style><p>Real body text.</p>';
    const text = htmlToText(html);
    expect(text).toContain('Real body text.');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('Home About');
  });

  it('should turn block ends into paragraph breaks', () => {
    expect(htmlToText('<p>One.</p><p>Two.</p>')).toBe('One.\n\nTwo.');
  });

  it('should decode the entities that occur in body text', () => {
    expect(decodeEntities('Tom &amp; Jerry &mdash; &quot;hi&quot; &#65; &#x42;')).toBe('Tom & Jerry — "hi" A B');
  });

  it('should leave an unknown entity untouched rather than mangling it', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
  });

  it('should collapse runs of whitespace and blank lines', () => {
    expect(htmlToText('<p>a   b</p>\n\n\n\n<p>c</p>')).toBe('a b\n\nc');
  });

  it('should extract a page title', () => {
    expect(extractTitle('<html><head><title>  Cavendish   experiment </title></head></html>')).toBe('Cavendish experiment');
    expect(extractTitle('<html><body>no title</body></html>')).toBeNull();
  });

  it('should return an empty string for empty html', () => {
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<div></div>')).toBe('');
  });

  it('should pass plain text and markdown through untouched apart from line endings', () => {
    expect(bodyToText('# Heading\r\n\r\nBody <not html>.', 'text/markdown')).toBe('# Heading\n\nBody <not html>.');
    expect(bodyToText('<p>x</p>', 'text/html; charset=utf-8')).toBe('x');
  });
});

describe('main content region', () => {
  it('should narrow to <main> when the page declares one', () => {
    const body = `<p>${'Real article prose. '.repeat(40)}</p>`;
    const html = `<html><body><div>Site chrome everywhere</div><main>${body}</main></body></html>`;
    expect(extractMainRegion(html)).toContain('Real article prose');
    expect(extractMainRegion(html)).not.toContain('Site chrome');
  });

  it('should match greedily so nested same-tag content is not truncated', () => {
    const filler = 'Article body text that is long enough to clear the guard. '.repeat(15);
    const html = `<main><section>${filler}</section><section>Final section marker.</section></main>`;
    expect(extractMainRegion(html)).toContain('Final section marker.');
  });

  it('should fall back to the whole document rather than returning a stub', () => {
    // A <main> that wraps almost nothing must not empty the corpus.
    const html = `<html><body><main>tiny</main><div>${'The real content lives here. '.repeat(40)}</div></body></html>`;
    expect(extractMainRegion(html)).toContain('The real content lives here');
  });

  it('should fall back to the raw html when there is no landmark at all', () => {
    expect(extractMainRegion('<p>no landmarks</p>')).toBe('<p>no landmarks</p>');
  });

  it('should strip site chrome from a real Wikipedia-shaped page', () => {
    const filler = 'The torsion spring stores mechanical energy when twisted. '.repeat(20);
    const html = `<html><body><nav>Jump to content</nav><main><p>${filler}</p></main><footer>Privacy policy</footer></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('torsion spring stores mechanical energy');
    expect(text).not.toContain('Jump to content');
    expect(text).not.toContain('Privacy policy');
  });
});

describe('link-run filter', () => {
  it('should drop a run of short unpunctuated blocks', () => {
    const input = ['18 languages', 'Deutsch', 'Espanol', 'Francais', 'Русский', 'Real prose sentence here.'].join('\n\n');
    const out = dropLinkRuns(input);
    expect(out).toBe('Real prose sentence here.');
  });

  it('should keep a short run, which is more likely to be real headings', () => {
    const input = ['Overview', 'Method', 'Results and a full sentence about them.'].join('\n\n');
    expect(dropLinkRuns(input)).toBe(input);
  });

  it('should never drop prose, however short the paragraph', () => {
    const input = ['It worked.', 'It failed.', 'It worked.', 'It failed.', 'Conclusion follows.'].join('\n\n');
    // Every block ends in a full stop, so none of them looks like a link.
    expect(dropLinkRuns(input)).toBe(input);
  });

  it('should leave text with no link runs untouched', () => {
    const input = 'A full paragraph of prose.\n\nAnother full paragraph of prose.';
    expect(dropLinkRuns(input)).toBe(input);
  });
});
