// Shared JS evaluation: runs the extension's recognition pipeline (src/shared/core) on a labelled image set.
// A development tool (not part of the extension); see README.md "Tests".
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ortNode from 'onnxruntime-node';
import { PNG } from 'pngjs';
import { fromRGBA, type Img } from '../../src/shared/core/image';
import { cropNormalize, nz, prep, softmax } from '../../src/shared/core/pipeline';
import { makeRanker, type Meta } from '../../src/shared/core/ranker';
import { textLines } from '../../src/shared/core/textcrop';
import type { Predictions } from '../lib/regression';

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const MODEL = join(ROOT, 'model', 'model_fp16.onnx');
export const META = join(ROOT, 'model', 'meta.json');

export type Backend = 'node' | 'web';

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(f);
      f = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f);
      f = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else f += c;
  }
  if (f !== '' || row.length) {
    row.push(f);
    rows.push(row);
  }
  const [head = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

export function loadPng(file: string): Img {
  const png = PNG.sync.read(readFileSync(file));
  return fromRGBA(png.data, png.width, png.height);
}

export interface Session {
  ort: typeof ortNode;
  s: ortNode.InferenceSession;
}

export async function createSession(backend: Backend = 'node', threads = 0): Promise<Session> {
  const bytes = readFileSync(MODEL);
  if (bytes.subarray(0, 40).toString().includes('git-lfs')) {
    throw new Error('model is a Git LFS pointer; run `git lfs pull`');
  }
  if (backend === 'web') {
    const ort = (await import('onnxruntime-web')) as unknown as typeof ortNode & {
      env: { wasm: { numThreads: number } };
    };
    ort.env.wasm.numThreads = threads || 1;
    const s = await ort.InferenceSession.create(new Uint8Array(bytes));
    return { ort, s };
  }
  const s = await ortNode.InferenceSession.create(
    MODEL,
    threads ? { intraOpNumThreads: threads } : {},
  );
  return { ort: ortNode, s };
}

export async function predict(
  { ort, s }: Session,
  img: Img,
): Promise<Record<'pack' | 'crop', Float64Array>> {
  const pre = textLines(img);
  const P: Partial<Record<'pack' | 'crop', Float64Array>> = {};
  for (const v of ['pack', 'crop'] as const) {
    const x = prep(cropNormalize(img, v, 96, 6, pre));
    const o = await s.run({ input: new ort.Tensor('float32', x, [1, 3, 320, 320]) });
    P[v] = softmax(o['logits']?.data as Float32Array);
  }
  return P as Record<'pack' | 'crop', Float64Array>;
}

export const CONFIGS = {
  bare: { v: ['pack'], alpha: 0, merge: false },
  best: { v: ['pack', 'crop'], alpha: 0.5, merge: true },
} as const;

export interface Metrics {
  n: number;
  top1: number;
  top5: number;
}

export interface Evaluation {
  metrics: Record<'bare' | 'best', Metrics>;
  preds: Predictions;
  msPerImage: number;
  backend: Backend;
}

export async function evaluate({
  set = join(ROOT, 'data', 'realset3'),
  backend = 'node',
  limit = 0,
  threads = 0,
}: {
  set?: string;
  backend?: Backend;
  limit?: number;
  threads?: number;
} = {}): Promise<Evaluation> {
  const meta = JSON.parse(readFileSync(META, 'utf8')) as Meta;
  const R = makeRanker(meta);
  const sess = await createSession(backend, threads);
  let rows = parseCsv(readFileSync(join(set, 'labels.csv'), 'utf8'));
  if (limit) rows = rows.slice(0, limit);
  const preds: Predictions = {};
  const acc = { bare: [0, 0], best: [0, 0] };
  const t0 = Date.now();
  for (const { image = '', label = '' } of rows) {
    const P = await predict(sess, loadPng(join(set, 'images', image)));
    const entry: Record<'bare' | 'best', string[]> = { bare: [], best: [] };
    for (const c of ['bare', 'best'] as const) {
      const cf = CONFIGS[c];
      const top = R.rank(
        cf.v.map((v) => P[v]),
        { alpha: cf.alpha, merge: cf.merge, k: 5 },
      ).map((o) => o.key);
      const lb = cf.merge ? R.mg(nz(label)) : nz(label);
      entry[c] = top;
      acc[c][0] = (acc[c][0] ?? 0) + (top[0] === lb ? 1 : 0);
      acc[c][1] = (acc[c][1] ?? 0) + (top.includes(lb) ? 1 : 0);
    }
    preds[image] = entry;
  }
  const n = rows.length;
  const pc = (v: number) => Math.round((1000 * v) / n) / 10;
  const metric = (c: 'bare' | 'best'): Metrics => ({
    n,
    top1: pc(acc[c][0] ?? 0),
    top5: pc(acc[c][1] ?? 0),
  });
  return {
    metrics: { bare: metric('bare'), best: metric('best') },
    preds,
    msPerImage: Math.round((Date.now() - t0) / Math.max(n, 1)),
    backend,
  };
}
