import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREVIEW,
  MIN_DISPLAY_PCT,
  cssFontFamily,
  genericFamily,
  percentLabel,
  previewText,
  visibleResults,
} from '../../src/shared/ui';

describe('generic font family fallback', () => {
  it('follows the Google Fonts category', () => {
    expect(genericFamily('Serif')).toBe('serif');
    expect(genericFamily('Sans Serif')).toBe('sans-serif');
    expect(genericFamily('Monospace')).toBe('monospace');
    expect(genericFamily('Handwriting')).toBe('cursive');
    expect(genericFamily('Display')).toBe('cursive');
    expect(genericFamily('')).toBe('sans-serif');
    expect(cssFontFamily('Lobster', 'Display')).toBe("font-family: 'Lobster', cursive;");
    expect(cssFontFamily('Roboto Mono', 'Monospace')).toBe(
      "font-family: 'Roboto Mono', monospace;",
    );
  });

  it('answers sans-serif for names inherited from Object.prototype', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(genericFamily(name), name).toBe('sans-serif');
    }
  });

  it('escapes single quotes in the family name', () => {
    expect(cssFontFamily("Fo'o", 'Serif')).toBe("font-family: 'Fo\\'o', serif;");
  });
});

describe('preview text', () => {
  it('prefers typed text, then selected text, then the pangram', () => {
    expect(previewText('  Hello ', 'page text')).toBe('Hello');
    expect(previewText('', '  Big\n  Title ')).toBe('Big Title');
    expect(previewText('', '')).toBe(DEFAULT_PREVIEW);
    expect(previewText(undefined, 'x'.repeat(100))).toBe('x'.repeat(100));
    expect(previewText(undefined, 'x'.repeat(101))).toBe(DEFAULT_PREVIEW);
    expect(previewText(undefined, 'x'.repeat(200))).toBe(DEFAULT_PREVIEW);
  });

  it('treats missing values as empty', () => {
    expect(previewText(undefined, undefined)).toBe(DEFAULT_PREVIEW);
    expect(previewText(null, null)).toBe(DEFAULT_PREVIEW);
  });
});

describe('visibleResults', () => {
  const c = (conf: number, name: string) => ({ name, conf });

  it('hides ~0% padding, keeps the best one', () => {
    const confident = [
      c(0.99, 'UnifrakturMaguntia'),
      c(0.004, 'Roboto'),
      c(0.002, 'Inconsolata'),
      c(0.001, 'Lato'),
      c(0.001, 'Open Sans'),
    ];
    expect(visibleResults(confident).map((r) => r.name)).toEqual(['UnifrakturMaguntia']);
    const mixed = [c(0.5, 'A'), c(0.3, 'B'), c(0.15, 'C'), c(0.045, 'D'), c(0.004, 'E')];
    expect(visibleResults(mixed).map((r) => r.name)).toEqual(['A', 'B', 'C', 'D']);
    // 0.5% rounds to 1% -> shown; boundary follows the displayed (rounded) value
    expect(visibleResults([c(0.9, 'A'), c(0.005, 'B')])).toHaveLength(2);
    // best candidate always kept even if its own score is tiny
    expect(visibleResults([c(0, 'A'), c(0, 'B')])).toHaveLength(1);
    expect(visibleResults([])).toEqual([]);
    expect(MIN_DISPLAY_PCT).toBe(1);
  });

  it('accepts a custom threshold', () => {
    expect(visibleResults([c(0.9, 'A'), c(0.05, 'B')], 10).map((r) => r.name)).toEqual(['A']);
  });
});

describe('percentLabel', () => {
  it('rounds the score to a whole percent with an ASCII percent sign', () => {
    expect(percentLabel(0.593)).toBe('59%');
    expect(percentLabel(0.995)).toBe('100%');
    expect(percentLabel(0.005)).toBe('1%');
    expect(percentLabel(0.0049)).toBe('0%');
    expect(percentLabel(0)).toBe('0%');
  });
});
