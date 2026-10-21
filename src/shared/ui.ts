import { sampleOf } from './samples';
import { chooseSample } from './script';

const english = sampleOf('en');
if (english === undefined) throw new Error('missing en sample');

// Small pure helpers for the result page (unit-tested in tests/unit/ui.test.ts).
export const DEFAULT_PREVIEW = english.text;

// CSS generic fallback per Google Fonts category. Display faces are mostly decorative/script-like
// (Lobster, Pacifico-style), so they fall back to `cursive` like Handwriting.
const GENERIC = new Map([
  ['Serif', 'serif'],
  ['Sans Serif', 'sans-serif'],
  ['Monospace', 'monospace'],
  ['Handwriting', 'cursive'],
  ['Display', 'cursive'],
]);
export const genericFamily = (category: string): string => GENERIC.get(category) ?? 'sans-serif';

export const cssFontFamily = (name: string, category: string): string =>
  `font-family: '${name.replace(/'/g, "\\'")}', ${genericFamily(category)};`;

// Typed text wins. Page text uses the 100-grapheme gate inside chooseSample. Otherwise English.
export function previewText(
  typed: string | null | undefined,
  selected: string | null | undefined,
): string {
  return chooseSample({ typed, pageText: selected }).text;
}

// Display filter. The ranker always returns k candidates (needed for the top-5 metric), but when the
// model is confident the tail is filled by popular families (the rank^-0.5 prior lifts Roboto/Lato
// over near-zero probabilities) and would show as "0%". Hide anything whose shown percentage rounds
// below `minPct`, always keeping the best candidate.
export const MIN_DISPLAY_PCT = 1;
export function visibleResults<T extends { conf: number }>(
  list: readonly T[],
  minPct = MIN_DISPLAY_PCT,
): T[] {
  if (list.length === 0) return [];
  return list.filter((r, i) => i === 0 || Math.round(r.conf * 100) >= minPct);
}

/**
 * The score shown on a result card: the rounded percentage with an ASCII "%", the same in every UI
 * language (it has always been shown this way). Kept as a function so that the score is a computed value,
 * not UI text typed into the page.
 */
export const percentLabel = (conf: number): string => `${Math.round(conf * 100)}%`;
