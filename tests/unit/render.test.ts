import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, GOOGLE_FONTS_LABEL } from '../../src/result/render';
import type { RankedFont } from '../../src/shared/core/ranker';
import { createChromeStub } from './helpers/chrome-stub';
import { must } from './helpers/dom';

const font = (over: Partial<RankedFont> = {}): RankedFont => ({
  key: 'roboto',
  name: 'Roboto',
  inGF: true,
  category: 'Sans Serif',
  score: 0.6,
  conf: 0.593,
  ...over,
});

let win: Window;
let document: Document;
let ol: HTMLElement;
let render: ReturnType<typeof createRenderer>;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createChromeStub().install();
  win = new Window();
  document = win.document as unknown as Document;
  document.body.innerHTML = '<ol id="results"></ol>';
  ol = must(document.getElementById('results'), '#results');
  writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.useFakeTimers();
  render = createRenderer(document);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  void win.happyDOM.close();
});

describe('a result card', () => {
  it('has the same structure as before: name, score, bar, sample, category and actions', () => {
    render([font()], 'Sample');
    const li = ol.querySelector('li');
    expect(ol.children).toHaveLength(1);
    const rows = li?.querySelectorAll(':scope > .row');
    expect(rows).toHaveLength(2);
    expect(li?.querySelector('.name')?.textContent).toBe('1. Roboto');
    const metas = li?.querySelectorAll('.meta') ?? [];
    expect(metas).toHaveLength(2);
    expect(metas[0]?.textContent).toBe('59%');
    expect(metas[0]?.getAttribute('title')).toBe('Relative score among the top 5');
    expect(metas[1]?.textContent).toBe('Sans Serif');
    expect(must(li?.querySelector<HTMLElement>('.bar i')).style.width).toBe('59.3%');
    expect(li?.querySelector('.sample')?.textContent).toBe('Sample');
    expect(li?.querySelectorAll(':scope > div').length).toBe(4);
    expect(li?.querySelector('.acts')?.children).toHaveLength(2);
  });

  it('numbers the cards and rounds the percentage', () => {
    render(
      [
        font(),
        font({ name: 'Lato', key: 'lato', conf: 0.2049 }),
        font({ name: 'Inter', key: 'inter', conf: 0.2004 }),
      ],
      'x',
    );
    expect([...ol.querySelectorAll('.name')].map((e) => e.textContent)).toEqual([
      '1. Roboto',
      '2. Lato',
      '3. Inter',
    ]);
    expect([...ol.querySelectorAll('.row:first-child .meta')].map((e) => e.textContent)).toEqual([
      '59%',
      '20%',
      '20%',
    ]);
  });

  it('keeps the bar visible even for a tiny score (at least 2% wide)', () => {
    render([font({ conf: 0.6 }), font({ name: 'One', conf: 0.012 })], 'x');
    const bars = [...ol.querySelectorAll<HTMLElement>('.bar i')].map((e) => e.style.width);
    expect(bars).toEqual(['60%', '2%']);
  });

  it('hides results below 1% but always keeps the best one', () => {
    render(
      [font({ conf: 0.99 }), font({ name: 'A', conf: 0.004 }), font({ name: 'B', conf: 0.002 })],
      'x',
    );
    expect(ol.children).toHaveLength(1);
    render([font({ conf: 0.004 }), font({ name: 'A', conf: 0.003 })], 'x');
    expect(ol.children).toHaveLength(1);
  });

  it('replaces the previous results on every render', () => {
    render([font(), font({ name: 'Lato' })], 'x');
    render([font({ name: 'Inter' })], 'y');
    expect([...ol.querySelectorAll('.name')].map((e) => e.textContent)).toEqual(['1. Inter']);
  });

  it('shows the preview text with the CSS fallback of the category', () => {
    const cases: [string, string][] = [
      ['Serif', 'serif'],
      ['Sans Serif', 'sans-serif'],
      ['Monospace', 'monospace'],
      ['Handwriting', 'cursive'],
      ['Display', 'cursive'],
      ['', 'sans-serif'],
    ];
    for (const [category, generic] of cases) {
      render([font({ category })], 'Hi');
      const sample = ol.querySelector<HTMLElement>('.sample');
      // happy-dom may drop the quotes around the family name when it normalizes the value
      expect(sample?.style.fontFamily, category).toMatch(new RegExp(`^'?Roboto'?, ${generic}$`));
    }
  });

  it('shows "not on Google Fonts" only for families outside Google Fonts without a category', () => {
    render([font({ inGF: false, category: '' })], 'x');
    const metas = ol.querySelectorAll('.meta');
    expect(metas[1]?.textContent).toBe('not on Google Fonts');
    expect(ol.querySelector('.acts a')).toBeNull();
    expect(document.head.querySelector('link')).toBeNull();
    render([font({ inGF: true, category: '' })], 'x');
    expect(ol.querySelectorAll('.meta')[1]?.textContent).toBe('');
    render([font({ inGF: false, category: 'Display' })], 'x');
    expect(ol.querySelectorAll('.meta')[1]?.textContent).toBe('Display');
  });
});

describe('links and fonts', () => {
  it('links to the Google Fonts specimen, safely', () => {
    render([font({ name: 'Open Sans' })], 'x');
    const a = must(ol.querySelector<HTMLAnchorElement>('.acts a'), 'link');
    expect(a.getAttribute('href')).toBe('https://fonts.google.com/specimen/Open+Sans');
    expect(a.target).toBe('_blank');
    expect(a.rel).toBe('noopener');
    expect(a.textContent).toBe(GOOGLE_FONTS_LABEL);
    expect(GOOGLE_FONTS_LABEL).toBe('Google Fonts ↗');
  });

  it('loads each Google Fonts family once, by name only (never the preview text)', () => {
    render([font({ name: 'Open Sans' }), font({ name: 'Roboto', key: 'r2' })], 'secret page text');
    render([font({ name: 'Open Sans' })], 'other text');
    const hrefs = [...document.head.querySelectorAll('link')].map((l) => l.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://fonts.googleapis.com/css2?family=Open+Sans&display=swap',
      'https://fonts.googleapis.com/css2?family=Roboto&display=swap',
    ]);
    expect(hrefs.join()).not.toContain('secret');
    expect(document.head.querySelector('link')?.getAttribute('rel')).toBe('stylesheet');
  });

  it('encodes unusual family names', () => {
    render([font({ name: 'Press Start 2P & Co' })], 'x');
    expect(document.head.querySelector('link')?.getAttribute('href')).toBe(
      'https://fonts.googleapis.com/css2?family=Press+Start+2P+%26+Co&display=swap',
    );
  });
});

describe('copy CSS', () => {
  it('copies the font-family declaration and flashes "Copied" for 1.2 s', async () => {
    render([font({ name: "Fo'o", category: 'Serif' })], 'x');
    const button = must(ol.querySelector('button'), 'button');
    expect(button.textContent).toBe('Copy CSS');
    button.click();
    expect(writeText).toHaveBeenCalledExactlyOnceWith("font-family: 'Fo\\'o', serif;");
    await vi.advanceTimersByTimeAsync(0);
    expect(button.textContent).toBe('Copied');
    await vi.advanceTimersByTimeAsync(1199);
    expect(button.textContent).toBe('Copied');
    await vi.advanceTimersByTimeAsync(1);
    expect(button.textContent).toBe('Copy CSS');
  });
});
