import fs from 'fs'; import { PNG } from 'pngjs'; import * as ort from 'onnxruntime-node';
import { fromRGBA, textLines, cropNormalize, prep, softmax, makeRanker, nz } from '/workspace/fontsnap-extension/lib/fontsnap-core.js';
const E = '/workspace/fontsnap-eval/realset3', meta = JSON.parse(fs.readFileSync('/workspace/fontsnap-ext-work/meta.json'));
const R = makeRanker(meta), s = await ort.InferenceSession.create(process.argv[2] || '/workspace/fontsnap-train/runs/round2/model_fp16.onnx', { intraOpNumThreads: 8 });
const rows = JSON.parse(fs.readFileSync('/workspace/fontsnap-ext-work/labels.json'));
let n = 0, b1 = 0, b5 = 0, r1 = 0, r5 = 0; const dump = {}; const t0 = Date.now();
for (const [image, label] of rows) {
  const png = PNG.sync.read(fs.readFileSync(`${E}/images/${image}`)), img = fromRGBA(png.data, png.width, png.height), pre = textLines(img), P = {};
  for (const v of ['pack', 'crop']) { const x = prep(cropNormalize(img, v, 96, 6, pre)); const o = await s.run({ input: new ort.Tensor('float32', x, [1, 3, 320, 320]) }); P[v] = softmax(o.logits.data); }
  const lb = nz(label), bare = R.rank([P.pack], { alpha: 0, merge: false, k: 5 }).map(o => o.key), best = R.rank([P.pack, P.crop], { k: 5 }).map(o => o.key), lm = R.mg(lb);
  n++; b1 += bare[0] === lb; b5 += bare.includes(lb); r1 += best[0] === lm; r5 += best.includes(lm);
  dump[image] = { pack: Array.from(P.pack), crop: Array.from(P.crop) }; }
const pc = v => (100 * v / n).toFixed(1);
console.log(`n=${n} bare ${pc(b1)}/${pc(b5)} best ${pc(r1)}/${pc(r5)} ${(Date.now() - t0) / n | 0} ms/img`);
fs.writeFileSync('/workspace/fontsnap-ext-work/js_probs.json', JSON.stringify(dump));
