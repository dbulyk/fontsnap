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

// Status line. On the first run the model load time is included in the total and shown separately.
export function timingText(analysisMs, modelLoadMs) {
  const a = Math.round(analysisMs);
  if (!(modelLoadMs > 0)) return `Done in ${a} ms`;
  const m = Math.round(modelLoadMs);
  return `Done in ${a + m} ms (model load ${m} ms + analysis ${a} ms)`;
}
