// Usage: node scripts/eval-js.mjs [--backend node|web] [--set data/realset3] [--limit N] [--out out/js_realset3.json]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { evaluate, ROOT } from './lib/evaljs.mjs';

const { values: a } = parseArgs({
  options: { backend: { type: 'string', default: 'node' }, set: { type: 'string' }, limit: { type: 'string', default: '0' }, out: { type: 'string' } },
});
const res = await evaluate({ backend: a.backend, set: a.set && path.resolve(a.set), limit: +a.limit });
const out = a.out || path.join(ROOT, 'out', `js_${a.backend}_realset3.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(res));
console.log(JSON.stringify({ backend: res.backend, msPerImage: res.msPerImage, ...res.metrics }));
