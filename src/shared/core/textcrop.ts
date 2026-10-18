// JS port of textcrop.crop_normalize (python/fontsnap_ref/textcrop.py): find text lines and a
// background-normalized gray image. Pure code (no DOM); works in the extension and in Node.
import { at, atF32, atF64, atI32, atNum, atU8 } from './at';
import { rint, toGray, type Img } from './image';

const f32 = Math.fround;

/** [y0, y1, x0, x1] of one text line. */
export type LineBox = [number, number, number, number];

export interface TextLines {
  norm: Img | null;
  lines: LineBox[];
}

/** cv2 getThreshVal_Otsu_8u over an array of uint8 values. */
export function otsu(v: Uint8Array): number {
  const h = new Float64Array(256);
  for (let i = 0; i < v.length; i++) {
    const bin = atU8(v, i);
    h[bin] = atF64(h, bin) + 1;
  }
  const N = v.length;
  let mu = 0;
  for (let i = 0; i < 256; i++) {
    h[i] = atF64(h, i) / N;
    mu += i * atF64(h, i);
  }
  let q1 = 0;
  let mu1 = 0;
  let maxS = 0;
  let maxV = 0;
  const EPS = 1.1920929e-7;
  for (let i = 0; i < 256; i++) {
    const p = atF64(h, i);
    mu1 *= q1;
    q1 += p;
    const q2 = 1 - q1;
    if (Math.min(q1, q2) < EPS || Math.max(q1, q2) > 1 - EPS) continue;
    mu1 = (mu1 + i * p) / q1;
    const mu2 = (mu - q1 * mu1) / q2;
    const s = q1 * q2 * (mu1 - mu2) ** 2;
    if (s > maxS) {
      maxS = s;
      maxV = i;
    }
  }
  return maxV;
}

/** Runs of set entries in `mask`, merging gaps of at most `minGap`: [start, end) pairs. */
export function runs(mask: Uint8Array, minGap: number): [number, number][] {
  const out: [number, number][] = [];
  let s = -1;
  let p = -1;
  for (let i = 0; i < mask.length; i++)
    if (atU8(mask, i)) {
      if (s < 0) {
        s = i;
        p = i;
      } else {
        if (i - p > minGap) {
          out.push([s, p + 1]);
          s = i;
        }
        p = i;
      }
    }
  if (s >= 0) out.push([s, p + 1]);
  return out;
}

/** Half-width per row of the k×k elliptical structuring element. */
export function ellipse(k: number): number[] {
  const r = k >> 1;
  const c = k >> 1;
  const half: number[] = [];
  for (let i = 0; i < k; i++) {
    const dy = i - r;
    half.push(rint(c * Math.sqrt((r * r - dy * dy) / (r * r))));
  }
  return half;
}

/**
 * Grayscale morphology (min/max) with an ellipse; out-of-bounds pixels are ignored (cv2 default border
 * for morphology). The ellipse is a union of horizontal segments: 1D sliding min/max
 * (van Herk/Gil-Werman) per distinct half-width, then min/max over rows.
 */
export function morph(g: Uint8Array, w: number, h: number, k: number, isMax: boolean): Uint8Array {
  const half = ellipse(k);
  const r = k >> 1;
  const rowF = new Map<number, Uint8Array>();
  const fv = isMax ? 0 : 255;
  const op = isMax
    ? (a: number, b: number) => (a > b ? a : b)
    : (a: number, b: number) => (a < b ? a : b);
  for (const dx of new Set(half)) {
    const o = new Uint8Array(w * h);
    const W = 2 * dx + 1;
    const L = w + 2 * dx;
    const pad = new Uint8Array(L);
    const pre = new Uint8Array(L);
    const suf = new Uint8Array(L);
    for (let y = 0; y < h; y++) {
      const base = y * w;
      pad.fill(fv);
      pad.set(g.subarray(base, base + w), dx);
      for (let x = 0; x < L; x++)
        pre[x] = x % W === 0 ? atU8(pad, x) : op(atU8(pre, x - 1), atU8(pad, x));
      for (let x = L - 1; x >= 0; x--) {
        suf[x] = x % W === W - 1 || x === L - 1 ? atU8(pad, x) : op(atU8(suf, x + 1), atU8(pad, x));
      }
      for (let x = 0; x < w; x++) o[base + x] = op(atU8(suf, x), atU8(pre, x + W - 1));
    }
    rowF.set(dx, o);
  }
  const rowOf = (dx: number): Uint8Array => {
    const row = rowF.get(dx);
    if (row === undefined) throw new RangeError(`no row filter for half-width ${String(dx)}`);
    return row;
  };
  const rows = half.map(rowOf);
  const out = new Uint8Array(w * h).fill(fv);
  for (let i = 0; i < k; i++) {
    const src = at(rows, i);
    const dy = i - r;
    const y0 = Math.max(0, -dy);
    const y1 = Math.min(h, h - dy);
    for (let y = y0; y < y1; y++) {
      const ob = y * w;
      const sb = (y + dy) * w;
      for (let x = 0; x < w; x++) out[ob + x] = op(atU8(out, ob + x), atU8(src, sb + x));
    }
  }
  return out;
}

export interface Components {
  n: number;
  lab: Int32Array;
  st: {
    x0: Int32Array;
    y0: Int32Array;
    x1: Int32Array;
    y1: Int32Array;
    area: Int32Array;
  };
}

/** 8-connectivity labels + stats (cv2.connectedComponentsWithStats; label 0 is the background). */
export function components(ink: Uint8Array, w: number, h: number): Components {
  const lab = new Int32Array(w * h);
  const par = [0];
  const find = (start: number): number => {
    let a = start;
    while (atNum(par, a) !== a) {
      par[a] = atNum(par, atNum(par, a));
      a = atNum(par, a);
    }
    return a;
  };
  const uni = (x: number, y: number) => {
    const a = find(x);
    const b = find(y);
    if (a !== b) {
      if (a < b) par[b] = a;
      else par[a] = b;
    }
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!atU8(ink, i)) continue;
      let l = 0;
      const nb = [
        x > 0 ? i - 1 : -1,
        y > 0 && x > 0 ? i - w - 1 : -1,
        y > 0 ? i - w : -1,
        y > 0 && x < w - 1 ? i - w + 1 : -1,
      ];
      for (const j of nb) {
        const lj = j >= 0 ? atI32(lab, j) : 0;
        if (lj) {
          if (!l) l = lj;
          else uni(l, lj);
        }
      }
      if (!l) {
        l = par.length;
        par.push(l);
      }
      lab[i] = l;
    }
  const map = new Int32Array(par.length);
  let n = 1;
  for (let i = 1; i < par.length; i++) {
    const r = find(i);
    map[i] = r === i ? n++ : 0;
  }
  for (let i = 1; i < par.length; i++) map[i] = atI32(map, find(i));
  const st = {
    x0: new Int32Array(n).fill(1e9),
    y0: new Int32Array(n).fill(1e9),
    x1: new Int32Array(n).fill(-1),
    y1: new Int32Array(n).fill(-1),
    area: new Int32Array(n),
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!atI32(lab, i)) continue;
      const l = atI32(map, atI32(lab, i));
      lab[i] = l;
      st.area[l] = atI32(st.area, l) + 1;
      if (x < atI32(st.x0, l)) st.x0[l] = x;
      if (x > atI32(st.x1, l)) st.x1[l] = x;
      if (y < atI32(st.y0, l)) st.y0[l] = y;
      if (y > atI32(st.y1, l)) st.y1[l] = y;
    }
  return { n, lab, st };
}

/** numpy.percentile with linear interpolation. */
export function percentile(arr: readonly number[], q: number): number {
  const a = Float64Array.from(arr).sort();
  if (!a.length) return 0;
  const pos = ((a.length - 1) * q) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return atF64(a, lo) + (atF64(a, hi) - atF64(a, lo)) * (pos - lo);
}

type Candidate = [score: number, d: Float32Array, ink: Uint8Array];

export function textLines(img: Img): TextLines {
  const { w, h } = img;
  const g8 = toGray(img);
  const N = w * h;
  const k = Math.min(Math.max(Math.trunc(h * 0.5), 9), 61) | 1;
  const hist = new Float64Array(256);
  for (let i = 0; i < N; i++) {
    const bin = atU8(g8, i);
    hist[bin] = atF64(hist, bin) + 1;
  }
  let m = 0;
  let best = -1;
  for (let i = 0; i < 256; i++) {
    let s = 0;
    for (let j = i - 4; j <= i + 4; j++) if (j >= 0 && j < 256) s += atF64(hist, j);
    s /= 9;
    if (s > best) {
      best = s;
      m = i;
    }
  }
  let nl = 0;
  let nd = 0;
  for (let i = 0; i < N; i++) {
    const v = atU8(g8, i);
    if (v > m + 30) nl++;
    else if (v < m - 30) nd++;
  }
  const priorLight = nl > nd;
  const cands = new Map<boolean, Candidate>();
  for (const light of [false, true]) {
    let d: Float32Array;
    if (light) {
      const op = morph(morph(g8, w, h, k, false), w, h, k, true);
      d = new Float32Array(N);
      for (let i = 0; i < N; i++) d[i] = atU8(g8, i) - atU8(op, i);
    } else {
      const cl = morph(morph(g8, w, h, k, true), w, h, k, false);
      d = new Float32Array(N);
      for (let i = 0; i < N; i++) d[i] = atU8(cl, i) - atU8(g8, i);
    }
    let dmax = 0;
    for (let i = 0; i < N; i++) if (atF32(d, i) > dmax) dmax = atF32(d, i);
    if (dmax < 10) continue;
    const mx = Math.max(dmax, 1);
    const sc = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const v = f32(f32(atF32(d, i) * 255) / mx);
      sc[i] = v < 0 ? 0 : v > 255 ? 255 : Math.trunc(v);
    }
    const t = Math.max(f32((otsu(sc) * mx) / 255), 12);
    const ink = new Uint8Array(N);
    for (let i = 0; i < N; i++) ink[i] = atF32(d, i) > t ? 1 : 0;
    const { n, lab, st } = components(ink, w, h);
    const keep = new Uint8Array(n);
    const hk: number[] = [];
    for (let l = 1; l < n; l++) {
      const cw = atI32(st.x1, l) - atI32(st.x0, l) + 1;
      const ch = atI32(st.y1, l) - atI32(st.y0, l) + 1;
      const area = atI32(st.area, l);
      const fill = area / Math.max(cw * ch, 1);
      const touch =
        atI32(st.x0, l) <= 0 ||
        atI32(st.y0, l) <= 0 ||
        atI32(st.x0, l) + cw >= w ||
        atI32(st.y0, l) + ch >= h;
      const big =
        (cw > 0.7 * w && fill > 0.35) || ch > 0.9 * h || (touch && (ch > 0.6 * h || cw > 0.5 * w));
      if (area >= 4 && !big) {
        keep[l] = 1;
        hk.push(ch);
      }
    }
    if (!hk.length) continue;
    hk.sort((a, b) => a - b);
    let score = 0;
    for (let i = Math.max(0, hk.length - 40); i < hk.length; i++) score += atNum(hk, i);
    const km = new Uint8Array(N);
    for (let i = 0; i < N; i++) km[i] = atU8(keep, atI32(lab, i));
    cands.set(light, [score, d, km]);
  }
  if (!cands.size) return { norm: null, lines: [] };
  const candidate = (light: boolean): Candidate => {
    const entry = cands.get(light);
    if (entry === undefined) throw new RangeError('no text candidate for the polarity');
    return entry;
  };
  let pick = cands.has(priorLight) ? priorLight : !priorLight;
  if (cands.has(!pick) && candidate(!pick)[0] > 2 * candidate(pick)[0]) pick = !pick;
  const [, d, ink] = candidate(pick);
  const thr = Math.max(1, 0.003 * w);
  const rows = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += atU8(ink, y * w + x);
    rows[y] = s > thr ? 1 : 0;
  }
  const lines: LineBox[] = [];
  for (const [y0, y1] of runs(rows, Math.max(1, Math.trunc(h / 100)))) {
    if (y1 - y0 < 5) continue;
    const cols = new Uint8Array(w);
    for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (atU8(ink, y * w + x)) cols[x] = 1;
    const cr = runs(cols, y1 - y0);
    if (!cr.length) continue;
    const x0 = at(cr, 0)[0];
    const x1 = at(cr, cr.length - 1)[1];
    if (x1 - x0 < 4) continue;
    lines.push([y0, y1, x0, x1]);
  }
  // halo = dilate 3x3 twice = 5x5 box
  const halo = new Uint8Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!atU8(ink, y * w + x)) continue;
      for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++)
        for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) halo[yy * w + xx] = 1;
    }
  const iv: number[] = [];
  for (let i = 0; i < N; i++) if (atU8(ink, i)) iv.push(atF32(d, i));
  const p90 = Math.max(iv.length ? percentile(iv, 90) : 1, 1);
  const norm = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!atU8(halo, i)) {
      norm[i] = 255;
      continue;
    }
    const v = 255 - Math.min(Math.max((atF32(d, i) * 255) / p90, 0), 255);
    norm[i] = Math.trunc(v);
  }
  return { norm: { w, h, c: 1, data: norm }, lines };
}
