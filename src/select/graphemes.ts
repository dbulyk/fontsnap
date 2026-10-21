// Copied shape of the preview gate in src/shared/graphemes.ts. select.js cannot import a shared module.
export const MAX_PREVIEW_GRAPHEMES = 100;
/** Hostile-input size bound in UTF-16 code units (matches messages.ts). Over → empty, never truncate. */
export const CAPTURE_TEXT_UNITS = 2000;

export function graphemeCount(text: string): number {
  let count = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
    if (part.segment.length === 0) continue;
    count += 1;
    if (count > MAX_PREVIEW_GRAPHEMES) return count;
  }
  return count;
}

export function fitsPreview(text: string): string {
  return graphemeCount(text) > MAX_PREVIEW_GRAPHEMES ? '' : text;
}
