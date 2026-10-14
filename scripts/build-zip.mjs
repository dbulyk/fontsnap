// Package extension/ into dist/fontsnap-extension-<version>.zip (Chrome Web Store upload).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const { version } = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json')));
if (!fs.existsSync(path.join(ext, 'ort', 'ort-wasm-simd-threaded.wasm'))) throw new Error('extension/ort missing: run `npm run fetch-ort`');
const model = fs.readFileSync(path.join(ext, 'model', 'model_fp16.onnx'));
if (model.subarray(0, 40).toString().includes('git-lfs')) throw new Error('model is an LFS pointer: run `git lfs pull`');
const files = {};
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name !== 'README.md') files[path.relative(ext, p).split(path.sep).join('/')] = fs.readFileSync(p);
  }
})(ext);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `fontsnap-extension-${version}.zip`);
fs.writeFileSync(out, zipSync(files, { level: 6 }));
console.log(`${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${Object.keys(files).length} files)`);
