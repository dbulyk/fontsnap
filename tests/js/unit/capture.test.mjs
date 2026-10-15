import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../../scripts/lib/evaljs.mjs';
import {
  MAX_CROP_SIDE,
  MAX_DATA_URL_CHARS,
  MAX_IMAGE_BYTES,
  SESSION_QUOTA_BYTES,
  assertFitsSessionQuota,
  clipCropRect,
  errorResultHash,
  newCaptureId,
  parseResultHash,
  planOpenResult,
  scaleToMaxSide,
  validRect,
  _resetCaptureCounterForTests,
} from '../../../extension/lib/capture.js';

const EXT = path.join(ROOT, 'extension');

describe('validRect', () => {
  test('accepts finite positive width/height', () => {
    assert.equal(validRect({ x: 0, y: 0, w: 10, h: 8 }), true);
    assert.equal(validRect({ x: -5, y: 1.5, w: 20, h: 3 }), true);
  });

  test('rejects missing, non-finite, or non-positive size', () => {
    assert.equal(validRect(null), false);
    assert.equal(validRect(undefined), false);
    assert.equal(validRect({ x: 0, y: 0, w: 0, h: 10 }), false);
    assert.equal(validRect({ x: 0, y: 0, w: 10, h: -1 }), false);
    assert.equal(validRect({ x: NaN, y: 0, w: 10, h: 10 }), false);
    assert.equal(validRect({ x: 0, y: Infinity, w: 10, h: 10 }), false);
    assert.equal(validRect({ x: 0, y: 0, w: 10 }), false);
  });
});

describe('clipCropRect', () => {
  test('scales CSS rect by dpr and clips to bitmap', () => {
    assert.deepEqual(clipCropRect({ x: 10, y: 20, w: 30, h: 40 }, 2, 200, 200), {
      x: 20,
      y: 40,
      w: 60,
      h: 80,
    });
  });

  test('clips overflow past the right/bottom edges', () => {
    assert.deepEqual(clipCropRect({ x: 90, y: 90, w: 50, h: 50 }, 1, 100, 100), {
      x: 90,
      y: 90,
      w: 10,
      h: 10,
    });
  });

  test('handles negative origin by shrinking width/height into the visible area', () => {
    // rect starts left of viewport: only the visible portion remains
    assert.deepEqual(clipCropRect({ x: -10, y: 0, w: 30, h: 20 }, 1, 100, 100), {
      x: 0,
      y: 0,
      w: 20,
      h: 20,
    });
  });

  test('throws when the clipped selection is too small / outside the visible area', () => {
    assert.throws(() => clipCropRect({ x: 200, y: 200, w: 10, h: 10 }, 1, 100, 100), /outside the visible area/);
    assert.throws(() => clipCropRect({ x: 0, y: 0, w: 1, h: 1 }, 1, 100, 100), /outside the visible area/);
  });

  test('treats invalid dpr as 1', () => {
    assert.deepEqual(clipCropRect({ x: 5, y: 5, w: 10, h: 10 }, 0, 100, 100), {
      x: 5,
      y: 5,
      w: 10,
      h: 10,
    });
  });
});

describe('scaleToMaxSide', () => {
  test('leaves small images unchanged', () => {
    assert.deepEqual(scaleToMaxSide(800, 600, MAX_CROP_SIDE), { width: 800, height: 600, scale: 1 });
  });

  test('downscales so the long side equals maxSide', () => {
    const r = scaleToMaxSide(4800, 2400, MAX_CROP_SIDE);
    assert.equal(r.width, MAX_CROP_SIDE);
    assert.equal(r.height, MAX_CROP_SIDE / 2);
    assert.ok(r.scale < 1);
  });
});

describe('session quota / payload caps', () => {
  test('MAX_IMAGE_BYTES fits under session quota after base64 expansion', () => {
    assert.ok(SESSION_QUOTA_BYTES >= 10 * 1024 * 1024);
    assert.ok(MAX_DATA_URL_CHARS < SESSION_QUOTA_BYTES);
    // data URL ≈ header + ceil(raw * 4/3); require headroom under MAX_DATA_URL_CHARS
    const approxDataUrl = 32 + Math.ceil(MAX_IMAGE_BYTES * (4 / 3));
    assert.ok(approxDataUrl <= MAX_DATA_URL_CHARS, `raw ${MAX_IMAGE_BYTES} → ~${approxDataUrl} chars vs cap ${MAX_DATA_URL_CHARS}`);
    assert.ok(MAX_IMAGE_BYTES < 25e6, 'legacy 25MB cap must be lowered to match session quota');
  });

  test('assertFitsSessionQuota accepts small data URLs and rejects oversized ones', () => {
    assert.doesNotThrow(() => assertFitsSessionQuota('data:image/png;base64,aaaa'));
    assert.throws(() => assertFitsSessionQuota('not-a-data-url'), /Invalid image payload/);
    const huge = 'data:image/png;base64,' + 'a'.repeat(MAX_DATA_URL_CHARS);
    assert.throws(() => assertFitsSessionQuota(huge), /too large for temporary storage/);
  });
});

describe('newCaptureId', () => {
  test('uses crypto.randomUUID when available', () => {
    const id = newCaptureId({ randomUUID: () => '11111111-2222-3333-4444-555555555555' });
    assert.equal(id, 'cap_11111111-2222-3333-4444-555555555555');
  });

  test('falls back to Date.now()+counter without UUID collisions in the same ms', () => {
    _resetCaptureCounterForTests();
    const a = newCaptureId({});
    const b = newCaptureId({});
    assert.match(a, /^cap_\d+_\d+$/);
    assert.match(b, /^cap_\d+_\d+$/);
    assert.notEqual(a, b);
  });
});

describe('openResult error wrapping helpers', () => {
  test('errorResultHash encodes a message that parseResultHash can recover', () => {
    const hash = errorResultHash('quota exceeded');
    assert.equal(parseResultHash(hash), { kind: 'error', message: 'quota exceeded' });
    assert.equal(parseResultHash('#' + hash), { kind: 'error', message: 'quota exceeded' });
  });

  test('parseResultHash treats normal capture ids as session keys', () => {
    assert.equal(parseResultHash(''), null);
    assert.deepEqual(parseResultHash('cap_abc'), { kind: 'session', id: 'cap_abc' });
  });

  test('planOpenResult keeps the session id on success', () => {
    const entry = { dataUrl: 'data:image/png;base64,xx' };
    assert.deepEqual(planOpenResult({ entry, storeOk: true, id: 'cap_1' }), { hash: 'cap_1', entry });
  });

  test('planOpenResult falls back to an err= hash when storage fails', () => {
    const planned = planOpenResult({
      entry: { dataUrl: 'data:…' },
      storeOk: false,
      storeError: new Error('QUOTA_BYTES quota exceeded'),
      id: 'cap_1',
    });
    assert.equal(planned.hash.startsWith('err='), true);
    assert.equal(planned.entry.error, 'QUOTA_BYTES quota exceeded');
    assert.deepEqual(parseResultHash(planned.hash), {
      kind: 'error',
      message: 'QUOTA_BYTES quota exceeded',
    });
  });
});

describe('background wiring (source contracts)', () => {
  const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  const result = fs.readFileSync(path.join(EXT, 'result.js'), 'utf8');

  test('background imports capture helpers and does not use Date.now() capture ids', () => {
    assert.match(bg, /from ['"]\.\/lib\/capture\.js['"]/);
    assert.match(bg, /newCaptureId/);
    assert.doesNotMatch(bg, /'cap_' \+ Date\.now\(\)/);
    assert.match(bg, /MAX_IMAGE_BYTES/);
    assert.doesNotMatch(bg, /MAX_IMAGE_BYTES\s*=\s*25e6/);
  });

  test('background keeps the SW alive across the rect message handler', () => {
    // Classic MV3: return true so the message channel stays open until sendResponse.
    assert.match(bg, /return true/);
    assert.match(bg, /sendResponse/);
  });

  test('background wraps openResult failures so a result tab still opens', () => {
    assert.match(bg, /errorResultHash|planOpenResult/);
    assert.match(bg, /assertFitsSessionQuota|MAX_DATA_URL/);
  });

  test('result.js surfaces err= hashes without requiring session storage', () => {
    assert.match(result, /parseResultHash|err=/);
  });

  test('install path does not use bare setTimeout for welcome', () => {
    assert.doesNotMatch(bg, /setTimeout\s*\(\s*async/);
  });
});
