// Preprocessing for the font classifier: JS port of textcrop.crop_normalize + the 320x320 NCHW input.
import { at, atNum, atU8 } from './at';
import { resize, type Img } from './image';
import { runs, textLines, type TextLines } from './textcrop';

export const LINE_H = 96;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
const f32 = Math.fround;

export type CropMode = 'pack' | 'crop';

function sub(im: Img, y0: number, y1: number, x0: number, x1: number): Img {
  const w = x1 - x0;
  const h = y1 - y0;
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    o.set(im.data.subarray((y0 + y) * im.w + x0, (y0 + y) * im.w + x1), y * w);
  }
  return { w, h, c: 1, data: o };
}

function canvas(w: number, h: number): Img {
  return { w, h, c: 1, data: new Uint8Array(w * h).fill(255) };
}

function blit(dst: Img, src: Img, oy: number, ox: number): void {
  for (let y = 0; y < src.h; y++) {
    dst.data.set(src.data.subarray(y * src.w, (y + 1) * src.w), (oy + y) * dst.w + ox);
  }
}

export function cropNormalize(
  img: Img,
  mode: CropMode = 'pack',
  lineH = LINE_H,
  maxLines = 6,
  pre: TextLines | null = null,
): Img {
  const { norm, lines: L0 } = pre ?? textLines(img);
  if (!L0.length || norm === null) return norm ?? img;
  let lines = L0.map((b, i): [number, number, number, number, number] => [...b, i])
    .sort((a, b) => (b[1] - b[0]) * (b[3] - b[2]) - (a[1] - a[0]) * (a[3] - a[2]) || a[4] - b[4])
    .slice(0, maxLines);
  lines.sort((a, b) => a[0] - b[0] || a[4] - b[4]);
  const hs = lines.map((b) => b[1] - b[0]).sort((a, b) => a - b);
  const n = hs.length;
  const ref = n % 2 ? atNum(hs, (n - 1) / 2) : (atNum(hs, n / 2 - 1) + atNum(hs, n / 2)) / 2;
  lines = lines.filter((b) => b[1] - b[0] > 0.4 * ref);
  const H = norm.h;
  const W = norm.w;
  const strips: Img[] = [];
  for (const [y0, y1, x0, x1] of lines) {
    const m = Math.trunc(0.15 * (y1 - y0)) + 1;
    const s = sub(
      norm,
      Math.max(0, y0 - m),
      Math.min(H, y1 + m),
      Math.max(0, x0 - m),
      Math.min(W, x1 + m),
    );
    const sc = lineH / s.h;
    strips.push(resize(s, Math.max(1, Math.trunc(s.w * sc)), lineH, sc > 1 ? 'cubic' : 'area'));
  }
  const gap = Math.trunc(lineH / 3);
  const stack = (pieces: Img[]): Img => {
    const cw = Math.max(...pieces.map((p) => p.w));
    const out = canvas(cw + 2 * gap, pieces.length * (lineH + gap) + gap);
    pieces.forEach((p, i) => {
      blit(out, p, gap + i * (lineH + gap), gap);
    });
    return out;
  };
  if (mode === 'crop') return stack(strips);
  const total = strips.reduce((a, s) => a + s.w + gap, 0);
  const row = canvas(total, lineH);
  let ox = 0;
  for (const s of strips) {
    blit(row, s, 0, ox);
    ox += s.w + gap;
  }
  const nrows = Math.min(Math.max(Math.floor(Math.sqrt(total / (2.5 * lineH))), 1), 4);
  const target = total / nrows;
  const colblank = new Uint8Array(total);
  for (let x = 0; x < total; x++) {
    let b = 1;
    for (let y = 0; y < lineH; y++)
      if (atU8(row.data, y * total + x) < 200) {
        b = 0;
        break;
      }
    colblank[x] = b;
  }
  const blank = new Uint8Array(total);
  for (const [a, b] of runs(colblank, 1)) if (b - a >= Math.trunc(lineH / 4)) blank.fill(1, a, b);
  const gaps = runs(blank, 1).map(([a, b]) => Math.trunc((a + b) / 2));
  const cuts: number[] = [];
  for (let r = 1; r < nrows; r++) {
    if (!gaps.length) break;
    let bi = 0;
    for (let i = 1; i < gaps.length; i++) {
      if (Math.abs(atNum(gaps, i) - r * target) < Math.abs(atNum(gaps, bi) - r * target)) bi = i;
    }
    const c = atNum(gaps, bi);
    if ((!cuts.length || c > atNum(cuts, cuts.length - 1) + lineH) && c < total - lineH)
      cuts.push(c);
  }
  const edges = [0, ...cuts, total];
  const pieces: Img[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const p = canvas(atNum(edges, i + 1) - atNum(edges, i), lineH);
    for (let y = 0; y < lineH; y++) {
      p.data.set(
        row.data.subarray(y * total + atNum(edges, i), y * total + atNum(edges, i + 1)),
        y * p.w,
      );
    }
    pieces.push(p);
  }
  return stack(pieces);
}

/** The model input: Float32Array NCHW, aspect-preserving resize into S×S with white padding. */
export function prep(im: Img, S = 320): Float32Array {
  let src = im;
  const cw = Math.min(im.w, 1024);
  const chh = Math.min(im.h, 1024);
  if (cw !== im.w || chh !== im.h) {
    const o = new Uint8Array(cw * chh * im.c);
    for (let y = 0; y < chh; y++) {
      o.set(im.data.subarray(y * im.w * im.c, (y * im.w + cw) * im.c), y * cw * im.c);
    }
    src = { w: cw, h: chh, c: im.c, data: o };
  }
  const { w, h } = src;
  const r = S / Math.max(h, w);
  const nw = Math.max(1, Math.trunc(w * r));
  const nh = Math.max(1, Math.trunc(h * r));
  const rs = resize(src, nw, nh, r < 1 ? 'area' : 'linear');
  const dw = S - nw;
  const dh = S - nh;
  const ox = dw >> 1;
  const oy = dh >> 1;
  const out = new Float32Array(3 * S * S);
  for (let ch = 0; ch < 3; ch++) {
    const bg = (1 - atNum(MEAN, ch)) / atNum(STD, ch);
    out.fill(bg, ch * S * S, (ch + 1) * S * S);
  }
  for (let y = 0; y < nh; y++)
    for (let x = 0; x < nw; x++)
      for (let ch = 0; ch < 3; ch++) {
        const v = atU8(rs.data, (y * nw + x) * rs.c + (rs.c === 1 ? 0 : ch));
        out[ch * S * S + (y + oy) * S + x + ox] = (f32(v / 255) - atNum(MEAN, ch)) / atNum(STD, ch);
      }
  return out;
}

export function softmax(lg: ArrayLike<number>): Float64Array {
  let m = -Infinity;
  for (let i = 0; i < lg.length; i++) {
    const v = at(lg, i);
    if (v > m) m = v;
  }
  const p = new Float64Array(lg.length);
  let s = 0;
  for (let i = 0; i < lg.length; i++) {
    p[i] = Math.exp(at(lg, i) - m);
    s += at(p, i);
  }
  for (let i = 0; i < p.length; i++) p[i] = at(p, i) / s;
  return p;
}

/** Normalized family key: lower case, letters and digits only. */
export const nz = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
