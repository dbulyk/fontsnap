// Model regression on realset3 (JS pipeline) + JS-vs-Python parity. Run by `npm run test:regression` (tsx --test).
// Env overrides: FONTSNAP_BACKEND=node|web, FONTSNAP_MIN_BEST_TOP1/TOP5, FONTSNAP_MIN_BARE_TOP1/TOP5,
// FONTSNAP_MIN_PARITY, FONTSNAP_PY_RESULTS (default out/py_realset3.json, produced by `python -m fontsnap_ref.evaluate`).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT, evaluate, type Backend } from '../../scripts/eval/evaljs';
import { loadThresholds, parityAgreement, type Predictions } from '../../scripts/lib/regression';

const min = loadThresholds(process.env, join(ROOT, 'tests', 'thresholds.json'));
const backend: Backend = process.env['FONTSNAP_BACKEND'] === 'web' ? 'web' : 'node';
const pyFile = process.env['FONTSNAP_PY_RESULTS'] ?? join(ROOT, 'out', 'py_realset3.json');

const res = await evaluate({ backend });
mkdirSync(join(ROOT, 'out'), { recursive: true });
writeFileSync(join(ROOT, 'out', `js_${backend}_realset3.json`), JSON.stringify(res));
console.log(
  `# JS (${backend}) realset3:`,
  JSON.stringify(res.metrics),
  `${String(res.msPerImage)} ms/img`,
);

for (const c of ['best', 'bare'] as const) {
  void test(`realset3 ${c} >= ${String(min[c].top1)}/${String(min[c].top5)}`, () => {
    assert.equal(res.metrics[c].n, 263);
    assert.ok(
      res.metrics[c].top1 >= min[c].top1,
      `${c} top1 ${String(res.metrics[c].top1)} < ${String(min[c].top1)}`,
    );
    assert.ok(
      res.metrics[c].top5 >= min[c].top5,
      `${c} top5 ${String(res.metrics[c].top5)} < ${String(min[c].top5)}`,
    );
  });
}

void test(`JS vs Python parity (top-1 agreement >= ${String(min.parity)}% or identical metrics)`, () => {
  assert.ok(
    existsSync(pyFile),
    `missing ${pyFile}: run \`cd python && python -m fontsnap_ref.evaluate\` first`,
  );
  const py = JSON.parse(readFileSync(pyFile, 'utf8')) as {
    preds: Predictions;
    metrics: Record<'best' | 'bare', { top1: number; top5: number }>;
  };
  for (const c of ['best', 'bare'] as const) {
    const pct = parityAgreement(py.preds, res.preds, c);
    console.log(
      `# parity ${c}: top-1 agreement ${pct.toFixed(1)}%, py ${JSON.stringify(py.metrics[c])} js ${JSON.stringify(res.metrics[c])}`,
    );
    const same =
      py.metrics[c].top1 === res.metrics[c].top1 && py.metrics[c].top5 === res.metrics[c].top5;
    assert.ok(pct >= min.parity || same, `${c}: agreement ${pct.toFixed(1)}% and metrics differ`);
  }
});
