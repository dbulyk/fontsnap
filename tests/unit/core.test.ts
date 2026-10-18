import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { at } from '../../src/shared/core/at';
import { chooseBackdrop, fromRGBA, resize, toGray, type Img } from '../../src/shared/core/image';
import { cropNormalize, nz, prep, softmax } from '../../src/shared/core/pipeline';
import { makeRanker, type Meta } from '../../src/shared/core/ranker';
import {
  components,
  ellipse,
  morph,
  otsu,
  percentile,
  runs,
  textLines,
} from '../../src/shared/core/textcrop';
import { loadPng } from './helpers/png';

interface Fixture {
  images: {
    image: string;
    lines: number[][];
    pack: { shape: number[]; mean: number; prepMean: number };
    crop: { shape: number[]; mean: number; prepMean: number };
  }[];
  ellipse: Record<string, number[]>;
  otsu: { values: number[]; t: number }[];
}

const ROOT = process.cwd();
const FX = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'fixtures', 'textcrop.json'), 'utf8'),
) as Fixture;
interface PixelRow {
  rgba: number[];
  rgb: number[];
}
const TABLE = JSON.parse(
  readFileSync(join(ROOT, 'tests', 'fixtures', 'alpha-composite.json'), 'utf8'),
) as {
  cases: PixelRow[];
  blackCases: PixelRow[];
  images: { name: string; rgba: number[][]; backdrop: 0 | 255; rgb: number[] }[];
};
const gray = (w: number, h: number, f: (x: number, y: number) => number): Img => {
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = f(x, y);
  return { w, h, c: 1, data: d };
};
const mean = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += at(a, i);
  return s / a.length;
};

const ALPHA = JSON.parse(
  readFileSync(join(ROOT, 'tests/fixtures/alpha-composite.json'), 'utf8'),
) as { bg: number; cases: { rgba: number[]; rgb: number[] }[] };
// The backdrop the fixture and the grid composite over (white in production).
const BG = ALPHA.bg;
// Independent reference: round((c*a + bg*(255 - a)) / 255) from quotient and remainder
// (no ties: 255 is odd).
const over = (c: number, a: number, bg: number) => {
  const n = c * a + bg * (255 - a);
  return Math.floor(n / 255) + (2 * (n % 255) > 255 ? 1 : 0);
};

describe('at', () => {
  it('reads in-range elements and throws a RangeError outside the array', () => {
    expect(at(Uint8Array.from([7, 8]), 1)).toBe(8);
    expect(at(['a', 'b'], 0)).toBe('a');
    expect(() => at(new Float64Array(2), 2)).toThrow(RangeError);
    expect(() => at([], 0)).toThrow(/outside/);
    expect(() => at(new Uint8Array(3), -1)).toThrow(RangeError);
  });
});

describe('textcrop primitives', () => {
  it('ellipse kernel matches cv2.getStructuringElement', () => {
    for (const [k, half] of Object.entries(FX.ellipse)) expect(ellipse(+k), `k=${k}`).toEqual(half);
  });

  it('otsu threshold matches cv2', () => {
    for (const { values, t } of FX.otsu) expect(otsu(Uint8Array.from(values))).toBe(t);
  });

  it('runs merges gaps smaller than min_gap', () => {
    expect(runs(Uint8Array.from([0, 1, 1, 0, 1, 0, 0, 0, 1]), 1)).toEqual([
      [1, 3],
      [4, 5],
      [8, 9],
    ]);
    expect(runs(Uint8Array.from([0, 1, 1, 0, 1, 0, 0, 0, 1]), 2)).toEqual([
      [1, 5],
      [8, 9],
    ]);
    expect(runs(new Uint8Array(4), 1)).toEqual([]);
  });

  it('morphology min/max equals brute force with ellipse', () => {
    const im = gray(23, 17, (x, y) => (x * 37 + y * 91 + x * y) % 256);
    const k = 9;
    const half = ellipse(k);
    const r = k >> 1;
    for (const isMax of [false, true]) {
      const got = morph(im.data, im.w, im.h, k, isMax);
      for (let y = 0; y < im.h; y++)
        for (let x = 0; x < im.w; x++) {
          let v = isMax ? 0 : 255;
          for (let i = 0; i < k; i++)
            for (let dx = -at(half, i); dx <= at(half, i); dx++) {
              const yy = y + i - r;
              const xx = x + dx;
              if (yy < 0 || yy >= im.h || xx < 0 || xx >= im.w) continue;
              const q = at(im.data, yy * im.w + xx);
              v = isMax ? Math.max(v, q) : Math.min(v, q);
            }
          expect(at(got, y * im.w + x)).toBe(v);
        }
    }
  });

  it('connected components (8-connectivity) with stats', () => {
    // prettier-ignore
    const m = Uint8Array.from([1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0]); // 5x4
    const { n, st } = components(m, 5, 4);
    expect(n).toBe(4); // background + 3, same as cv2.connectedComponentsWithStats
    expect([...st.area].slice(1).sort()).toEqual([1, 3, 3]);
  });

  it('percentile uses linear interpolation like numpy', () => {
    expect(percentile([1, 2, 3, 4], 90)).toBe(3.7);
    expect(percentile([], 50)).toBe(0);
  });

  it('grayscale uses cv2 fixed-point weights', () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]);
    expect([...toGray(fromRGBA(rgba, 3, 1))]).toEqual([76, 150, 29]);
    const g = gray(2, 1, () => 9);
    expect(toGray(g)).toBe(g.data);
  });

  it('the reference rounds (c*a + bg*(255 - a)) / 255 to the nearest integer', () => {
    // |255 * over - n| <= 127 is |over - n / 255| < 1/2 in integers; a = 0 gives bg, a = 255 gives c.
    const wrong: string[] = [];
    for (const bg of [0, 255])
      for (let a = 0; a < 256; a++)
        for (let c = 0; c < 256; c++) {
          const n = c * a + bg * (255 - a);
          const v = over(c, a, bg);
          if (Math.abs(255 * v - n) > 127 || (a === 0 && v !== bg) || (a === 255 && v !== c))
            wrong.push(`bg=${bg} c=${c} a=${a}: ${v}`);
        }
    expect({ total: wrong.length, first: wrong.slice(0, 10) }).toEqual({ total: 0, first: [] });
  });

  it('the alpha fixture agrees with the reference', () => {
    for (const { rgba, rgb } of ALPHA.cases) {
      expect(rgba).toHaveLength(4);
      const [r = 0, g = 0, b = 0, a = 0] = rgba;
      expect(rgb).toEqual([over(r, a, BG), over(g, a, BG), over(b, a, BG)]);
    }
  });

  it('composites RGBA over a white or a black backdrop (the tables the Python reference is tested with)', () => {
    for (const [backdrop, rows] of [
      [255, TABLE.cases],
      [0, TABLE.blackCases],
    ] as const) {
      const rgba = Uint8Array.from(rows.flatMap((c) => c.rgba));
      const expected = rows.flatMap((c) => c.rgb);
      expect([...fromRGBA(rgba, rows.length, 1, backdrop).data]).toEqual(expected);
      expect([...fromRGBA(new Uint8ClampedArray(rgba), rows.length, 1, backdrop).data]).toEqual(
        expected,
      );
    }
  });

  it('picks the backdrop by contrast: light content goes on black, anything else on white', () => {
    for (const image of TABLE.images) {
      const rgba = Uint8Array.from(image.rgba.flat());
      expect(chooseBackdrop(rgba, image.rgba.length), image.name).toBe(image.backdrop);
      expect([...fromRGBA(rgba, image.rgba.length, 1).data], image.name).toEqual(image.rgb);
    }
  });

  it('matches the integer reference for every (c, a) pair, all three channels, both backdrops', () => {
    const rgba = new Uint8Array(256 * 256 * 4);
    for (let a = 0; a < 256; a++)
      for (let c = 0; c < 256; c++) rgba.set([c, 255 - c, c ^ 0x55, a], (a * 256 + c) * 4);
    for (const backdrop of [0, 255] as const) {
      const rgb = fromRGBA(rgba, 256, 256, backdrop).data;
      const mismatches: string[] = [];
      for (let i = 0; i < 256 * 256; i++)
        for (let ch = 0; ch < 3; ch++) {
          const c = at(rgba, i * 4 + ch);
          const a = at(rgba, i * 4 + 3);
          const want = Math.floor((2 * (c * a + backdrop * (255 - a)) + 255) / 510); // round half up, a second way
          if (at(rgb, i * 3 + ch) !== want) mismatches.push(`${String(c)},${String(a)}`);
        }
      expect(mismatches, `backdrop ${String(backdrop)}`).toEqual([]);
    }
  });

  it('composites every (c, a) pair like an independent integer rounding', () => {
    // A 256 x 256 image, row a, column c: pixel a * 256 + c holds (c, 255 - c, (c + 128) % 256, a),
    // so every channel differs from the others (a channel swap shows) and w * h indexing is pinned.
    const rgba = new Uint8Array(256 * 256 * 4);
    for (let a = 0; a < 256; a++)
      for (let c = 0; c < 256; c++) rgba.set([c, 255 - c, (c + 128) % 256, a], (a * 256 + c) * 4);
    const im = fromRGBA(rgba, 256, 256);
    expect([im.w, im.h, im.data.length]).toEqual([256, 256, 256 * 256 * 3]);
    const wrong: string[] = [];
    for (let a = 0; a < 256; a++)
      for (let c = 0; c < 256; c++) {
        const i = (a * 256 + c) * 3;
        const want = [over(c, a, BG), over(255 - c, a, BG), over((c + 128) % 256, a, BG)];
        const got = [...im.data.subarray(i, i + 3)];
        if (got.join() !== want.join())
          wrong.push(`c=${c} a=${a}: ${got.join()} != ${want.join()}`);
      }
    expect({ total: wrong.length, first: wrong.slice(0, 10) }).toEqual({ total: 0, first: [] });
  });

  it('leaves every opaque pixel byte for byte as it was', () => {
    const rgba = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) rgba.set([i, 255 - i, (i * 7) % 256, 255], i * 4);
    for (const backdrop of [undefined, 0, 255] as const) {
      const rgb = fromRGBA(rgba, 256, 1, backdrop).data;
      for (let i = 0; i < 256; i++)
        expect([...rgb.subarray(i * 3, i * 3 + 3)]).toEqual([...rgba.subarray(i * 4, i * 4 + 3)]);
    }
  });

  it('reads black text on a transparent background like text on white, and white text like text on black', () => {
    const text = [255, 0, 255, 0, 255];
    const on = (ink: number, ground: number, alpha: number) =>
      Uint8Array.from(
        text.flatMap((t) => (t ? [ink, ink, ink, 255] : [ground, ground, ground, alpha])),
      );
    const clear = (ink: number) => [...fromRGBA(on(ink, 0, 0), 5, 1).data];
    expect(clear(0)).toEqual([...fromRGBA(on(0, 255, 255), 5, 1).data]);
    expect(clear(255)).toEqual([...fromRGBA(on(255, 0, 255), 5, 1).data]);
  });
});

describe('resize', () => {
  it('identity, area average, output size', () => {
    const im = gray(4, 2, (x) => x * 10);
    expect([...resize(im, 4, 2, 'area').data]).toEqual([...im.data]);
    expect([...resize(im, 2, 1, 'area').data]).toEqual([5, 25]);
    const up = resize(im, 9, 5, 'cubic');
    expect(up.data).toHaveLength(45);
  });

  it('linear upscaling stays within the input range', () => {
    const up = resize(
      gray(3, 3, (x, y) => x * 100 + y),
      7,
      7,
      'linear',
    );
    expect(up.data).toHaveLength(49);
    expect(Math.max(...up.data)).toBeLessThanOrEqual(202);
  });
});

describe('Python reference parity on realset3 samples', () => {
  const imagePath = (name: string) => join(ROOT, 'data', 'realset3', 'images', name);

  it('textcrop lines match the Python reference', () => {
    for (const e of FX.images) {
      expect(textLines(loadPng(imagePath(e.image))).lines, e.image).toEqual(e.lines);
    }
  });

  it('crop_normalize + prep match the Python reference (shape and stats)', () => {
    for (const e of FX.images) {
      const img = loadPng(imagePath(e.image));
      const pre = textLines(img);
      for (const v of ['pack', 'crop'] as const) {
        const c = cropNormalize(img, v, 96, 6, pre);
        const ref = e[v];
        expect([c.h, c.w], `${e.image} ${v} shape`).toEqual(ref.shape);
        expect(Math.abs(mean(c.data) - ref.mean), `${e.image} ${v} mean`).toBeLessThan(0.5);
        expect(Math.abs(mean(prep(c)) - ref.prepMean), `${e.image} ${v} prep mean`).toBeLessThan(
          0.01,
        );
      }
    }
  });
});

describe('prep and crop fallbacks', () => {
  it('prep: 320x320 NCHW, white padding normalized, aspect kept', () => {
    const x = prep(gray(100, 20, () => 0));
    expect(x).toHaveLength(3 * 320 * 320);
    expect(Math.abs(at(x, 0) - (1 - 0.485) / 0.229)).toBeLessThan(1e-5); // top-left is white pad
    expect(Math.abs(at(x, 160 * 320 + 160) - (0 - 0.485) / 0.229)).toBeLessThan(1e-5); // centre is the black image
  });

  it('prep crops anything larger than 1024 px and enlarges small images', () => {
    expect(prep(gray(2000, 40, () => 128))).toHaveLength(3 * 320 * 320);
    expect(prep(gray(8, 4, () => 128))).toHaveLength(3 * 320 * 320);
  });

  it('blank image falls back without crashing', () => {
    const im = gray(50, 30, () => 255);
    expect(textLines(im).lines).toEqual([]);
    expect(prep(cropNormalize(im))).toHaveLength(3 * 320 * 320);
  });
});

describe('softmax', () => {
  it('sums to 1 and is stable for large logits', () => {
    const p = softmax(Float32Array.from([1000, 1001, 999]));
    expect(Math.abs(p.reduce((a, b) => a + b) - 1)).toBeLessThan(1e-12);
    expect(at(p, 1)).toBeGreaterThan(at(p, 0));
    expect(at(p, 0)).toBeGreaterThan(at(p, 2));
  });
});

const META: Meta = {
  fams: ['inter', 'intertight', 'notosans', 'notosansdisplay', 'notosansjp', 'roboto', 'rare'],
  display: [
    'Inter',
    'Inter Tight',
    'Noto Sans',
    'Noto Sans Display',
    'Noto Sans JP',
    'Roboto',
    'Rare',
  ],
  inGF: [true, true, true, true, true, true, true],
  category: Array<string>(7).fill('Sans Serif'),
  rank: [1, 400, 10, 900, 50, 2, 3000],
  classFam: [0, 0, 1, 2, 3, 4, 5, 6],
  merge: { intertight: 'inter', notosansdisplay: 'notosans' },
  keepNoto: ['notosansjp'],
};

describe('ranker', () => {
  it('family aggregation sums class probabilities per family', () => {
    const R = makeRanker(META);
    const p = [0.2, 0.2, 0.3, 0, 0, 0, 0, 0.3];
    const top = R.rank([p], { alpha: 0, merge: false, k: 3 });
    expect(top.map((o) => o.key)).toEqual(['inter', 'intertight', 'rare']);
    expect(Math.abs((top[0]?.score ?? 0) - 0.4)).toBeLessThan(1e-12);
  });

  it('popularity prior score * rank^-0.5 reorders families', () => {
    const R = makeRanker(META);
    const p = [0, 0, 0, 0, 0, 0, 0.3, 0.7]; // roboto 0.3 (rank 2) vs rare 0.7 (rank 3000)
    expect(R.rank([p], { alpha: 0, merge: false })[0]?.key).toBe('rare');
    expect(R.rank([p], { alpha: 0.5, merge: false })[0]?.key).toBe('roboto');
  });

  it('the prior exponent is exactly 0.5 (rank^-0.5)', () => {
    const R = makeRanker(META);
    // inter 0.36 (rank 1) vs roboto 0.64 (rank 2): 0.36 * 1 = 0.36, 0.64 / sqrt(2) = 0.4525 => roboto first with
    // alpha 0.5; with alpha 0.6 roboto's 0.64 / 2^0.6 = 0.4222 and inter's stays 0.36 => same order, so compare
    // the scores themselves.
    const top = R.rank([[0.18, 0.18, 0, 0, 0, 0, 0.64, 0]], {
      alpha: 0.5,
      merge: false,
      k: 2,
    });
    const roboto = top.find((o) => o.key === 'roboto');
    expect(roboto?.score).toBeCloseTo(0.64 * 2 ** -0.5, 12);
    expect(roboto?.score).not.toBeCloseTo(0.64 * 2 ** -0.6, 4);
  });

  it('near-duplicate families merge; CJK Noto stays separate', () => {
    const R = makeRanker(META);
    expect(R.mg('intertight')).toBe('inter');
    expect(R.mg('notosansdisplay')).toBe('notosans');
    expect(R.mg('notosanssymbols')).toBe('notosans');
    expect(R.mg('notosansjp')).toBe('notosansjp');
    const top = R.rank([[0, 0, 0.5, 0, 0, 0.3, 0.1, 0.1]], {
      alpha: 0,
      merge: true,
    });
    expect(top.map((o) => o.key)).toEqual(['inter', 'notosansjp', 'roboto', 'rare', 'notosans']);
    expect(top[0]?.name).toBe('Inter');
  });

  it('names inherited from Object.prototype are plain families, not table hits', () => {
    const R = makeRanker(META);
    expect(R.mg('constructor')).toBe('constructor');
    expect(R.mg('__proto__')).toBe('__proto__');
  });

  it('TTA averages variant probabilities; conf over top-k sums to 1', () => {
    const R = makeRanker(META);
    const a = [1, 0, 0, 0, 0, 0, 0, 0];
    const b = [0, 0, 0, 0, 0, 0, 1, 0];
    const top = R.rank([a, b], { alpha: 0, merge: false });
    expect(Math.abs((top[0]?.score ?? 0) - 0.5)).toBeLessThan(1e-12);
    expect(Math.abs(top.reduce((s, o) => s + o.conf, 0) - 1)).toBeLessThan(1e-9);
  });

  it('works with all default options', () => {
    const R = makeRanker(META);
    expect(R.rank([[0, 0, 0, 0, 0, 0, 1, 0]])[0]?.key).toBe('roboto');
  });
});

describe('nz', () => {
  it('normalizes family names', () => {
    expect(nz('IBM Plex Sans KR')).toBe('ibmplexsanskr');
  });
});
