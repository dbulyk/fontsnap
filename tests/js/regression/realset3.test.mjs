// Model regression on realset3 (JS pipeline) + JS-vs-Python parity.
// Env overrides: FONTSNAP_BACKEND=node|web, FONTSNAP_MIN_BEST_TOP1/TOP5, FONTSNAP_MIN_BARE_TOP1/TOP5,
// FONTSNAP_MIN_PARITY, FONTSNAP_PY_RESULTS (default out/py_realset3.json, produced by `python -m fontsnap_ref.evaluate`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluate, ROOT } from '../../../scripts/lib/evaljs.mjs';

const T = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'thresholds.json')));
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const min = {
  best: { top1: env('FONTSNAP_MIN_BEST_TOP1', T.best.top1), top5: env('FONTSNAP_MIN_BEST_TOP5', T.best.top5) },
  bare: { top1: env('FONTSNAP_MIN_BARE_TOP1', T.bare.top1), top5: env('FONTSNAP_MIN_BARE_TOP5', T.bare.top5) },
};
const minParity = env('FONTSNAP_MIN_PARITY', T.parityTop1Agreement);
const backend = process.env.FONTSNAP_BACKEND || 'node';
const pyFile = process.env.FONTSNAP_PY_RESULTS || path.join(ROOT, 'out', 'py_realset3.json');

const res = await evaluate({ backend });
fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'out', `js_${backend}_realset3.json`), JSON.stringify(res));
console.log(`# JS (${backend}) realset3:`, JSON.stringify(res.metrics), `${res.msPerImage} ms/img`);

for (const c of ['best', 'bare']) {
  test(`realset3 ${c} >= ${min[c].top1}/${min[c].top5}`, () => {
    assert.equal(res.metrics[c].n, 263);
    assert.ok(res.metrics[c].top1 >= min[c].top1, `${c} top1 ${res.metrics[c].top1} < ${min[c].top1}`);
    assert.ok(res.metrics[c].top5 >= min[c].top5, `${c} top5 ${res.metrics[c].top5} < ${min[c].top5}`);
  });
}

test(`JS vs Python parity (top-1 agreement >= ${minParity}% or identical metrics)`, () => {
  assert.ok(fs.existsSync(pyFile), `missing ${pyFile}: run \`cd python && python -m fontsnap_ref.evaluate\` first`);
  const py = JSON.parse(fs.readFileSync(pyFile));
  for (const c of ['best', 'bare']) {
    const ims = Object.keys(res.preds);
    assert.deepEqual(new Set(Object.keys(py.preds)), new Set(ims));
    const agree = ims.filter((im) => py.preds[im][c][0] === res.preds[im][c][0]).length;
    const pct = (100 * agree) / ims.length;
    console.log(
      `# parity ${c}: top-1 agreement ${pct.toFixed(1)}%, py ${JSON.stringify(py.metrics[c])} js ${JSON.stringify(res.metrics[c])}`,
    );
    const same = py.metrics[c].top1 === res.metrics[c].top1 && py.metrics[c].top5 === res.metrics[c].top5;
    assert.ok(pct >= minParity || same, `${c}: agreement ${pct.toFixed(1)}% and metrics differ`);
  }
});
