import { describe, expect, it } from 'vitest';
import { findUntranslatedText, UNTRANSLATED_ALLOWED } from '../../scripts/lib/html-i18n';
import { PROTOTYPE_NAMES } from './helpers/media';

describe('findUntranslatedText', () => {
  it('accepts text inside data-i18n elements and ignores script/style', () => {
    const html = `<html><head><style>p{}</style></head><body>
      <button data-i18n="a"></button>
      <label data-i18n="b"><span>nested</span></label>
      <script>var x = 1;</script></body></html>`;
    expect(findUntranslatedText(html)).toEqual([]);
  });

  it('reports hardcoded visible text', () => {
    expect(findUntranslatedText('<body><h1>Hello</h1><p data-i18n="a"></p></body>')).toEqual([
      'Hello',
    ]);
  });

  it('reports hardcoded title/placeholder/aria-label attributes', () => {
    expect(
      findUntranslatedText('<body><input placeholder="Type" aria-label="Name" title="T"></body>'),
    ).toEqual(['placeholder="Type"', 'aria-label="Name"', 'title="T"']);
  });

  it('allows a title that comes from data-i18n-title', () => {
    expect(findUntranslatedText('<body><i data-i18n-title="k" title="x"></i></body>')).toEqual([]);
  });
});

describe('placeholders from data-i18n-ph', () => {
  it('allows a placeholder that is replaced from the locale at run time', () => {
    expect(
      findUntranslatedText('<body><input data-i18n-ph="k" placeholder="English"></body>'),
    ).toEqual([]);
  });

  it('still reports a placeholder without data-i18n-ph, and other attributes with it', () => {
    expect(findUntranslatedText('<body><input placeholder="English"></body>')).toEqual([
      'placeholder="English"',
    ]);
    expect(
      findUntranslatedText('<body><input data-i18n-ph="k" aria-label="Name" title="T"></body>'),
    ).toEqual(['aria-label="Name"', 'title="T"']);
  });
});

// The markup of FontSnap's pages has a few strings that are not translated by design: the product name, glyphs
// drawn in a mock-up of the browser toolbar and the numbers of a numbered list. They are allowed per page, by exact text.
describe('UNTRANSLATED_ALLOWED: exact strings, per page', () => {
  it('lists the two pages and nothing else', () => {
    expect(
      Object.fromEntries(
        [...UNTRANSLATED_ALLOWED].map(([page, texts]) => [page, [...texts].sort()]),
      ),
    ).toEqual({
      'result/result.html': ['FontSnap'],
      'welcome/welcome.html': ['1', '2', '3', '4', 'FontSnap', '⋮', '📌'],
    });
  });

  it('lets exactly those strings through on their page', () => {
    const html = '<body><h1>FontSnap</h1><b>⋮</b></body>';
    expect(findUntranslatedText(html)).toEqual(['FontSnap', '⋮']);
    expect(findUntranslatedText(html, 'welcome/welcome.html')).toEqual([]);
    expect(findUntranslatedText(html, 'result/result.html')).toEqual(['⋮']);
  });

  it('still reports any other text, and a near miss of an allowed one, on those pages', () => {
    expect(
      findUntranslatedText(
        '<body><h1>FontSnap!</h1><p>Hello</p><i>5</i></body>',
        'welcome/welcome.html',
      ),
    ).toEqual(['FontSnap!', 'Hello', '5']);
  });

  it.each(PROTOTYPE_NAMES)(
    'does not treat the page name %s as a page with an allowlist',
    (name) => {
      expect(findUntranslatedText('<body><h1>FontSnap</h1></body>', name)).toEqual(['FontSnap']);
    },
  );
});
