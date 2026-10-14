// FontSnap core: JS port of textcrop.crop_normalize + preprocessing + family aggregation.
// Pure JS (no DOM), works in the extension and in Node. Images: {w,h,c,data:Uint8Array} with c=1 (gray) or 3 (RGB).
export const LINE_H = 96;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

export function fromRGBA(rgba, w, h) { const d = new Uint8Array(w * h * 3); for (let i = 0, j = 0; i < w * h; i++, j += 4) { d[i*3] = rgba[j]; d[i*3+1] = rgba[j+1]; d[i*3+2] = rgba[j+2]; } return { w, h, c: 3, data: d }; }
function toGray(im) { // cv2 RGB2GRAY fixed point
  if (im.c === 1) return im.data; const n = im.w * im.h, g = new Uint8Array(n), d = im.data;
  for (let i = 0; i < n; i++) g[i] = (d[i*3] * 4899 + d[i*3+1] * 9617 + d[i*3+2] * 1868 + 8192) >> 14; return g;
}
function rint(x) { const r = Math.round(x); return (Math.abs(x % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r; }
function otsu(v) { // v: array of uint8 values; cv2 getThreshVal_Otsu_8u
  const h = new Float64Array(256); for (let i = 0; i < v.length; i++) h[v[i]]++; const N = v.length;
  let mu = 0; for (let i = 0; i < 256; i++) { h[i] /= N; mu += i * h[i]; }
  let q1 = 0, mu1 = 0, maxS = 0, maxV = 0; const EPS = 1.1920929e-7;
  for (let i = 0; i < 256; i++) { const p = h[i]; mu1 *= q1; q1 += p; const q2 = 1 - q1;
    if (Math.min(q1, q2) < EPS || Math.max(q1, q2) > 1 - EPS) continue;
    mu1 = (mu1 + i * p) / q1; const mu2 = (mu - q1 * mu1) / q2, s = q1 * q2 * (mu1 - mu2) ** 2; if (s > maxS) { maxS = s; maxV = i; } }
  return maxV;
}
function runs(mask, minGap) { const out = []; let s = -1, p = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { if (s < 0) s = p = i; else { if (i - p > minGap) { out.push([s, p + 1]); s = i; } p = i; } }
  if (s >= 0) out.push([s, p + 1]); return out; }
function ellipse(k) { const r = k >> 1, c = k >> 1, half = []; // half-width per row
  for (let i = 0; i < k; i++) { const dy = i - r; half.push(rint(c * Math.sqrt((r * r - dy * dy) / (r * r)))); } return half; }
// grayscale morphology (min/max) with ellipse; out-of-bounds pixels ignored (cv2 default border for morphology)
function morph(g, w, h, k, isMax) {
  const half = ellipse(k), r = k >> 1, uniq = [...new Set(half)], rowF = new Map();
  const tmp = new Uint8Array(w);
  for (const dx of uniq) { const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { const base = y * w;
      // sliding window via van Herk/Gil-Werman over window 2dx+1 with clipped borders
      const W = 2 * dx + 1, L = w + 2 * dx, pad = new Uint8Array(L), fv = isMax ? 0 : 255;
      for (let x = 0; x < L; x++) { const sx = x - dx; pad[x] = (sx >= 0 && sx < w) ? g[base + sx] : fv; }
      const pre = new Uint8Array(L), suf = new Uint8Array(L);
      for (let x = 0; x < L; x++) pre[x] = (x % W === 0) ? pad[x] : (isMax ? Math.max(pre[x-1], pad[x]) : Math.min(pre[x-1], pad[x]));
      for (let x = L - 1; x >= 0; x--) suf[x] = (x % W === W - 1 || x === L - 1) ? pad[x] : (isMax ? Math.max(suf[x+1], pad[x]) : Math.min(suf[x+1], pad[x]));
      for (let x = 0; x < w; x++) { const a = suf[x], b = pre[x + W - 1]; o[base + x] = isMax ? (a > b ? a : b) : (a < b ? a : b); }
    }
    rowF.set(dx, o); }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = isMax ? 0 : 255;
    for (let i = 0; i < k; i++) { const yy = y + i - r; if (yy < 0 || yy >= h) continue; const q = rowF.get(half[i])[yy * w + x]; if (isMax ? q > v : q < v) v = q; }
    out[y * w + x] = v; }
  return out;
}
function components(ink, w, h) { // 8-connectivity labels + stats
  const lab = new Int32Array(w * h), par = [0];
  const find = a => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) par[b] = a; else par[a] = b; } };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!ink[i]) continue; let l = 0;
    const nb = [x > 0 ? i - 1 : -1, y > 0 && x > 0 ? i - w - 1 : -1, y > 0 ? i - w : -1, y > 0 && x < w - 1 ? i - w + 1 : -1];
    for (const j of nb) if (j >= 0 && lab[j]) { if (!l) l = lab[j]; else uni(l, lab[j]); }
    if (!l) { l = par.length; par.push(l); } lab[i] = l; }
  const map = new Int32Array(par.length); let n = 1; for (let i = 1; i < par.length; i++) { const r = find(i); map[i] = r === i ? n++ : 0; }
  for (let i = 1; i < par.length; i++) map[i] = map[find(i)];
  const st = { x0: new Int32Array(n).fill(1e9), y0: new Int32Array(n).fill(1e9), x1: new Int32Array(n).fill(-1), y1: new Int32Array(n).fill(-1), area: new Int32Array(n) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!lab[i]) continue; const l = map[lab[i]]; lab[i] = l;
    st.area[l]++; if (x < st.x0[l]) st.x0[l] = x; if (x > st.x1[l]) st.x1[l] = x; if (y < st.y0[l]) st.y0[l] = y; if (y > st.y1[l]) st.y1[l] = y; }
  return { n, lab, st };
}
function percentile(arr, q) { const a = Float64Array.from(arr).sort(); if (!a.length) return 0; const pos = (a.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos); return a[lo] + (a[hi] - a[lo]) * (pos - lo); }
const f32 = Math.fround;
export function textLines(img) {
  const { w, h } = img, g8 = toGray(img), N = w * h;
  const k = Math.min(Math.max(Math.trunc(h * 0.5), 9), 61) | 1;
  const hist = new Float64Array(256); for (let i = 0; i < N; i++) hist[g8[i]]++;
  let m = 0, best = -1; for (let i = 0; i < 256; i++) { let s = 0; for (let j = i - 4; j <= i + 4; j++) if (j >= 0 && j < 256) s += hist[j]; s /= 9; if (s > best) { best = s; m = i; } }
  let nl = 0, nd = 0; for (let i = 0; i < N; i++) { if (g8[i] > m + 30) nl++; else if (g8[i] < m - 30) nd++; }
  const priorLight = nl > nd, cands = new Map();
  for (const light of [false, true]) {
    let d;
    if (light) { const op = morph(morph(g8, w, h, k, false), w, h, k, true); d = new Float32Array(N); for (let i = 0; i < N; i++) d[i] = g8[i] - op[i]; }
    else { const cl = morph(morph(g8, w, h, k, true), w, h, k, false); d = new Float32Array(N); for (let i = 0; i < N; i++) d[i] = cl[i] - g8[i]; }
    let dmax = 0; for (let i = 0; i < N; i++) if (d[i] > dmax) dmax = d[i];
    if (dmax < 10) continue;
    const mx = Math.max(dmax, 1), sc = new Uint8Array(N); for (let i = 0; i < N; i++) { const v = f32(f32(d[i] * 255) / mx); sc[i] = v < 0 ? 0 : v > 255 ? 255 : Math.trunc(v); }
    const t = Math.max(f32(otsu(sc) * mx / 255), 12);
    const ink = new Uint8Array(N); for (let i = 0; i < N; i++) ink[i] = d[i] > t ? 1 : 0;
    const { n, lab, st } = components(ink, w, h), keep = new Uint8Array(n), hk = [];
    for (let l = 1; l < n; l++) { const cw = st.x1[l] - st.x0[l] + 1, ch = st.y1[l] - st.y0[l] + 1, area = st.area[l], fill = area / Math.max(cw * ch, 1);
      const touch = st.x0[l] <= 0 || st.y0[l] <= 0 || st.x0[l] + cw >= w || st.y0[l] + ch >= h;
      const big = (cw > 0.7 * w && fill > 0.35) || ch > 0.9 * h || (touch && (ch > 0.6 * h || cw > 0.5 * w));
      if (area >= 4 && !big) { keep[l] = 1; hk.push(ch); } }
    if (!hk.length) continue;
    hk.sort((a, b) => a - b); let score = 0; for (let i = Math.max(0, hk.length - 40); i < hk.length; i++) score += hk[i];
    const km = new Uint8Array(N); for (let i = 0; i < N; i++) km[i] = keep[lab[i]];
    cands.set(light, [score, d, km]);
  }
  if (!cands.size) return { norm: null, lines: [] };
  let pick = cands.has(priorLight) ? priorLight : !priorLight;
  if (cands.has(!pick) && cands.get(!pick)[0] > 2 * cands.get(pick)[0]) pick = !pick;
  const [, d, ink] = cands.get(pick);
  const thr = Math.max(1, 0.003 * w), rows = new Uint8Array(h);
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) s += ink[y * w + x]; rows[y] = s > thr ? 1 : 0; }
  const lines = [];
  for (const [y0, y1] of runs(rows, Math.max(1, Math.trunc(h / 100)))) { if (y1 - y0 < 5) continue;
    const cols = new Uint8Array(w); for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) if (ink[y * w + x]) cols[x] = 1;
    const cr = runs(cols, y1 - y0); if (!cr.length) continue; const x0 = cr[0][0], x1 = cr[cr.length - 1][1]; if (x1 - x0 < 4) continue; lines.push([y0, y1, x0, x1]); }
  // halo = dilate 3x3 twice = 5x5 box
  const halo = new Uint8Array(N); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (!ink[y * w + x]) continue;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++) for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++) halo[yy * w + xx] = 1; }
  const iv = []; for (let i = 0; i < N; i++) if (ink[i]) iv.push(d[i]);
  const p90 = Math.max(iv.length ? percentile(iv, 90) : 1, 1), norm = new Uint8Array(N);
  for (let i = 0; i < N; i++) { if (!halo[i]) { norm[i] = 255; continue; } const v = 255 - Math.min(Math.max(d[i] * 255 / p90, 0), 255); norm[i] = Math.trunc(v); }
  return { norm: { w, h, c: 1, data: norm }, lines };
}
// ---- resize (cv2-like) ----
function areaWeights(src, dst) { const s = src / dst, W = [];
  for (let i = 0; i < dst; i++) { const a = i * s, b = a + s, ws = []; for (let j = Math.floor(a); j < Math.min(Math.ceil(b), src); j++) { const o = Math.min(b, j + 1) - Math.max(a, j); if (o > 1e-9) ws.push([j, o / s]); } W.push(ws); } return W; }
function interpWeights(src, dst, cubic) { const s = src / dst, W = [], A = -0.75, cl = j => Math.min(Math.max(j, 0), src - 1);
  for (let i = 0; i < dst; i++) { let fx = (i + 0.5) * s - 0.5; let x0 = Math.floor(fx), t = fx - x0;
    if (!cubic) { if (fx < 0) { x0 = 0; t = 0; } if (x0 >= src - 1) { x0 = src - 1; t = 0; } W.push([[cl(x0), 1 - t], [cl(x0 + 1), t]]); continue; }
    const c0 = ((A * (t + 1) - 5 * A) * (t + 1) + 8 * A) * (t + 1) - 4 * A, c1 = ((A + 2) * t - (A + 3)) * t * t + 1, c2 = ((A + 2) * (1 - t) - (A + 3)) * (1 - t) * (1 - t) + 1;
    W.push([[cl(x0 - 1), c0], [cl(x0), c1], [cl(x0 + 1), c2], [cl(x0 + 2), 1 - c0 - c1 - c2]]); } return W; }
export function resize(im, nw, nh, mode) { // mode: 'area' | 'linear' | 'cubic'
  const { w, h, c, data } = im; if (nw === w && nh === h) return { w, h, c, data: data.slice() };
  const mk = (s, d) => mode === 'area' && s >= d ? areaWeights(s, d) : interpWeights(s, d, mode === 'cubic');
  const WX = mk(w, nw), WY = mk(h, nh), tmp = new Float32Array(nw * h * c), out = new Uint8Array(nw * nh * c);
  for (let y = 0; y < h; y++) for (let x = 0; x < nw; x++) for (let ch = 0; ch < c; ch++) { let s = 0; for (const [j, wt] of WX[x]) s += wt * data[(y * w + j) * c + ch]; tmp[(y * nw + x) * c + ch] = s; }
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let ch = 0; ch < c; ch++) { let s = 0; for (const [j, wt] of WY[y]) s += wt * tmp[(j * nw + x) * c + ch]; out[(y * nw + x) * c + ch] = Math.min(255, Math.max(0, rint(s))); }
  return { w: nw, h: nh, c, data: out };
}
function sub(im, y0, y1, x0, x1) { const w = x1 - x0, h = y1 - y0, o = new Uint8Array(w * h); for (let y = 0; y < h; y++) o.set(im.data.subarray((y0 + y) * im.w + x0, (y0 + y) * im.w + x1), y * w); return { w, h, c: 1, data: o }; }
function canvas(w, h) { return { w, h, c: 1, data: new Uint8Array(w * h).fill(255) }; }
function blit(dst, src, oy, ox) { for (let y = 0; y < src.h; y++) dst.data.set(src.data.subarray(y * src.w, (y + 1) * src.w), (oy + y) * dst.w + ox); }
export function cropNormalize(img, mode = 'pack', lineH = LINE_H, maxLines = 6, pre = null) {
  const { norm, lines: L0 } = pre || textLines(img);
  if (!L0.length) return norm || img;
  let lines = L0.map((b, i) => [...b, i]).sort((a, b) => ((b[1] - b[0]) * (b[3] - b[2])) - ((a[1] - a[0]) * (a[3] - a[2])) || a[4] - b[4]).slice(0, maxLines);
  lines.sort((a, b) => a[0] - b[0] || a[4] - b[4]);
  const hs = lines.map(b => b[1] - b[0]).sort((a, b) => a - b), n = hs.length, ref = n % 2 ? hs[(n - 1) / 2] : (hs[n / 2 - 1] + hs[n / 2]) / 2;
  lines = lines.filter(b => (b[1] - b[0]) > 0.4 * ref);
  const H = norm.h, W = norm.w, strips = [];
  for (const [y0, y1, x0, x1] of lines) { const m = Math.trunc(0.15 * (y1 - y0)) + 1;
    const s = sub(norm, Math.max(0, y0 - m), Math.min(H, y1 + m), Math.max(0, x0 - m), Math.min(W, x1 + m)); const sc = lineH / s.h;
    strips.push(resize(s, Math.max(1, Math.trunc(s.w * sc)), lineH, sc > 1 ? 'cubic' : 'area')); }
  const gap = Math.trunc(lineH / 3);
  const stack = pieces => { const cw = Math.max(...pieces.map(p => p.w)), out = canvas(cw + 2 * gap, pieces.length * (lineH + gap) + gap); pieces.forEach((p, i) => blit(out, p, gap + i * (lineH + gap), gap)); return out; };
  if (mode === 'crop') return stack(strips);
  const total = strips.reduce((a, s) => a + s.w + gap, 0), row = canvas(total, lineH); let ox = 0; for (const s of strips) { blit(row, s, 0, ox); ox += s.w + gap; }
  const nrows = Math.min(Math.max(Math.floor(Math.sqrt(total / (2.5 * lineH))), 1), 4), target = total / nrows;
  const colblank = new Uint8Array(total); for (let x = 0; x < total; x++) { let b = 1; for (let y = 0; y < lineH; y++) if (row.data[y * total + x] < 200) { b = 0; break; } colblank[x] = b; }
  const blank = new Uint8Array(total); for (const [a, b] of runs(colblank, 1)) if (b - a >= Math.trunc(lineH / 4)) blank.fill(1, a, b);
  const gaps = runs(blank, 1).map(([a, b]) => Math.trunc((a + b) / 2)), cuts = [];
  for (let r = 1; r < nrows; r++) { if (!gaps.length) break; let bi = 0; for (let i = 1; i < gaps.length; i++) if (Math.abs(gaps[i] - r * target) < Math.abs(gaps[bi] - r * target)) bi = i;
    const c = gaps[bi]; if ((!cuts.length || c > cuts[cuts.length - 1] + lineH) && c < total - lineH) cuts.push(c); }
  const edges = [0, ...cuts, total], pieces = [];
  for (let i = 0; i < edges.length - 1; i++) { const p = canvas(edges[i + 1] - edges[i], lineH); for (let y = 0; y < lineH; y++) p.data.set(row.data.subarray(y * total + edges[i], y * total + edges[i + 1]), y * p.w); pieces.push(p); }
  return stack(pieces);
}
export function prep(im, S = 320) { // -> Float32Array NCHW
  let src = im; const cw = Math.min(im.w, 1024), chh = Math.min(im.h, 1024);
  if (cw !== im.w || chh !== im.h) { const o = new Uint8Array(cw * chh * im.c); for (let y = 0; y < chh; y++) o.set(im.data.subarray(y * im.w * im.c, (y * im.w + cw) * im.c), y * cw * im.c); src = { w: cw, h: chh, c: im.c, data: o }; }
  const { w, h } = src, r = S / Math.max(h, w), nw = Math.max(1, Math.trunc(w * r)), nh = Math.max(1, Math.trunc(h * r));
  const rs = resize(src, nw, nh, r < 1 ? 'area' : 'linear'), dw = S - nw, dh = S - nh, ox = dw >> 1, oy = dh >> 1, out = new Float32Array(3 * S * S);
  for (let ch = 0; ch < 3; ch++) { const bg = (1 - MEAN[ch]) / STD[ch]; out.fill(bg, ch * S * S, (ch + 1) * S * S); }
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let ch = 0; ch < 3; ch++) { const v = rs.data[(y * nw + x) * rs.c + (rs.c === 1 ? 0 : ch)];
    out[ch * S * S + (y + oy) * S + x + ox] = (f32(v / 255) - MEAN[ch]) / STD[ch]; }
  return out;
}
export function softmax(lg) { let m = -Infinity; for (const v of lg) if (v > m) m = v; const p = new Float64Array(lg.length); let s = 0; for (let i = 0; i < lg.length; i++) { p[i] = Math.exp(lg[i] - m); s += p[i]; } for (let i = 0; i < p.length; i++) p[i] /= s; return p; }
export const nz = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
export function makeRanker(meta) {
  const keep = meta.keepNoto, mg = f => (f.startsWith('notosans') && !keep.some(k => f.startsWith(k))) ? 'notosans' : (meta.merge[f] || f);
  const idx = Object.fromEntries(meta.fams.map((f, i) => [f, i]));
  function rank(probList, { alpha = 0.5, merge = true, k = 5 } = {}) {
    const nf = meta.fams.length, fp = new Float64Array(nf);
    for (const p of probList) for (let i = 0; i < p.length; i++) fp[meta.classFam[i]] += p[i] / probList.length;
    if (alpha) for (let i = 0; i < nf; i++) fp[i] *= meta.rank[i] ** -alpha;
    const order = [...fp.keys()].sort((a, b) => fp[b] - fp[a] || a - b).slice(0, 40); const out = [];
    for (const i of order) { const f = merge ? mg(meta.fams[i]) : meta.fams[i]; if (out.some(o => o.key === f)) continue;
      const j = idx[f] ?? i; out.push({ key: f, name: meta.display[j], inGF: meta.inGF[j], category: meta.category[j], score: fp[i] }); }
    const top = out.slice(0, k), tot = top.reduce((a, o) => a + o.score, 0) || 1; return top.map(o => ({ ...o, conf: o.score / tot }));
  }
  return { rank, mg };
}
