// Usage: tsx scripts/eval/eval-js.ts [--backend node|web] [--set data/realset3] [--limit N] [--out out/js_realset3.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ROOT, evaluate, type Backend } from './evaljs';

const { values: a } = parseArgs({
  options: {
    backend: { type: 'string', default: 'node' },
    set: { type: 'string' },
    limit: { type: 'string', default: '0' },
    out: { type: 'string' },
  },
});
const backend = a.backend === 'web' ? 'web' : ('node' satisfies Backend);
const res = await evaluate({
  backend,
  ...(a.set === undefined ? {} : { set: resolve(a.set) }),
  limit: Number(a.limit),
});
const out = a.out ?? join(ROOT, 'out', `js_${backend}_realset3.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(res));
console.log(JSON.stringify({ backend: res.backend, msPerImage: res.msPerImage, ...res.metrics }));
