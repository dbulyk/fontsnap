// Copy the pinned onnxruntime-web WASM runtime from node_modules into extension/ort (not committed; see README).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const dst = path.join(root, 'extension', 'ort');
const FILES = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'];

if (!fs.existsSync(dist)) {
  console.error('onnxruntime-web is not installed; run `npm ci` first');
  process.exit(1);
}
const pinned = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).devDependencies['onnxruntime-web'];
const got = JSON.parse(fs.readFileSync(path.join(dist, '..', 'package.json'))).version;
if (pinned !== got) {
  console.error(`onnxruntime-web version mismatch: package.json pins ${pinned}, installed ${got}`);
  process.exit(1);
}
fs.mkdirSync(dst, { recursive: true });
for (const f of FILES) fs.copyFileSync(path.join(dist, f), path.join(dst, f));
console.log(`onnxruntime-web ${got} copied to extension/ort/`);
