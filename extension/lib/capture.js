// Pure helpers for the capture → crop → session handoff (unit-tested without Chrome).

/** Default chrome.storage.session quota (bytes). */
export const SESSION_QUOTA_BYTES = 10 * 1024 * 1024;

/**
 * Max length of a data URL string stored in session.
 * Leave headroom under the ~10 MiB quota for the key name and JSON wrapper.
 */
export const MAX_DATA_URL_CHARS = Math.floor(SESSION_QUOTA_BYTES * 0.75);

/**
 * Max raw image bytes accepted before base64 (right-click fetch path).
 * After base64 (~4/3) + data-URL header the payload must still fit MAX_DATA_URL_CHARS.
 */
export const MAX_IMAGE_BYTES = Math.floor((MAX_DATA_URL_CHARS - 64) * 0.75);

/** Longest side after crop encode; matches result.js upload downscale. */
export const MAX_CROP_SIDE = 2400;

export const MIN_CROP_PX = 4;

/** JPEG qualities tried (high → low) when a PNG crop still exceeds the session budget. */
export const JPEG_QUALITY_LADDER = [0.92, 0.85, 0.75, 0.6, 0.45];

let captureCounter = 0;

export function validRect(r) {
  return Boolean(r) && [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) && r.w > 0 && r.h > 0;
}

/**
 * Map a CSS-viewport rect (+ devicePixelRatio) onto bitmap pixels, clipped to the bitmap.
 * @throws {Error} when the clipped size is below MIN_CROP_PX (outside the visible area)
 */
export function clipCropRect(rect, dpr, bmpWidth, bmpHeight) {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const x = Math.max(0, Math.round(rect.x * scale));
  const y = Math.max(0, Math.round(rect.y * scale));
  const w = Math.min(Math.round((rect.w + Math.min(0, rect.x)) * scale), bmpWidth - x);
  const h = Math.min(Math.round((rect.h + Math.min(0, rect.y)) * scale), bmpHeight - y);
  if (w < MIN_CROP_PX || h < MIN_CROP_PX) throw new Error('Selection is outside the visible area');
  return { x, y, w, h };
}

export function scaleToMaxSide(width, height, maxSide = MAX_CROP_SIDE) {
  const sc = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * sc)),
    height: Math.max(1, Math.round(height * sc)),
    scale: sc,
  };
}

export function fitsSessionQuota(dataUrl, maxChars = MAX_DATA_URL_CHARS) {
  return typeof dataUrl === 'string' && dataUrl.startsWith('data:') && dataUrl.length <= maxChars;
}

export function assertFitsSessionQuota(dataUrl, maxChars = MAX_DATA_URL_CHARS) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('Invalid image payload');
  }
  if (!fitsSessionQuota(dataUrl, maxChars)) {
    throw new Error('Image too large for temporary storage');
  }
}

/**
 * Encode a crop for session storage: try PNG first, then JPEG quality ladder.
 * @param {(opts: { type: string, quality?: number }) => Promise<string>} encode returns a data URL
 */
export async function encodeWithinSessionQuota(encode, maxChars = MAX_DATA_URL_CHARS) {
  const png = await encode({ type: 'image/png' });
  if (fitsSessionQuota(png, maxChars)) return png;
  for (const quality of JPEG_QUALITY_LADDER) {
    const jpg = await encode({ type: 'image/jpeg', quality });
    if (fitsSessionQuota(jpg, maxChars)) return jpg;
  }
  throw new Error('Image too large for temporary storage');
}

/** Unique chrome.storage.session key; prefers crypto.randomUUID(). */
export function newCaptureId(cryptoObj = globalThis.crypto) {
  if (cryptoObj?.randomUUID) return 'cap_' + cryptoObj.randomUUID();
  captureCounter = (captureCounter + 1) >>> 0;
  return `cap_${Date.now()}_${captureCounter}`;
}

/** @private tests only */
export function _resetCaptureCounterForTests() {
  captureCounter = 0;
}

/** Hash that surfaces an error on result.html without needing session storage. */
export function errorResultHash(message) {
  return 'err=' + encodeURIComponent(String(message || 'Unknown error'));
}

/**
 * Parse result.html location.hash (with or without leading #).
 * @returns {{ kind: 'session', id: string } | { kind: 'error', message: string } | null }
 */
export function parseResultHash(hash) {
  const h = String(hash || '').replace(/^#/, '');
  if (!h) return null;
  if (h.startsWith('err=')) {
    try {
      return { kind: 'error', message: decodeURIComponent(h.slice(4)) };
    } catch {
      return { kind: 'error', message: h.slice(4) };
    }
  }
  return { kind: 'session', id: h };
}

/** Pure plan for openResult after a storage attempt. */
export function planOpenResult({ entry, storeOk, storeError, id }) {
  if (storeOk) return { hash: id, entry };
  const msg = String(storeError?.message || storeError || entry?.error || 'Storage failed');
  return { hash: errorResultHash(msg), entry: { error: msg } };
}
