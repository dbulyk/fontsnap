import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UNKNOWN_SUBSETS, type Meta } from '../../src/shared/core/ranker';

// Port of the "meta.json: Google Fonts flags are consistent" test of tests/js/unit/ui.test.mjs. model/meta.json is
// the family table the page ranks with (built by python/fontsnap_ref/build_meta.py); it is a plain file, also
// when the model next to it is only a Git LFS pointer.
const meta = JSON.parse(readFileSync('model/meta.json', 'utf8')) as Meta;
const at = (family: string) => meta.fams.indexOf(family);

describe('model/meta.json', () => {
  it('has parallel tables for every family', () => {
    const n = meta.fams.length;
    for (const table of [
      meta.display,
      meta.inGF,
      meta.category,
      meta.rank,
      meta.script,
      meta.subsets,
    ])
      expect(table).toHaveLength(n);
    expect(n).toBe(1845);
    expect(meta.classFam).toHaveLength(3665);
    expect(Math.max(...meta.classFam)).toBe(n - 1);
    expect(meta.subsetNames).toEqual([
      'latin',
      'latin-ext',
      'vietnamese',
      'cyrillic',
      'greek',
      'arabic',
      'hebrew',
      'devanagari',
      'bengali',
      'tamil',
      'telugu',
      'gujarati',
      'kannada',
      'malayalam',
      'thai',
      'ethiopic',
      'japanese',
      'korean',
      'chinese-simplified',
      'chinese-traditional',
      'chinese-hongkong',
    ]);
  });

  it('records primaryScript and subset bits, or marks the family unknown', () => {
    const bit = (name: string) => 1 << meta.subsetNames.indexOf(name);
    const mask = (family: string) => meta.subsets[at(family)] ?? 0;
    expect(meta.script[at('roboto')]).toBe('');
    expect(mask('roboto') & bit('cyrillic')).not.toBe(0);
    expect(mask('roboto') & bit('greek')).not.toBe(0);
    expect(mask('roboto') & bit('vietnamese')).not.toBe(0);
    expect(mask('outfit') & bit('cyrillic')).toBe(0);
    expect(mask('outfit') & bit('latin')).not.toBe(0);
    expect(mask('outfit') & bit('latin-ext')).not.toBe(0);
    expect(meta.script[at('amiri')]).toBe('Arab');
    expect(mask('amiri') & bit('arabic')).not.toBe(0);
    expect(meta.script[at('notosansjp')]).toBe('Jpan');
    expect(mask('notosansjp') & bit('japanese')).not.toBe(0);
    expect(meta.subsets[at('adobeblank')]).toBe(UNKNOWN_SUBSETS);
    expect(meta.script[at('adobeblank')]).toBe('');
    expect(meta.inGF[at('pushster')]).toBe(true);
    expect(meta.subsets[at('pushster')]).toBe(UNKNOWN_SUBSETS);
    const unknown = meta.fams.filter((_family, i) => meta.subsets[i] === UNKNOWN_SUBSETS);
    expect(unknown).toHaveLength(74);
    for (const family of unknown) expect(meta.script[at(family)], family).toBe('');
    for (const subsets of meta.subsets) {
      const known =
        subsets === UNKNOWN_SUBSETS || (subsets >= 0 && subsets < 2 ** meta.subsetNames.length);
      expect(known).toBe(true);
    }
  });

  it('flags the Google Fonts families that are known to be there', () => {
    for (const family of ['pushster', 'thabit', 'bigshouldersdisplay', 'sansitaone', 'lobster']) {
      expect(meta.inGF[at(family)], `${family} is on Google Fonts`).toBe(true);
    }
    expect(meta.display[at('pushster')]).toBe('Pushster');
    expect(meta.inGF[at('adobeblank')]).toBe(false);
  });

  it('gives every Google Fonts family a category (it picks the CSS fallback)', () => {
    const withoutCategory = meta.fams.filter((_family, i) => meta.inGF[i] && !meta.category[i]);
    expect(withoutCategory).toEqual([]);
  });

  it('has a positive popularity rank for every family (the prior is rank^-0.5)', () => {
    expect(meta.rank.every((rank) => rank > 0)).toBe(true);
  });
});
