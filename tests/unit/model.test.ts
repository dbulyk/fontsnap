import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VENDOR_FILES } from '../../scripts/lib/vendor';
import {
  META_PATH,
  MODEL_PATH,
  RUNTIME_DIR,
  configureRuntime,
  loadModel,
  metaUrl,
  modelUrl,
  runtimeUrl,
} from '../../src/result/model';
import { at } from '../../src/shared/core/at';
import type { Img } from '../../src/shared/core/image';
import type { Meta } from '../../src/shared/core/ranker';
import { createChromeStub } from './helpers/chrome-stub';

const ortMock = vi.hoisted(() => {
  const emptyEnv = (): Record<string, unknown> => ({});
  const run = vi.fn();
  const create = vi.fn();
  class Tensor {
    constructor(
      public type: string,
      public data: Float32Array,
      public dims: number[],
    ) {}
  }
  return {
    env: { wasm: emptyEnv() },
    InferenceSession: { create },
    Tensor,
    run,
  };
});
vi.mock('onnxruntime-web/wasm', () => ortMock);

const META: Meta = {
  fams: ['inter', 'roboto'],
  display: ['Inter', 'Roboto'],
  inGF: [true, true],
  category: ['Sans Serif', 'Sans Serif'],
  rank: [1, 2],
  classFam: [0, 1],
  merge: {},
  keepNoto: [],
};
const white = (w: number, h: number): Img => ({
  w,
  h,
  c: 1,
  data: new Uint8Array(w * h).fill(255),
});

beforeEach(() => {
  createChromeStub().install();
  ortMock.env.wasm = {};
  ortMock.InferenceSession.create.mockReset().mockResolvedValue({ run: ortMock.run });
  ortMock.run.mockReset().mockResolvedValue({ logits: { data: Float32Array.from([0, 0]) } });
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ json: () => Promise.resolve(META) })),
  );
  vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
  vi.stubGlobal('crossOriginIsolated', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadModel', () => {
  it('points onnxruntime at the bundled runtime and uses up to 4 threads when cross-origin isolated', async () => {
    await loadModel();
    expect(ortMock.env.wasm['wasmPaths']).toBe('chrome-extension://test-extension-id/ort/');
    expect(ortMock.env.wasm['numThreads']).toBe(4);
  });

  it.each([
    [true, 2, 2],
    [true, 16, 4],
    [true, 0, 1],
    [false, 16, 1],
  ])('isolated=%s with %s cores → %s thread(s)', async (isolated, cores, threads) => {
    vi.stubGlobal('crossOriginIsolated', isolated);
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    await loadModel();
    expect(ortMock.env.wasm['numThreads']).toBe(threads);
  });

  it('reads the family table and creates the session from the packaged files', async () => {
    await loadModel();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      'chrome-extension://test-extension-id/model/meta.json',
    );
    expect(ortMock.InferenceSession.create).toHaveBeenCalledExactlyOnceWith(
      'chrome-extension://test-extension-id/model/model_fp16.onnx',
      { executionProviders: ['wasm'], graphOptimizationLevel: 'all' },
    );
  });

  it('ranks with the family table it loaded', async () => {
    const model = await loadModel();
    const top = model.ranker.rank([[0.1, 0.9]], { alpha: 0, merge: false, k: 2 });
    expect(top.map((o) => o.name)).toEqual(['Roboto', 'Inter']);
  });

  it('turns an image into class probabilities with one 320x320 float32 NCHW tensor', async () => {
    ortMock.run.mockResolvedValue({ logits: { data: Float32Array.from([0, Math.log(3)]) } });
    const model = await loadModel();
    const probs = await model.probs(white(40, 20));
    const feeds = at(
      ortMock.run.mock.calls as [{ input: InstanceType<typeof ortMock.Tensor> }][],
      0,
    )[0];
    expect(feeds.input.type).toBe('float32');
    expect(feeds.input.dims).toEqual([1, 3, 320, 320]);
    expect(feeds.input.data).toHaveLength(3 * 320 * 320);
    expect(at(probs, 0)).toBeCloseTo(0.25, 6);
    expect(at(probs, 1)).toBeCloseTo(0.75, 6);
  });

  it('fails when the family table cannot be read or the model cannot be created', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('no meta'))),
    );
    await expect(loadModel()).rejects.toThrow('no meta');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ json: () => Promise.resolve(META) })),
    );
    ortMock.InferenceSession.create.mockRejectedValue(new Error('bad model'));
    await expect(loadModel()).rejects.toThrow('bad model');
  });
});

// src/result/model.ts is the only file that may import or configure onnxruntime-web (eslint.config.js refuses the
// names env/wasmPaths/wasmBinary and the import everywhere else). What it does to the runtime is pinned here, because
// env.wasm.wasmPaths (another URL, another .wasm) and env.wasm.wasmBinary (other bytes) would run WebAssembly past
// the pinned files of scripts/lib/vendor.ts with every build check green.
describe('the runtime is configured to load only the packaged, pinned files', () => {
  it('sets wasmPaths to the one string chrome.runtime.getURL("ort/"), never an object or another URL', async () => {
    await loadModel();
    const { wasmPaths } = ortMock.env.wasm;
    expect(typeof wasmPaths).toBe('string');
    expect(wasmPaths).toBe('chrome-extension://test-extension-id/ort/');
    expect(wasmPaths).toBe(chrome.runtime.getURL('ort/'));
  });

  it('does not set wasmBinary, or anything but wasmPaths and numThreads', async () => {
    await loadModel();
    expect(ortMock.env.wasm['wasmBinary']).toBeUndefined();
    expect(Object.keys(ortMock.env.wasm).sort()).toEqual(['numThreads', 'wasmPaths']);
  });

  it('configureRuntime() alone does exactly that, on any environment', () => {
    const env = { wasm: {} };
    configureRuntime(env);
    expect(Object.keys(env.wasm).sort()).toEqual(['numThreads', 'wasmPaths']);
    expect(Object.keys(env)).toEqual(['wasm']);
  });

  it('loads the model and the family table from exactly their packaged URLs', async () => {
    await loadModel();
    expect(modelUrl()).toBe('chrome-extension://test-extension-id/model/model_fp16.onnx');
    expect(metaUrl()).toBe('chrome-extension://test-extension-id/model/meta.json');
    expect(runtimeUrl()).toBe('chrome-extension://test-extension-id/ort/');
    expect(ortMock.InferenceSession.create.mock.calls[0]?.[0]).toBe(modelUrl());
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(metaUrl());
  });

  it('points at paths that are in the pinned list of vendor files', () => {
    expect(RUNTIME_DIR).toBe('ort/');
    expect(VENDOR_FILES.has(MODEL_PATH)).toBe(true);
    expect(VENDOR_FILES.has(META_PATH)).toBe(true);
    // the runtime directory holds exactly the three runtime files of the list
    const inRuntime = [...VENDOR_FILES.keys()].filter((path) => path.startsWith(RUNTIME_DIR));
    expect(inRuntime.sort()).toEqual([
      'ort/ort-wasm-simd-threaded.mjs',
      'ort/ort-wasm-simd-threaded.wasm',
      'ort/ort.wasm.min.mjs',
    ]);
  });

  describe('the source of src/result/model.ts', () => {
    const text = readFileSync('src/result/model.ts', 'utf8');
    const source = ts.createSourceFile('model.ts', text, ts.ScriptTarget.Latest, true);

    /** Property-access chains rooted at `ort`, outermost only, as written: ort.env.wasm.numThreads. */
    function ortChains(): string[] {
      const chains: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          let root: ts.Expression = node;
          while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
            root = root.expression;
          }
          if (ts.isIdentifier(root) && root.text === 'ort') {
            chains.push(node.getText(source));
            return;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return chains;
    }

    it('uses the runtime in exactly three ways: its environment (handed to configureRuntime), InferenceSession.create, Tensor', () => {
      expect(ortChains().sort()).toEqual(['ort.InferenceSession.create', 'ort.Tensor', 'ort.env']);
      expect(text.match(/\bort\.env\b/g)).toHaveLength(1);
      expect(text).toContain('configureRuntime(ort.env);');
    });

    it('assigns to the environment in exactly two places: wasmPaths and numThreads', () => {
      const assigned: string[] = [];
      const visit = (node: ts.Node): void => {
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          /\benv\b/.test(node.left.getText(source))
        ) {
          assigned.push(node.left.getText(source));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(assigned.sort()).toEqual(['env.wasm.numThreads', 'env.wasm.wasmPaths']);
    });

    it('has no way around that: no wasmBinary, no object for wasmPaths, no Object.assign/Reflect/defineProperty, no other import', () => {
      expect(text).not.toMatch(
        /wasmBinary|Object\.(assign|defineProperty|defineProperties)|Reflect\.|\bWebAssembly\b/,
      );
      expect(text).not.toMatch(/\bimport\s*\(|(^|[^-\w])eval\s*\(|\bnew Function\b/);
      const imports = source.statements
        .filter(ts.isImportDeclaration)
        .map((statement) => statement.moduleSpecifier.getText(source));
      expect(imports[0]).toBe("'onnxruntime-web/wasm'");
      expect(imports.slice(1).every((specifier) => specifier.startsWith("'../shared/core/"))).toBe(
        true,
      );
      expect(text.match(/wasmPaths/g)).toHaveLength(2); // the type of the parameter and the one assignment
    });

    it('takes every URL from runtimeUrl(), modelUrl() and metaUrl(), which are built from chrome.runtime.getURL', () => {
      const urls = [...text.matchAll(/chrome\.runtime\.getURL\(([^)]*)\)/g)].map(
        (match) => match[1],
      );
      expect(urls.sort()).toEqual(['META_PATH', 'MODEL_PATH', 'RUNTIME_DIR']);
      expect(text).not.toMatch(/https?:|\/\/cdn|'\/\/'/);
    });
  });
});
