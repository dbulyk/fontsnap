// Small pure helpers for result.js (unit-tested in tests/js/unit/ui.test.mjs).
export const DEFAULT_PREVIEW = 'The quick brown fox jumps over the lazy dog';

// CSS generic fallback per Google Fonts category. Display faces are mostly decorative/script-like
// (Lobster, Pacifico-style), so they fall back to `cursive` like Handwriting.
const GENERIC = { Serif: 'serif', 'Sans Serif': 'sans-serif', Monospace: 'monospace', Handwriting: 'cursive', Display: 'cursive' };
export const genericFamily = (category) => GENERIC[category] || 'sans-serif';

export const cssFontFamily = (name, category) => `font-family: '${String(name).replace(/'/g, "\\'")}', ${genericFamily(category)};`;

// Preview sample: user-typed text, else text found under the selection, else the pangram.
export function previewText(typed, selected) {
  const t = String(typed ?? '').trim();
  if (t) return t;
  const s = String(selected ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, 80) : DEFAULT_PREVIEW;
}

// Display filter. The ranker always returns k candidates (needed for the top-5 metric), but when the
// model is confident the tail is filled by popular families (the rank^-0.5 prior lifts Roboto/Lato
// over near-zero probabilities) and would show as "0%". Hide anything whose shown percentage rounds
// below `minPct`, always keeping the best candidate.
export const MIN_DISPLAY_PCT = 1;
export function visibleResults(list, minPct = MIN_DISPLAY_PCT) {
  if (!Array.isArray(list) || !list.length) return [];
  return list.filter((r, i) => i === 0 || Math.round(r.conf * 100) >= minPct);
}
