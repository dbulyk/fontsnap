// Shared JS evaluation: runs the extension's pipeline (extension/lib/fontsnap-core.js) on a labelled image set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { fromRGBA, textLines, cropNormalize, prep, softmax, makeRanker, nz } from '../../extension/lib/fontsnap-core.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MODEL = path.join(ROOT, 'extension', 'model', 'model_fp16.onnx');
export const META = path.join(ROOT, 'extension', 'model', 'meta.json');

export function parseCsv(text) {
  const rows = [];
  let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

export function loadPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return fromRGBA(png.data, png.width, png.height);
}

export async function createSession(backend = 'node', threads = 0) {
  const bytes = fs.readFileSync(MODEL);
  if (bytes.subarray(0, 40).toString().includes('git-lfs')) throw new Error('model is a Git LFS pointer; run `git lfs pull`');
  if (backend === 'web') {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.numThreads = threads || 1;
    const s = await ort.InferenceSession.create(new Uint8Array(bytes));
    return { ort, s };
  }
  const ort = await import('onnxruntime-node');
  const s = await ort.InferenceSession.create(MODEL, threads ? { intraOpNumThreads: threads } : {});
  return { ort, s };
}

export async function predict({ ort, s }, img) {
  const pre = textLines(img), P = {};
  for (const v of ['pack', 'crop']) {
    const x = prep(cropNormalize(img, v, 96, 6, pre));
    const o = await s.run({ input: new ort.Tensor('float32', x, [1, 3, 320, 320]) });
    P[v] = softmax(o.logits.data);
  }
  return P;
}

export const CONFIGS = { bare: { v: ['pack'], alpha: 0, merge: false }, best: { v: ['pack', 'crop'], alpha: 0.5, merge: true } };

export async function evaluate({ set = path.join(ROOT, 'data', 'realset3'), backend = 'node', limit = 0, threads = 0 } = {}) {
  const meta = JSON.parse(fs.readFileSync(META)), R = makeRanker(meta), sess = await createSession(backend, threads);
  let rows = parseCsv(fs.readFileSync(path.join(set, 'labels.csv'), 'utf8'));
  if (limit) rows = rows.slice(0, limit);
  const preds = {}, acc = { bare: [0, 0], best: [0, 0] }, t0 = Date.now();
  for (const { image, label } of rows) {
    const P = await predict(sess, loadPng(path.join(set, 'images', image)));
    preds[image] = {};
    for (const [c, cf] of Object.entries(CONFIGS)) {
      const top = R.rank(cf.v.map((v) => P[v]), { alpha: cf.alpha, merge: cf.merge, k: 5 }).map((o) => o.key);
      const lb = cf.merge ? R.mg(nz(label)) : nz(label);
      preds[image][c] = top;
      acc[c][0] += top[0] === lb;
      acc[c][1] += top.includes(lb);
    }
  }
  const n = rows.length, pc = (v) => Math.round((1000 * v) / n) / 10;
  const metrics = Object.fromEntries(Object.entries(acc).map(([c, [a1, a5]]) => [c, { n, top1: pc(a1), top5: pc(a5) }]));
  return { metrics, preds, msPerImage: Math.round((Date.now() - t0) / Math.max(n, 1)), backend };
}
