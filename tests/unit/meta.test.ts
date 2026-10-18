import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Meta } from '../../src/shared/core/ranker';

// Port of the "meta.json: Google Fonts flags are consistent" test of tests/js/unit/ui.test.mjs. model/meta.json is
// the family table the page ranks with (built by python/fontsnap_ref/build_meta.py); it is a plain file, also
// when the model next to it is only a Git LFS pointer.
const meta = JSON.parse(readFileSync('model/meta.json', 'utf8')) as Meta;
const at = (family: string) => meta.fams.indexOf(family);

describe('model/meta.json', () => {
  it('has parallel tables for every family', () => {
    const n = meta.fams.length;
    for (const table of [meta.display, meta.inGF, meta.category, meta.rank])
      expect(table).toHaveLength(n);
    expect(n).toBe(1845);
    expect(meta.classFam).toHaveLength(3665);
    expect(Math.max(...meta.classFam)).toBe(n - 1);
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
