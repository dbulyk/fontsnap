import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE exceptions to the template's "no WebAssembly, no binary files" rule, and the only ones: five files that
 * FontSnap needs to run its model on the user's device. Everything here is declared once; the build copies the
 * files into dist/ (vendorPlugin in vite.shared.ts), `verify-dist` accepts them there and nowhere else, and
 * tests/unit/vendor.test.ts pins this table a second time.
 *
 * - ort/*      the onnxruntime-web 1.30.0 runtime, byte for byte as published on npm (not rebuilt, not minified by us):
 *              the page imports `ort.wasm.min.mjs`, which loads the other two from the same directory. The `.wasm`
 *              is why the extension CSP carries 'wasm-unsafe-eval' (src/manifest.ts).
 * - model/*    the EfficientNet-B3 fp16 ONNX classifier (Git LFS) and its family table.
 *
 * Any other `.wasm` / `.onnx` file, any other file under ort/ or model/, any other bytes under these names, is a
 * build error. To change the runtime or the model: edit this table (new sha256 and size) and the table in the test,
 * in the same commit, with a reason.
 */
export interface VendorFile {
  /** Where the bytes come from, relative to the repository root. */
  source: string;
  sha256: string;
  size: number;
}

export const ORT_VERSION = '1.30.0';
/** The only module specifier the build leaves external: it resolves to ORT_EXTERNAL next to the page chunks. */
export const ORT_SPECIFIER = 'onnxruntime-web/wasm';
/** How a chunk in dist/assets/ reaches the vendored runtime. */
export const ORT_EXTERNAL = '../ort/ort.wasm.min.mjs';

/**
 * The only source file that may import or configure onnxruntime-web (eslint.config.js lists it too; the guard context
 * test fails if the two disagree). A unit test pins what it assigns to `ort.env.wasm`.
 */
export const ORT_CONFIG_FILE = 'src/result/model.ts';

const ORT_DIST = 'node_modules/onnxruntime-web/dist';

// A Map: a path such as `constructor` is not a vendor file because every object has one.
export const VENDOR_FILES: ReadonlyMap<string, VendorFile> = new Map([
  [
    'ort/ort.wasm.min.mjs',
    {
      source: `${ORT_DIST}/ort.wasm.min.mjs`,
      sha256: '219e6a1fc8a9938268d18efca3c91d310bd2f4a59bbd13744df5b2b7fc6cee3b',
      size: 50126,
    },
  ],
  [
    'ort/ort-wasm-simd-threaded.mjs',
    {
      source: `${ORT_DIST}/ort-wasm-simd-threaded.mjs`,
      sha256: 'e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b',
      size: 24381,
    },
  ],
  [
    'ort/ort-wasm-simd-threaded.wasm',
    {
      source: `${ORT_DIST}/ort-wasm-simd-threaded.wasm`,
      sha256: '3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2',
      size: 14239897,
    },
  ],
  [
    'model/model_fp16.onnx',
    {
      source: 'model/model_fp16.onnx',
      sha256: 'f880c3cfa0fe66269c9825a1d2a94ce01b76790290b0eabc5a518dc02fcffbd1',
      size: 32697050,
    },
  ],
  [
    'model/meta.json',
    {
      source: 'model/meta.json',
      sha256: '6eba0b40c03d462fa023917df19289f00670fb9a96cdec136d89cf18922fa93c',
      size: 106519,
    },
  ],
]);

export function isVendorPath(
  file: string,
  vendor: ReadonlyMap<string, VendorFile> = VENDOR_FILES,
): boolean {
  return vendor.has(file);
}

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

/** Why `bytes` are not the pinned file `path`, or undefined if they are. */
export function vendorFileProblem(
  path: string,
  bytes: Buffer,
  entry: VendorFile,
): string | undefined {
  if (bytes.subarray(0, LFS_POINTER.length).toString('latin1') === LFS_POINTER) {
    return `${path} is a Git LFS pointer, not the file: run \`git lfs pull\``;
  }
  if (bytes.length !== entry.size) {
    return `${path} has size ${String(bytes.length)}, expected ${String(entry.size)} (see scripts/lib/vendor.ts)`;
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  return digest === entry.sha256
    ? undefined
    : `${path} has sha256 ${digest}, expected ${entry.sha256} (see scripts/lib/vendor.ts)`;
}

/** The bytes of a vendor file from its source, or an error saying what is wrong with them. */
export function readVendorFile(root: string, path: string, entry: VendorFile): Buffer {
  const file = join(root, entry.source);
  if (!existsSync(file))
    throw new Error(`${path}: source ${entry.source} not found (run npm ci / git lfs pull)`);
  const bytes = readFileSync(file);
  const problem = vendorFileProblem(path, bytes, entry);
  if (problem !== undefined) throw new Error(problem);
  return bytes;
}

const GUARDED_FILE = /\.(?:wasm|onnx)$/i;
const GUARDED_DIR = /^(?:ort|model)(?:\/|$)/i;

/**
 * Problems with the vendored files of a built directory. `files` are all files of the build (relative paths).
 * Every listed file must be there with the pinned bytes; no other `.wasm` / `.onnx` file and nothing else below
 * ort/ or model/ may exist.
 */
export function vendorDistProblems(
  dir: string,
  files: readonly string[],
  vendor: ReadonlyMap<string, VendorFile> = VENDOR_FILES,
): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if ((GUARDED_FILE.test(file) || GUARDED_DIR.test(file)) && !vendor.has(file)) {
      problems.push(
        `${file}: not a pinned vendor file (scripts/lib/vendor.ts lists the only WebAssembly, runtime and model files allowed)`,
      );
    }
  }
  for (const [path, entry] of vendor) {
    const file = join(dir, path);
    if (!files.includes(path) || !existsSync(file)) {
      problems.push(`${path}: missing from the build (a pinned vendor file)`);
      continue;
    }
    const problem = vendorFileProblem(path, readFileSync(file), entry);
    if (problem !== undefined) problems.push(problem);
  }
  return problems;
}
