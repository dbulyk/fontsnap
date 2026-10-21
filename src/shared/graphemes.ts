// Same limit as src/select/graphemes.ts. The overlay runs in the page and cannot import this file.
export const MAX_PREVIEW_GRAPHEMES = 100;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Number of extended grapheme clusters in `text`. */
export function graphemeCount(text: string): number {
  let count = 0;
  for (const { segment } of segmenter.segment(text)) {
    if (segment) count++;
  }
  return count;
}

/** Leading graphemes of `text`, never splitting a cluster. */
export function sliceGraphemes(text: string, max: number): string {
  if (max <= 0) return '';
  let n = 0;
  let end = 0;
  for (const { index, segment } of segmenter.segment(text)) {
    if (n >= max) break;
    end = index + segment.length;
    n++;
  }
  return text.slice(0, end);
}

/**
 * One post-capture gate for the preview field: empty or longer than MAX_PREVIEW_GRAPHEMES → empty
 * field (the cards then show the automatic sample). Otherwise the trimmed value.
 */
export function fieldFromCapture(raw: string | null | undefined): string {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (graphemeCount(s) > MAX_PREVIEW_GRAPHEMES) return '';
  return s;
}

/** Empty or over-long capture becomes `fallback`. The preview field uses fieldFromCapture so it can stay empty. */
export function acceptCapturedText(raw: string | null | undefined, fallback: string): string {
  const field = fieldFromCapture(raw);
  return field === '' ? fallback : field;
}

/** Accept text at or under the preview grapheme limit; otherwise empty. */
export function fitsPreview(text: string): string {
  return graphemeCount(text) > MAX_PREVIEW_GRAPHEMES ? '' : text;
}
