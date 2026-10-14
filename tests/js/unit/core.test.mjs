import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadPng } from '../../../scripts/lib/evaljs.mjs';
import {
  textLines,
  cropNormalize,
  prep,
  resize,
  softmax,
  makeRanker,
  nz,
  fromRGBA,
  _internals as I,
} from '../../../extension/lib/fontsnap-core.js';

const FX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'textcrop.json')));
const gray = (w, h, f) => {
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = f(x, y);
  return { w, h, c: 1, data: d };
};
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test('ellipse kernel matches cv2.getStructuringElement', () => {
  for (const [k, half] of Object.entries(FX.ellipse)) assert.deepEqual(I.ellipse(+k), half, `k=${k}`);
});

test('otsu threshold matches cv2', () => {
  for (const { values, t } of FX.otsu) assert.equal(I.otsu(Uint8Array.from(values)), t);
});

test('runs merges gaps smaller than min_gap', () => {
  assert.deepEqual(I.runs(Uint8Array.from([0, 1, 1, 0, 1, 0, 0, 0, 1]), 1), [
    [1, 3],
    [4, 5],
    [8, 9],
  ]);
  assert.deepEqual(I.runs(Uint8Array.from([0, 1, 1, 0, 1, 0, 0, 0, 1]), 2), [
    [1, 5],
    [8, 9],
  ]);
  assert.deepEqual(I.runs(new Uint8Array(4), 1), []);
});

test('morphology min/max equals brute force with ellipse', () => {
  const im = gray(23, 17, (x, y) => (x * 37 + y * 91 + x * y) % 256),
    k = 9,
    half = I.ellipse(k),
    r = k >> 1;
  for (const isMax of [false, true]) {
    const got = I.morph(im.data, im.w, im.h, k, isMax);
    for (let y = 0; y < im.h; y++)
      for (let x = 0; x < im.w; x++) {
        let v = isMax ? 0 : 255;
        for (let i = 0; i < k; i++)
          for (let dx = -half[i]; dx <= half[i]; dx++) {
            const yy = y + i - r,
              xx = x + dx;
            if (yy < 0 || yy >= im.h || xx < 0 || xx >= im.w) continue;
            const q = im.data[yy * im.w + xx];
            v = isMax ? Math.max(v, q) : Math.min(v, q);
          }
        assert.equal(got[y * im.w + x], v);
      }
  }
});

test('connected components (8-connectivity) with stats', () => {
  const m = Uint8Array.from([1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0]); // 5x4
  const { n, st } = I.components(m, 5, 4);
  assert.equal(n, 4); // background + 3, same as cv2.connectedComponentsWithStats
  assert.deepEqual([...st.area].slice(1).sort(), [1, 3, 3]);
});

test('percentile uses linear interpolation like numpy', () => {
  assert.equal(I.percentile([1, 2, 3, 4], 90), 3.7);
});

test('grayscale uses cv2 fixed-point weights', () => {
  assert.deepEqual([...I.toGray(fromRGBA(Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]), 3, 1))], [76, 150, 29]);
});

test('resize: identity, area average, output size', () => {
  const im = gray(4, 2, (x) => x * 10);
  assert.deepEqual([...resize(im, 4, 2, 'area').data], [...im.data]);
  assert.deepEqual([...resize(im, 2, 1, 'area').data], [5, 25]);
  const up = resize(im, 9, 5, 'cubic');
  assert.equal(up.data.length, 45);
});

test('textcrop lines match the Python reference on realset3 samples', () => {
  for (const e of FX.images) {
    const img = loadPng(path.join(ROOT, 'data', 'realset3', 'images', e.image));
    assert.deepEqual(textLines(img).lines, e.lines, e.image);
  }
});

test('crop_normalize + prep match the Python reference (shape and stats)', () => {
  for (const e of FX.images) {
    const img = loadPng(path.join(ROOT, 'data', 'realset3', 'images', e.image)),
      pre = textLines(img);
    for (const v of ['pack', 'crop']) {
      const c = cropNormalize(img, v, 96, 6, pre),
        ref = e[v];
      assert.deepEqual([c.h, c.w], ref.shape, `${e.image} ${v} shape`);
      assert.ok(Math.abs(mean(c.data) - ref.mean) < 0.5, `${e.image} ${v} mean ${mean(c.data)} vs ${ref.mean}`);
      const x = prep(c);
      assert.ok(Math.abs(mean(x) - ref.prepMean) < 0.01, `${e.image} ${v} prep mean`);
    }
  }
});

test('prep: 320x320 NCHW, white padding normalized, aspect kept', () => {
  const x = prep(gray(100, 20, () => 0));
  assert.equal(x.length, 3 * 320 * 320);
  assert.ok(Math.abs(x[0] - (1 - 0.485) / 0.229) < 1e-5); // top-left is white pad
  assert.ok(Math.abs(x[160 * 320 + 160] - (0 - 0.485) / 0.229) < 1e-5); // centre is the black image
});

test('blank image falls back without crashing', () => {
  const im = gray(50, 30, () => 255);
  assert.deepEqual(textLines(im).lines, []);
  assert.equal(prep(cropNormalize(im)).length, 3 * 320 * 320);
});

test('softmax sums to 1 and is stable for large logits', () => {
  const p = softmax(Float32Array.from([1000, 1001, 999]));
  assert.ok(Math.abs(p.reduce((a, b) => a + b) - 1) < 1e-12);
  assert.ok(p[1] > p[0] && p[0] > p[2]);
});

const META = {
  fams: ['inter', 'intertight', 'notosans', 'notosansdisplay', 'notosansjp', 'roboto', 'rare'],
  display: ['Inter', 'Inter Tight', 'Noto Sans', 'Noto Sans Display', 'Noto Sans JP', 'Roboto', 'Rare'],
  inGF: [true, true, true, true, true, true, true],
  category: Array(7).fill('Sans Serif'),
  rank: [1, 400, 10, 900, 50, 2, 3000],
  classFam: [0, 0, 1, 2, 3, 4, 5, 6],
  merge: { intertight: 'inter', notosansdisplay: 'notosans' },
  keepNoto: ['notosansjp'],
};

test('family aggregation sums class probabilities per family', () => {
  const R = makeRanker(META),
    p = [0.2, 0.2, 0.3, 0, 0, 0, 0, 0.3];
  const top = R.rank([p], { alpha: 0, merge: false, k: 3 });
  assert.deepEqual(
    top.map((o) => o.key),
    ['inter', 'intertight', 'rare'],
  );
  assert.ok(Math.abs(top[0].score - 0.4) < 1e-12);
});

test('popularity prior score * rank^-0.5 reorders families', () => {
  const R = makeRanker(META),
    p = [0, 0, 0, 0, 0, 0, 0.3, 0.7]; // roboto 0.3 (rank 2) vs rare 0.7 (rank 3000)
  assert.equal(R.rank([p], { alpha: 0, merge: false })[0].key, 'rare');
  assert.equal(R.rank([p], { alpha: 0.5, merge: false })[0].key, 'roboto');
});

test('near-duplicate families merge; CJK Noto stays separate', () => {
  const R = makeRanker(META);
  assert.equal(R.mg('intertight'), 'inter');
  assert.equal(R.mg('notosansdisplay'), 'notosans');
  assert.equal(R.mg('notosanssymbols'), 'notosans');
  assert.equal(R.mg('notosansjp'), 'notosansjp');
  const top = R.rank([[0, 0, 0.5, 0, 0, 0.3, 0.1, 0.1]], { alpha: 0, merge: true });
  assert.deepEqual(
    top.map((o) => o.key),
    ['inter', 'notosansjp', 'roboto', 'rare', 'notosans'],
  );
  assert.equal(top[0].name, 'Inter');
});

test('TTA averages variant probabilities; conf over top-k sums to 1', () => {
  const R = makeRanker(META),
    a = [1, 0, 0, 0, 0, 0, 0, 0],
    b = [0, 0, 0, 0, 0, 0, 1, 0];
  const top = R.rank([a, b], { alpha: 0, merge: false });
  assert.ok(Math.abs(top[0].score - 0.5) < 1e-12);
  assert.ok(Math.abs(top.reduce((s, o) => s + o.conf, 0) - 1) < 1e-9);
});

test('nz normalizes family names', () => {
  assert.equal(nz('IBM Plex Sans KR'), 'ibmplexsanskr');
});
