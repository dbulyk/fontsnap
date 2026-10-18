import { describe, expect, it } from 'vitest';
import {
  JPEG_QUALITY_LADDER,
  MAX_CROP_SIDE,
  MAX_DATA_URL_CHARS,
  MAX_IMAGE_BYTES,
  SESSION_QUOTA_BYTES,
  assertFitsSessionQuota,
  clipCropRect,
  frameRect,
  encodeWithinSessionQuota,
  errorResultHash,
  fitsSessionQuota,
  newCaptureId,
  parseResultHash,
  planOpenResult,
  resetCaptureCounterForTests,
  scaleToMaxSide,
  validRect,
  type EncodeOptions,
} from '../../src/shared/capture';

describe('validRect', () => {
  it('accepts finite positive width/height', () => {
    expect(validRect({ x: 0, y: 0, w: 10, h: 8 })).toBe(true);
    expect(validRect({ x: -5, y: 1.5, w: 20, h: 3 })).toBe(true);
  });

  it('rejects missing, non-finite, or non-positive size', () => {
    expect(validRect(null)).toBe(false);
    expect(validRect(undefined)).toBe(false);
    expect(validRect({ x: 0, y: 0, w: 0, h: 10 })).toBe(false);
    expect(validRect({ x: 0, y: 0, w: 10, h: -1 })).toBe(false);
    expect(validRect({ x: NaN, y: 0, w: 10, h: 10 })).toBe(false);
    expect(validRect({ x: 0, y: Infinity, w: 10, h: 10 })).toBe(false);
    expect(validRect({ x: 0, y: 0, w: 10 })).toBe(false);
  });

  it('rejects values that are not numbers, even if they would coerce to one', () => {
    expect(validRect({ x: '1', y: 0, w: 10, h: 10 })).toBe(false);
    expect(validRect({ x: 0, y: 0, w: '10', h: 10 })).toBe(false);
    expect(validRect('rect')).toBe(false);
    expect(validRect(42)).toBe(false);
  });
});

describe('clipCropRect', () => {
  it('scales CSS rect by dpr and clips to bitmap', () => {
    expect(clipCropRect({ x: 10, y: 20, w: 30, h: 40 }, 2, 200, 200)).toEqual({
      x: 20,
      y: 40,
      w: 60,
      h: 80,
    });
  });

  it('clips overflow past the right/bottom edges', () => {
    expect(clipCropRect({ x: 90, y: 90, w: 50, h: 50 }, 1, 100, 100)).toEqual({
      x: 90,
      y: 90,
      w: 10,
      h: 10,
    });
  });

  it('handles negative origin by shrinking width/height into the visible area', () => {
    // rect starts left of viewport: only the visible portion remains
    expect(clipCropRect({ x: -10, y: 0, w: 30, h: 20 }, 1, 100, 100)).toEqual({
      x: 0,
      y: 0,
      w: 20,
      h: 20,
    });
  });

  it('throws when the clipped selection is too small / outside the visible area', () => {
    expect(() => clipCropRect({ x: 200, y: 200, w: 10, h: 10 }, 1, 100, 100)).toThrow(
      /outside the visible area/,
    );
    expect(() => clipCropRect({ x: 0, y: 0, w: 1, h: 1 }, 1, 100, 100)).toThrow(
      /outside the visible area/,
    );
  });

  it('treats invalid dpr as 1', () => {
    expect(clipCropRect({ x: 5, y: 5, w: 10, h: 10 }, 0, 100, 100)).toEqual({
      x: 5,
      y: 5,
      w: 10,
      h: 10,
    });
    expect(clipCropRect({ x: 5, y: 5, w: 10, h: 10 }, NaN, 100, 100)).toEqual({
      x: 5,
      y: 5,
      w: 10,
      h: 10,
    });
  });
});

describe('scaleToMaxSide', () => {
  it('leaves small images unchanged', () => {
    expect(scaleToMaxSide(800, 600, MAX_CROP_SIDE)).toEqual({
      width: 800,
      height: 600,
      scale: 1,
    });
  });

  it('downscales so the long side equals maxSide', () => {
    const r = scaleToMaxSide(4800, 2400, MAX_CROP_SIDE);
    expect(r.width).toBe(MAX_CROP_SIDE);
    expect(r.height).toBe(MAX_CROP_SIDE / 2);
    expect(r.scale).toBeLessThan(1);
  });

  it('defaults the side cap to MAX_CROP_SIDE and never returns an empty side', () => {
    expect(scaleToMaxSide(4800, 2400).width).toBe(2400);
    expect(scaleToMaxSide(100000, 1)).toEqual({
      width: 2400,
      height: 1,
      scale: 0.024,
    });
  });
});

describe('session quota / payload caps', () => {
  it('MAX_IMAGE_BYTES fits under session quota after base64 expansion', () => {
    expect(SESSION_QUOTA_BYTES).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    expect(MAX_DATA_URL_CHARS).toBeLessThan(SESSION_QUOTA_BYTES);
    // data URL ≈ header + ceil(raw * 4/3); require headroom under MAX_DATA_URL_CHARS
    const approxDataUrl = 32 + Math.ceil(MAX_IMAGE_BYTES * (4 / 3));
    expect(
      approxDataUrl,
      `raw ${String(MAX_IMAGE_BYTES)} vs cap ${String(MAX_DATA_URL_CHARS)}`,
    ).toBeLessThanOrEqual(MAX_DATA_URL_CHARS);
    expect(MAX_IMAGE_BYTES, 'legacy 25MB cap must be lowered to match session quota').toBeLessThan(
      25e6,
    );
  });

  it('assertFitsSessionQuota accepts small data URLs and rejects oversized ones', () => {
    expect(() => {
      assertFitsSessionQuota('data:image/png;base64,aaaa');
    }).not.toThrow();
    expect(() => {
      assertFitsSessionQuota('not-a-data-url');
    }).toThrow(/Invalid image payload/);
    const huge = 'data:image/png;base64,' + 'a'.repeat(MAX_DATA_URL_CHARS);
    expect(() => {
      assertFitsSessionQuota(huge);
    }).toThrow(/too large for temporary storage/);
  });

  it('assertFitsSessionQuota rejects non-strings', () => {
    expect(() => {
      assertFitsSessionQuota(undefined);
    }).toThrow(/Invalid image payload/);
  });

  it('fitsSessionQuota is the boolean counterpart of assertFitsSessionQuota', () => {
    expect(fitsSessionQuota('data:image/png;base64,aa')).toBe(true);
    expect(fitsSessionQuota('data:image/png;base64,' + 'a'.repeat(MAX_DATA_URL_CHARS))).toBe(false);
    expect(fitsSessionQuota('nope')).toBe(false);
  });
});

describe('encodeWithinSessionQuota (JPEG ladder)', () => {
  it('exposes a descending JPEG quality ladder', () => {
    expect(JPEG_QUALITY_LADDER.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < JPEG_QUALITY_LADDER.length; i++) {
      expect(JPEG_QUALITY_LADDER[i]).toBeLessThan(JPEG_QUALITY_LADDER[i - 1] ?? 0);
    }
    expect(JPEG_QUALITY_LADDER.every((q) => q > 0 && q <= 1)).toBe(true);
  });

  it('keeps PNG when it already fits', async () => {
    const calls: EncodeOptions[] = [];
    const out = await encodeWithinSessionQuota((opts) => {
      calls.push(opts);
      return Promise.resolve('data:image/png;base64,ok');
    });
    expect(out).toBe('data:image/png;base64,ok');
    expect(calls).toEqual([{ type: 'image/png' }]);
  });

  it('falls back to JPEG when PNG exceeds the budget', async () => {
    const hugePng = 'data:image/png;base64,' + 'P'.repeat(MAX_DATA_URL_CHARS);
    const smallJpg = 'data:image/jpeg;base64,small';
    const calls: EncodeOptions[] = [];
    const out = await encodeWithinSessionQuota((opts) => {
      calls.push(opts);
      return Promise.resolve(opts.type === 'image/png' ? hugePng : smallJpg);
    });
    expect(out).toBe(smallJpg);
    expect(calls[0]?.type).toBe('image/png');
    expect(calls[1]?.type).toBe('image/jpeg');
    expect(calls[1]?.quality).toBe(JPEG_QUALITY_LADDER[0]);
  });

  it('walks the quality ladder until a JPEG fits', async () => {
    const huge = 'data:image/png;base64,' + 'X'.repeat(MAX_DATA_URL_CHARS);
    const calls: EncodeOptions[] = [];
    const out = await encodeWithinSessionQuota((opts) => {
      calls.push(opts);
      if (opts.type === 'image/png') return Promise.resolve(huge);
      // only the third JPEG quality fits
      if (opts.quality === JPEG_QUALITY_LADDER[2]) {
        return Promise.resolve('data:image/jpeg;base64,fit');
      }
      return Promise.resolve(huge.replace('png', 'jpeg'));
    });
    expect(out).toBe('data:image/jpeg;base64,fit');
    expect(calls.filter((c) => c.type === 'image/jpeg')).toHaveLength(3);
  });

  it('honours an explicit budget (smaller than the session default)', async () => {
    const out = await encodeWithinSessionQuota(
      ({ type }) =>
        Promise.resolve(`data:${type};base64,${'a'.repeat(type === 'image/png' ? 500 : 50)}`),
      200,
    );
    expect(out.startsWith('data:image/jpeg')).toBe(true);
  });

  it('throws a clear error when even the lowest JPEG quality cannot fit', async () => {
    const huge = 'data:image/png;base64,' + 'Z'.repeat(MAX_DATA_URL_CHARS);
    await expect(
      encodeWithinSessionQuota((opts) =>
        Promise.resolve(
          opts.type === 'image/png'
            ? huge
            : 'data:image/jpeg;base64,' + 'Z'.repeat(MAX_DATA_URL_CHARS),
        ),
      ),
    ).rejects.toThrow(/too large for temporary storage/);
  });
});

describe('newCaptureId', () => {
  it('uses crypto.randomUUID when available', () => {
    const id = newCaptureId({
      randomUUID: () => '11111111-2222-3333-4444-555555555555',
    });
    expect(id).toBe('cap_11111111-2222-3333-4444-555555555555');
  });

  it('defaults to the global crypto (a real UUID)', () => {
    expect(newCaptureId()).toMatch(/^cap_[0-9a-f-]{36}$/);
  });

  it('falls back to Date.now()+counter without UUID collisions in the same ms', () => {
    resetCaptureCounterForTests();
    const a = newCaptureId({});
    const b = newCaptureId({});
    expect(a).toMatch(/^cap_\d+_\d+$/);
    expect(b).toMatch(/^cap_\d+_\d+$/);
    expect(a).not.toBe(b);
  });

  it('falls back when there is no crypto object at all', () => {
    expect(newCaptureId(undefined)).toMatch(/^cap_[0-9a-f-]{36}$/);
    expect(newCaptureId(null)).toMatch(/^cap_\d+_\d+$/);
  });
});

describe('openResult error wrapping helpers', () => {
  it('errorResultHash encodes a message that parseResultHash can recover', () => {
    const hash = errorResultHash('quota exceeded');
    expect(parseResultHash(hash)).toEqual({
      kind: 'error',
      message: 'quota exceeded',
    });
    expect(parseResultHash('#' + hash)).toEqual({
      kind: 'error',
      message: 'quota exceeded',
    });
  });

  it('errorResultHash names an unknown error', () => {
    expect(parseResultHash(errorResultHash(''))).toEqual({
      kind: 'error',
      message: 'Unknown error',
    });
  });

  it('parseResultHash keeps a malformed err= payload as is', () => {
    expect(parseResultHash('err=%E0%A4%A')).toEqual({
      kind: 'error',
      message: '%E0%A4%A',
    });
  });

  it('parseResultHash treats normal capture ids as session keys', () => {
    expect(parseResultHash('')).toBeNull();
    expect(parseResultHash('cap_abc')).toEqual({
      kind: 'session',
      id: 'cap_abc',
    });
  });

  it('planOpenResult keeps the session id on success', () => {
    const entry = { dataUrl: 'data:image/png;base64,xx' };
    expect(planOpenResult({ entry, storeOk: true, id: 'cap_1' })).toEqual({
      hash: 'cap_1',
      entry,
    });
  });

  it('planOpenResult falls back to an err= hash when storage fails', () => {
    const planned = planOpenResult({
      entry: { dataUrl: 'data:…' },
      storeOk: false,
      storeError: new Error('QUOTA_BYTES quota exceeded'),
      id: 'cap_1',
    });
    expect(planned.hash.startsWith('err=')).toBe(true);
    expect(planned.entry.error).toBe('QUOTA_BYTES quota exceeded');
    expect(parseResultHash(planned.hash)).toEqual({
      kind: 'error',
      message: 'QUOTA_BYTES quota exceeded',
    });
  });

  it('planOpenResult explains a storage failure that carries no message', () => {
    expect(planOpenResult({ entry: {}, storeOk: false, id: 'x' }).entry.error).toBe(
      'Storage failed',
    );
    expect(planOpenResult({ entry: { error: 'boom' }, storeOk: false, id: 'x' }).entry.error).toBe(
      'boom',
    );
    expect(
      planOpenResult({
        entry: {},
        storeOk: false,
        storeError: 'plain',
        id: 'x',
      }).entry.error,
    ).toBe('plain');
  });
});

describe('frameRect: an image rect of an iframe in the viewport of the tab', () => {
  const iframe = { x: 10, y: 20, w: 300, h: 200 };
  const box = { x: 1, y: 1, w: 298, h: 198 };
  const outer = { x: 0, y: 0, w: 300, h: 200 };
  const view = { x: 0, y: 0, w: 298, h: 198 };

  it('moves the rect by the frame position and its border', () => {
    expect(frameRect({ x: 5, y: 6, w: 40, h: 30 }, view, iframe, box, outer)).toEqual({
      x: 16,
      y: 27,
      w: 40,
      h: 30,
    });
  });

  it('follows a CSS scale of the frame', () => {
    const half = { x: 10, y: 20, w: 150, h: 100 };
    expect(frameRect({ x: 20, y: 40, w: 100, h: 60 }, view, half, box, outer)).toEqual({
      x: 10 + (1 + 20) * 0.5,
      y: 20 + (1 + 40) * 0.5,
      w: 50,
      h: 30,
    });
  });

  it('keeps only the part the frame shows', () => {
    expect(frameRect({ x: -10, y: -10, w: 50, h: 50 }, view, iframe, box, outer)).toEqual({
      x: 11,
      y: 21,
      w: 40,
      h: 40,
    });
    expect(frameRect({ x: 280, y: 190, w: 100, h: 100 }, view, iframe, box, outer)).toEqual({
      x: 291,
      y: 211,
      w: 18,
      h: 8,
    });
  });

  it('throws when nothing of the image is inside the frame', () => {
    expect(() => frameRect({ x: 400, y: 0, w: 10, h: 10 }, view, iframe, box, outer)).toThrow(
      'Selection is outside the visible area',
    );
  });

  it.each([1, 2])('lands on the same screenshot pixels at DPR %i', (dpr) => {
    const rect = frameRect({ x: 5, y: 6, w: 40, h: 30 }, view, iframe, box, outer);
    expect(clipCropRect(rect, dpr, 1000, 1000)).toEqual({
      x: 16 * dpr,
      y: 27 * dpr,
      w: 40 * dpr,
      h: 30 * dpr,
    });
  });

  describe('a border of its own on every side', () => {
    // border 7 | 2 on the left and the right, 3 | 11 at the top and the bottom; the document inside is 291 x 186
    const uneven = {
      iframe: { x: 100, y: 50, w: 300, h: 200 },
      box: { x: 7, y: 3, w: 291, h: 186 },
      outer: { x: 0, y: 0, w: 300, h: 200 },
      view: { x: 0, y: 0, w: 291, h: 186 },
    };

    it('puts the image after the border on the left and at the top, whatever the border on the other sides is', () => {
      expect(
        frameRect(
          { x: 5, y: 6, w: 40, h: 30 },
          uneven.view,
          uneven.iframe,
          uneven.box,
          uneven.outer,
        ),
      ).toEqual({ x: 112, y: 59, w: 40, h: 30 });
    });

    it('takes the scale from the whole border box, so that borders of different widths do not shift it', () => {
      const half = { x: 100, y: 50, w: 150, h: 100 };
      expect(
        frameRect({ x: 20, y: 40, w: 100, h: 60 }, uneven.view, half, uneven.box, uneven.outer),
      ).toEqual({ x: 100 + (7 + 20) * 0.5, y: 50 + (3 + 40) * 0.5, w: 50, h: 30 });
      // the old reading (a border as wide on the right as on the left) would have scaled by 300 / (291 + 14) and moved it
      expect(100 + (7 + 20) * (150 / (291 + 14))).not.toBe(100 + (7 + 20) * 0.5);
    });
  });

  describe('padding is refused, not guessed', () => {
    // padding 10 on the left, 4 on the right, 6 at the top, 0 at the bottom, border 1: the client box is 14 / 6 larger than the document
    const padded = {
      box: { x: 1, y: 1, w: 298, h: 198 },
      view: { x: 0, y: 0, w: 284, h: 192 },
    };

    it('throws when the client box is larger than the viewport of the frame', () => {
      expect(() =>
        frameRect({ x: 5, y: 6, w: 40, h: 30 }, padded.view, iframe, padded.box, outer),
      ).toThrow('padding');
    });

    it('also throws when the frame is smaller (it is another frame than the one measured)', () => {
      expect(() =>
        frameRect({ x: 5, y: 6, w: 40, h: 30 }, { x: 0, y: 0, w: 200, h: 198 }, iframe, box, outer),
      ).toThrow();
    });

    it('lets a difference of one pixel through: the two sizes are rounded', () => {
      expect(() =>
        frameRect({ x: 5, y: 6, w: 40, h: 30 }, { x: 0, y: 0, w: 297, h: 199 }, iframe, box, outer),
      ).not.toThrow();
    });
  });

  it('throws when the border box has no size', () => {
    expect(() =>
      frameRect({ x: 5, y: 6, w: 40, h: 30 }, view, iframe, box, { x: 0, y: 0, w: 0, h: 0 }),
    ).toThrow('no size');
  });
});
