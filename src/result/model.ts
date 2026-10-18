import * as ort from 'onnxruntime-web/wasm';
import { prep, softmax } from '../shared/core/pipeline';
import { makeRanker, type Meta } from '../shared/core/ranker';
import type { Img } from '../shared/core/image';

export interface Model {
  ranker: ReturnType<typeof makeRanker>;
  /** Class probabilities for one normalized crop (320x320 NCHW float32 → logits → softmax). */
  probs: (crop: Img) => Promise<Float64Array>;
}

/** Where the packaged files are, relative to the extension root; all of them are in VENDOR_FILES (scripts/lib/vendor.ts). */
export const RUNTIME_DIR = 'ort/';
export const MODEL_PATH = 'model/model_fp16.onnx';
export const META_PATH = 'model/meta.json';

export const runtimeUrl = (): string => chrome.runtime.getURL(RUNTIME_DIR);
export const modelUrl = (): string => chrome.runtime.getURL(MODEL_PATH);
export const metaUrl = (): string => chrome.runtime.getURL(META_PATH);

/**
 * The ONLY settings FontSnap makes on the runtime: where it finds its own files (one string, the packaged directory;
 * never an object or another URL), that it runs in its own worker (`proxy`: the runtime then fetches and compiles its
 * .wasm inside a Worker, in a global scope this page cannot reach - replacing `fetch`, a prototype or a method here
 * changes nothing there, which is the point: a page-level check for a replaced `fetch` can always be answered by
 * the code that replaced it, a separate realm cannot) and how many threads it uses. Handing the runtime its own binary is never done.
 * Both would run WASM other than the pinned files, which is why this is the one file allowed to touch the environment
 * (eslint.config.js) and why tests/unit/model.test.ts pins it, source included.
 */
export function configureRuntime(env: {
  wasm: { wasmPaths?: string | object; numThreads?: number; proxy?: boolean };
}): void {
  env.wasm.wasmPaths = runtimeUrl();
  env.wasm.proxy = true;
  env.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1;
}

/**
 * The runtime must start with the values this file set and nothing else, whatever the source lines that set them look
 * like (review of PR #6: a setting computed from the environment, an object wrapped in a call, an inherited or
 * getter-backed override all passed every check of the form):
 * - `wasmPaths` is an OWN DATA property holding exactly the string `expected` (the packaged directory) - not an
 *   object, not a getter that may answer differently later, not another string however it prints;
 * - `proxy` is the boolean `true`, own data property: the runtime then lives in a Worker of its own and fetches its
 *   .wasm THERE, with that worker's `fetch`, which nothing in this page can replace (see configureRuntime);
 * - there is no `wasmBinary`: not own, not inherited (prototype pollution), not a getter, not even `undefined` set on purpose.
 */
export function assertPinnedRuntime(env: { wasm: object }, expected: string): void {
  const { wasm } = env;
  const proxy = Object.getOwnPropertyDescriptor(wasm, 'proxy');
  if (proxy?.value !== true) {
    throw new Error(
      'Refusing to start: proxy must be true (the runtime must load its files in its own worker).',
    );
  }
  const paths = Object.getOwnPropertyDescriptor(wasm, 'wasmPaths');
  if (paths === undefined || typeof paths.value !== 'string' || paths.value !== expected) {
    throw new Error(
      `Refusing to start: wasmPaths must be exactly ${expected} (the packaged runtime).`,
    );
  }
  const { wasmBinary } = wasm as { wasmBinary?: unknown };
  if (
    Object.getOwnPropertyDescriptor(wasm, 'wasmBinary') !== undefined ||
    wasmBinary !== undefined
  ) {
    throw new Error(
      'Refusing to start: wasmBinary must not be set (the runtime would run other bytes).',
    );
  }
}

/**
 * Additional detective check, NOT a protection: after the runtime started, nothing the PAGE loaded came from outside
 * the extension (the family table and the model go through this page's `fetch`; the .wasm does not, see configureRuntime).
 * Resource timing is the page's own to reduce (a zero-size buffer empties it), so lint refuses the APIs that do that
 * and an empty list proves nothing. Loads of the extension's own files (chrome-extension://<id>/...) do not appear at all.
 */
export function assertNoOutsideLoads(entries: readonly PerformanceEntry[], base: string): void {
  const outside = entries.find((entry) => !entry.name.startsWith(base));
  if (outside !== undefined) {
    throw new Error(
      `Refusing to continue: ${outside.name} was loaded from outside the extension while the runtime started.`,
    );
  }
}

/**
 * Loads the family table and the EfficientNet-B3 ONNX model (fp16) that ship inside the extension and
 * runs them with onnxruntime-web (WASM, 'wasm-unsafe-eval' in the CSP). The runtime files come from `ort/`
 * (see scripts/lib/vendor.ts for the pinned list).
 */
export async function loadModel(): Promise<Model> {
  configureRuntime(ort.env);
  const meta = (await (await fetch(metaUrl())).json()) as Meta;
  const ranker = makeRanker(meta);
  assertPinnedRuntime(ort.env, runtimeUrl());
  const session = await ort.InferenceSession.create(modelUrl(), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  // resource timing entries are queued after the load ends: let them arrive
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assertNoOutsideLoads(performance.getEntriesByType('resource'), chrome.runtime.getURL(''));
  return {
    ranker,
    probs: async (crop) => {
      const out = await session.run({
        input: new ort.Tensor('float32', prep(crop), [1, 3, 320, 320]),
      });
      return softmax(out['logits']?.data as Float32Array);
    },
  };
}
