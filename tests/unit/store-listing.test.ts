import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES = readdirSync('public/_locales').sort();
const GRAPHICS = 'store/graphics';

// Words the Chrome Web Store policy and our listing rules keep out of every language's listing.
const FORBIDDEN =
  /(?<![\p{L}\p{N}])(?:free|open[- ]source|best|#1|premium|recommended|instant|seconds|telegram)(?![\p{L}\p{N}])/iu;

function description(locale: string): string {
  return readFileSync(`store/description_${locale}.txt`, 'utf8');
}

function manifestTexts(locale: string): string[] {
  const messages = JSON.parse(
    readFileSync(`public/_locales/${locale}/messages.json`, 'utf8'),
  ) as Record<string, { message: string } | undefined>;
  return ['appName', 'appDesc'].map((key) => messages[key]?.message ?? '');
}

function pngs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pngs(path);
    return entry.name.endsWith('.png') ? [path] : [];
  });
}

/** Width and height from the IHDR chunk. */
function pngSize(path: string): [number, number] {
  const bytes = readFileSync(path);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/** `name_1280x800.png` → 1280×800; a square asset such as `logo512.png` or `icon128_….png` → 512×512. */
function sizeInName(name: string): [number, number] | undefined {
  const pair = /_(\d+)x(\d+)\.png$/.exec(name);
  if (pair) return [Number(pair[1]), Number(pair[2])];
  const square = /^[a-z]+(\d+)(?:_|\.png$)/.exec(name);
  return square ? [Number(square[1]), Number(square[1])] : undefined;
}

describe('Chrome Web Store listing', () => {
  it.each(LOCALES)('%s has a long description of at most 16,000 characters', (locale) => {
    const text = description(locale).trim();
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(16_000);
  });

  it.each(LOCALES)('%s: name, short and long description avoid forbidden claims', (locale) => {
    for (const text of [...manifestTexts(locale), description(locale)]) {
      expect(FORBIDDEN.exec(text)?.[0]).toBeUndefined();
    }
  });

  it('has no description for a locale the package does not have', () => {
    const described = readdirSync('store')
      .flatMap((name) => /^description_(.+)\.txt$/.exec(name)?.[1] ?? [])
      .sort();
    expect(described).toEqual(LOCALES);
  });

  it.each(pngs(GRAPHICS))('%s has its size in the name and is under 800 KB', (path) => {
    const name = path.split('/').at(-1) ?? '';
    expect(sizeInName(name), 'size in the file name').toEqual(pngSize(path));
    expect(statSync(path).size).toBeLessThan(800 * 1024);
  });

  it('the forbidden-word check matches whole words only', () => {
    expect(FORBIDDEN.test('Free font finder')).toBe(true);
    expect(FORBIDDEN.test('the #1 tool')).toBe(true);
    expect(FORBIDDEN.test('open-source')).toBe(true);
    expect(FORBIDDEN.test('kies een afbeeldingsbestand')).toBe(false);
    expect(FORBIDDEN.test('freely')).toBe(false);
  });
});
