import { at, atF32, atU8 } from './at';

/** An 8-bit image: `c` = 1 (gray) or 3 (RGB, interleaved). */
export interface Img {
  w: number;
  h: number;
  c: 1 | 3;
  data: Uint8Array;
}

export type ResizeMode = 'area' | 'linear' | 'cubic';

export function fromRGBA(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Img {
  const d = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    d[i * 3] = atU8(rgba, j);
    d[i * 3 + 1] = atU8(rgba, j + 1);
    d[i * 3 + 2] = atU8(rgba, j + 2);
  }
  return { w, h, c: 3, data: d };
}

export function toGray(im: Img): Uint8Array {
  // cv2 RGB2GRAY fixed point
  if (im.c === 1) return im.data;
  const n = im.w * im.h;
  const g = new Uint8Array(n);
  const d = im.data;
  for (let i = 0; i < n; i++) {
    g[i] =
      (atU8(d, i * 3) * 4899 + atU8(d, i * 3 + 1) * 9617 + atU8(d, i * 3 + 2) * 1868 + 8192) >> 14;
  }
  return g;
}

/** Round half to even (numpy/cv2 `rint`). */
export function rint(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

type Weights = [number, number][][];

function areaWeights(src: number, dst: number): Weights {
  const s = src / dst;
  const W: Weights = [];
  for (let i = 0; i < dst; i++) {
    const a = i * s;
    const b = a + s;
    const ws: [number, number][] = [];
    for (let j = Math.floor(a); j < Math.min(Math.ceil(b), src); j++) {
      const o = Math.min(b, j + 1) - Math.max(a, j);
      if (o > 1e-9) ws.push([j, o / s]);
    }
    W.push(ws);
  }
  return W;
}

function interpWeights(src: number, dst: number, cubic: boolean): Weights {
  const s = src / dst;
  const W: Weights = [];
  const A = -0.75;
  const cl = (j: number) => Math.min(Math.max(j, 0), src - 1);
  for (let i = 0; i < dst; i++) {
    const fx = (i + 0.5) * s - 0.5;
    let x0 = Math.floor(fx);
    let t = fx - x0;
    if (!cubic) {
      if (fx < 0) {
        x0 = 0;
        t = 0;
      }
      if (x0 >= src - 1) {
        x0 = src - 1;
        t = 0;
      }
      W.push([
        [cl(x0), 1 - t],
        [cl(x0 + 1), t],
      ]);
      continue;
    }
    const c0 = ((A * (t + 1) - 5 * A) * (t + 1) + 8 * A) * (t + 1) - 4 * A;
    const c1 = ((A + 2) * t - (A + 3)) * t * t + 1;
    const c2 = ((A + 2) * (1 - t) - (A + 3)) * (1 - t) * (1 - t) + 1;
    W.push([
      [cl(x0 - 1), c0],
      [cl(x0), c1],
      [cl(x0 + 1), c2],
      [cl(x0 + 2), 1 - c0 - c1 - c2],
    ]);
  }
  return W;
}

export function resize(im: Img, nw: number, nh: number, mode: ResizeMode): Img {
  const { w, h, c, data } = im;
  if (nw === w && nh === h) return { w, h, c, data: data.slice() };
  const mk = (s: number, d: number) =>
    mode === 'area' && s >= d ? areaWeights(s, d) : interpWeights(s, d, mode === 'cubic');
  const WX = mk(w, nw);
  const WY = mk(h, nh);
  const tmp = new Float32Array(nw * h * c);
  const out = new Uint8Array(nw * nh * c);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < nw; x++)
      for (let ch = 0; ch < c; ch++) {
        let s = 0;
        for (const [j, wt] of at(WX, x)) s += wt * atU8(data, (y * w + j) * c + ch);
        tmp[(y * nw + x) * c + ch] = s;
      }
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++)
      for (let ch = 0; ch < c; ch++) {
        let s = 0;
        for (const [j, wt] of at(WY, y)) s += wt * atF32(tmp, (j * nw + x) * c + ch);
        out[(y * nw + x) * c + ch] = Math.min(255, Math.max(0, rint(s)));
      }
  return { w: nw, h: nh, c, data: out };
}
