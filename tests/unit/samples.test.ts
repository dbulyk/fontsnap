import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIGITS, SAMPLES, sampleOf, type ScriptCode } from '../../src/shared/samples';
import { PROTOTYPE_NAMES } from './helpers/media';

const SCRIPT_PROP = new Map<ScriptCode, string[]>([
  ['Latn', ['Latin']],
  ['Cyrl', ['Cyrillic']],
  ['Grek', ['Greek']],
  ['Arab', ['Arabic']],
  ['Hebr', ['Hebrew']],
  ['Deva', ['Devanagari']],
  ['Beng', ['Bengali']],
  ['Taml', ['Tamil']],
  ['Telu', ['Telugu']],
  ['Gujr', ['Gujarati']],
  ['Knda', ['Kannada']],
  ['Mlym', ['Malayalam']],
  ['Thai', ['Thai']],
  ['Ethi', ['Ethiopic']],
  ['Jpan', ['Hiragana', 'Katakana', 'Han']],
  ['Kore', ['Hangul']],
  ['Hans', ['Han']],
  ['Hant', ['Han']],
]);

describe('SAMPLES', () => {
  const locales = readdirSync('public/_locales').filter((n) => !n.startsWith('.'));

  it('has exactly the 55 public/_locales keys', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...locales].sort());
    expect(locales).toHaveLength(55);
  });

  it('keeps each text in its declared script (≥90% letters) and ≤120 chars', () => {
    for (const [locale, { script, text }] of Object.entries(SAMPLES)) {
      expect(text.normalize('NFC'), locale).toBe(text);
      expect(text.length, locale).toBeLessThanOrEqual(120);
      const props = SCRIPT_PROP.get(script) ?? [];
      const letterRe = /\p{L}|\p{M}/u;
      let letters = 0;
      let matched = 0;
      for (const ch of text) {
        if (!letterRe.test(ch)) continue;
        letters++;
        if (props.some((p) => new RegExp(`^\\p{Script=${p}}$`, 'u').test(ch))) matched++;
      }
      expect(letters, locale).toBeGreaterThan(0);
      expect(matched / letters, locale).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('uses the fixed digit line', () => {
    expect(DIGITS).toBe('0123456789');
  });

  it('keeps the Malayalam joiner from the source and ignores prototype names', () => {
    expect(SAMPLES.ml.text.endsWith('\u200c.')).toBe(true);
    expect(SAMPLES.en.text).toBe('The quick brown fox jumps over the lazy dog');
    expect(SAMPLES.ru.text).toBe('Съешь же ещё этих мягких французских булок, да выпей чаю');
    expect(SAMPLES.fa.text).toContain('می‌آیند');
    expect(SAMPLES.zh_CN.text).not.toBe(SAMPLES.zh_TW.text);
    expect(SAMPLES.en.text).toBe(SAMPLES.en_GB.text);
    for (const name of PROTOTYPE_NAMES) expect(sampleOf(name), name).toBeUndefined();
  });
});
