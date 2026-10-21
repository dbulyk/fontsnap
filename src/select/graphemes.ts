// Copied in src/shared/graphemes.ts. select.js cannot import a shared module.
export const MAX_PREVIEW_GRAPHEMES = 100;

export function graphemeCount(text: string): number {
  let count = 0;
  for (const part of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) {
    if (part.segment.length === 0) continue;
    count += 1;
    if (count > MAX_PREVIEW_GRAPHEMES) return count;
  }
  return count;
}

export function fitsPreview(text: string): string {
  return graphemeCount(text) > MAX_PREVIEW_GRAPHEMES ? '' : text;
}
