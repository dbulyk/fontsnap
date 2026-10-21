import { describe, expect, it } from 'vitest';
import { MAX_PREVIEW_GRAPHEMES } from '../../src/shared/graphemes';
import { insertionFits, isInsertInputType } from '../../src/shared/preview-limit';

describe('insertionFits', () => {
  it('rejects a mid-string insert when the field is already full', () => {
    const value = 'a'.repeat(MAX_PREVIEW_GRAPHEMES);
    expect(insertionFits(value, 10, 10, 'x')).toBe(false);
  });

  it('allows replace of a selection that frees enough room', () => {
    const value = 'a'.repeat(MAX_PREVIEW_GRAPHEMES);
    expect(insertionFits(value, 0, 5, 'xyz')).toBe(true);
    expect(insertionFits(value, 0, 2, 'xyz')).toBe(false);
  });

  it('counts grapheme clusters, not UTF-16 units', () => {
    const family = '👨‍👩‍👧‍👦';
    const value = family.repeat(MAX_PREVIEW_GRAPHEMES);
    expect(insertionFits(value, value.length, value.length, 'x')).toBe(false);
    expect(insertionFits(family.repeat(MAX_PREVIEW_GRAPHEMES - 1), 0, 0, family)).toBe(true);
  });

  it('allows a combining mark that merges into an existing grapheme at the limit', () => {
    const value = 'e'.repeat(MAX_PREVIEW_GRAPHEMES);
    expect(insertionFits(value, MAX_PREVIEW_GRAPHEMES, MAX_PREVIEW_GRAPHEMES, '\u0301')).toBe(true);
    expect(
      insertionFits(
        'क'.repeat(MAX_PREVIEW_GRAPHEMES),
        MAX_PREVIEW_GRAPHEMES,
        MAX_PREVIEW_GRAPHEMES,
        'ि',
      ),
    ).toBe(true);
  });

  it('rejects a letter that splits a ZWJ family even when kept+data counts look fine', () => {
    const family = '👨‍👩‍👧';
    // One family (1 grapheme). Inserting "x" between man and ZWJ yields 3 graphemes.
    const value = family;
    const zwjAt = value.indexOf('\u200D');
    expect(insertionFits(value, zwjAt, zwjAt, 'x', 1)).toBe(false);
    expect(insertionFits(value, zwjAt, zwjAt, 'x', 3)).toBe(true);
  });
});

describe('isInsertInputType', () => {
  it('gates the insert kinds that can grow the field', () => {
    expect(isInsertInputType('insertText')).toBe(true);
    expect(isInsertInputType('insertFromPaste')).toBe(true);
    expect(isInsertInputType('insertFromDrop')).toBe(true);
    expect(isInsertInputType('deleteContentBackward')).toBe(false);
    expect(isInsertInputType('insertCompositionText')).toBe(false);
  });
});
