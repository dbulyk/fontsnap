import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ORT_SPECIFIER,
  ORT_VERSION,
  VENDOR_FILES,
  isVendorPath,
  readVendorFile,
  vendorFileProblem,
  vendorDistProblems,
  type VendorFile,
} from '../../scripts/lib/vendor';
import { PROTOTYPE_NAMES } from './helpers/media';

// Written out here a second time, from the files FontSnap 0.1.0 shipped: the list in scripts/lib/vendor.ts cannot
// be changed without changing this table, which makes any change a visible, deliberate edit of two files.
const PINNED = new Map([
  ['model/meta.json', ['973633542966ea9a4b8c649fc70ae62f64acf9ba63b887995422177dc6f3ea34', 119525]],
  [
    'model/model_fp16.onnx',
    ['f880c3cfa0fe66269c9825a1d2a94ce01b76790290b0eabc5a518dc02fcffbd1', 32697050],
  ],
  [
    'ort/ort-wasm-simd-threaded.mjs',
    ['e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b', 24381],
  ],
  [
    'ort/ort-wasm-simd-threaded.wasm',
    ['3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2', 14239897],
  ],
  [
    'ort/ort.wasm.min.mjs',
    ['219e6a1fc8a9938268d18efca3c91d310bd2f4a59bbd13744df5b2b7fc6cee3b', 50126],
  ],
]);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-'));
  dirs.push(dir);
  return dir;
};
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const entryFor = (bytes: Buffer): VendorFile => ({
  source: 'unused',
  sha256: sha(bytes),
  size: bytes.length,
});

describe('VENDOR_FILES: the only WebAssembly, runtime scripts and model FontSnap ships', () => {
  it('lists exactly five files, each pinned by sha256 and size', () => {
    expect([...VENDOR_FILES.keys()].sort()).toEqual([...PINNED.keys()].sort());
    for (const [path, [digest, size]] of PINNED) {
      expect(VENDOR_FILES.get(path)?.sha256, path).toBe(digest);
      expect(VENDOR_FILES.get(path)?.size, path).toBe(size);
    }
  });

  it('allows one .wasm file and one .onnx file, nothing else of either kind', () => {
    const paths = [...VENDOR_FILES.keys()];
    expect(paths.filter((p) => p.endsWith('.wasm'))).toEqual(['ort/ort-wasm-simd-threaded.wasm']);
    expect(paths.filter((p) => p.endsWith('.onnx'))).toEqual(['model/model_fp16.onnx']);
  });

  it('takes the runtime from onnxruntime-web 1.30.0, exactly', () => {
    expect(ORT_VERSION).toBe('1.30.0');
    expect(ORT_SPECIFIER).toBe('onnxruntime-web/wasm');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['onnxruntime-web']).toBe('1.30.0');
    for (const path of [...PINNED.keys()].filter((p) => p.startsWith('ort/'))) {
      expect(VENDOR_FILES.get(path)?.source).toBe(
        `node_modules/onnxruntime-web/dist/${path.slice(4)}`,
      );
    }
  });

  it('is an allowlist: inherited object names are not vendor files', () => {
    for (const name of PROTOTYPE_NAMES) {
      expect(VENDOR_FILES.has(name), name).toBe(false);
      expect(isVendorPath(name), name).toBe(false);
      expect(isVendorPath(`ort/${name}`), name).toBe(false);
    }
    expect(isVendorPath('ort/ort-wasm-simd-threaded.wasm')).toBe(true);
    expect(isVendorPath('ort/Ort-wasm-simd-threaded.wasm')).toBe(false);
    expect(isVendorPath('assets/ort-wasm-simd-threaded.wasm')).toBe(false);
    expect(isVendorPath('foo.wasm')).toBe(false);
  });
});

describe('the files in the repository are the pinned ones', () => {
  it.each([...PINNED.keys()].filter((p) => p.startsWith('ort/') || p === 'model/meta.json'))(
    '%s',
    (path) => {
      const entry = VENDOR_FILES.get(path);
      if (!entry) throw new Error(`unlisted ${path}`);
      expect(vendorFileProblem(path, readFileSync(entry.source), entry)).toBeUndefined();
    },
  );

  // The model is a Git LFS file: a checkout without LFS holds a pointer whose oid is the sha256 of the real file.
  it('model/model_fp16.onnx is the pinned model (or the Git LFS pointer to it)', () => {
    const entry = VENDOR_FILES.get('model/model_fp16.onnx');
    if (!entry) throw new Error('model unlisted');
    const bytes = readFileSync(entry.source);
    const pointer =
      /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/.exec(
        bytes.toString('latin1').slice(0, 200),
      );
    const problem = pointer
      ? pointer[1] === entry.sha256 && Number(pointer[2]) === entry.size
        ? undefined
        : 'the Git LFS pointer is not the pointer of the pinned model'
      : vendorFileProblem('model/model_fp16.onnx', bytes, entry);
    expect(problem).toBeUndefined();
  });
});

describe('vendorFileProblem', () => {
  const bytes = Buffer.from('some model bytes');
  const entry = entryFor(bytes);

  it('accepts the pinned bytes', () => {
    expect(vendorFileProblem('model/x', bytes, entry)).toBeUndefined();
  });

  it('refuses another size, even with a fitting prefix', () => {
    expect(vendorFileProblem('model/x', Buffer.concat([bytes, Buffer.from('!')]), entry)).toMatch(
      /size/,
    );
  });

  it('refuses a changed byte of the same length', () => {
    const changed = Buffer.from(bytes);
    changed[3] = changed[3] === 0x65 ? 0x66 : 0x65;
    expect(vendorFileProblem('model/x', changed, entry)).toMatch(/sha256/);
  });

  it('tells the user to pull Git LFS when it finds a pointer', () => {
    const pointer = Buffer.from(
      `version https://git-lfs.github.com/spec/v1\noid sha256:${'0'.repeat(64)}\nsize 123\n`,
    );
    expect(vendorFileProblem('model/x', pointer, entry)).toMatch(/git lfs pull/);
  });
});

describe('readVendorFile', () => {
  it('returns the bytes of a pinned source and refuses a modified one', () => {
    const root = temp();
    const bytes = Buffer.from('runtime');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'a.bin'), bytes);
    const entry = { ...entryFor(bytes), source: 'src/a.bin' };
    expect(readVendorFile(root, 'ort/a.bin', entry).equals(bytes)).toBe(true);
    writeFileSync(join(root, 'src', 'a.bin'), 'runtimf');
    expect(() => readVendorFile(root, 'ort/a.bin', entry)).toThrow(/ort\/a\.bin.*sha256/s);
  });

  it('says so when the source is missing', () => {
    expect(() =>
      readVendorFile(temp(), 'ort/a.bin', { source: 'nope', sha256: '0', size: 1 }),
    ).toThrow(/nope/);
  });
});

describe('vendorDistProblems', () => {
  const files = new Map<string, Buffer>([
    ['ort/ort.wasm.min.mjs', Buffer.from('ort-js')],
    ['ort/ort-wasm-simd-threaded.wasm', Buffer.from('ort-wasm')],
    ['model/model_fp16.onnx', Buffer.from('onnx')],
  ]);
  const vendor = new Map([...files].map(([path, bytes]) => [path, entryFor(bytes)]));

  function dist(overrides: Record<string, Buffer | null> = {}): string {
    const root = temp();
    for (const [path, bytes] of [...files, ...Object.entries(overrides)]) {
      const content = overrides[path] === undefined ? bytes : overrides[path];
      if (content === null) continue;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }
  const listOf = (extra: string[] = []) => [...files.keys(), ...extra];

  it('accepts exactly the listed files with the pinned bytes', () => {
    expect(vendorDistProblems(dist(), listOf(), vendor)).toEqual([]);
  });

  it('reports a listed file that is missing', () => {
    const problems = vendorDistProblems(
      dist({ 'model/model_fp16.onnx': null }),
      listOf().slice(0, 2),
      vendor,
    );
    expect(problems.join('\n')).toMatch(/model\/model_fp16\.onnx.*missing/);
  });

  it.each([
    [
      'a changed byte in the WASM runtime',
      { 'ort/ort-wasm-simd-threaded.wasm': Buffer.from('ort-wasn') },
    ],
    ['a changed byte in the model', { 'model/model_fp16.onnx': Buffer.from('onny') }],
    ['a truncated model', { 'model/model_fp16.onnx': Buffer.from('onn') }],
  ])('reports %s', (_what, overrides) => {
    expect(vendorDistProblems(dist(overrides), listOf(), vendor).join('\n')).toMatch(/ort|model/);
  });

  it.each([
    'foo.wasm',
    'ort/foo.wasm',
    'assets/ort-wasm-simd-threaded.wasm',
    'ORT/ort-wasm-simd-threaded.WASM',
    'model/other.onnx',
    'extra.onnx',
    'ort/other.mjs',
    'model/other.json',
  ])('reports an unlisted %s', (extra) => {
    const root = dist({ [extra]: Buffer.from('x') });
    expect(vendorDistProblems(root, listOf([extra]), vendor).join('\n')).toContain(extra);
  });

  it('is not fooled by inherited names', () => {
    for (const name of PROTOTYPE_NAMES) {
      expect(vendorDistProblems(dist(), listOf([`ort/${name}`]), vendor).join(), name).toContain(
        name,
      );
    }
  });
});
