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
 * never an object or another URL) and how many threads it uses. Handing the runtime its own binary is never done.
 * Both would run WASM other than the pinned files, which is why this is the one file allowed to touch the environment
 * (eslint.config.js) and why tests/unit/model.test.ts pins it, source included.
 */
export function configureRuntime(env: {
  wasm: { wasmPaths?: string | object; numThreads?: number };
}): void {
  env.wasm.wasmPaths = runtimeUrl();
  env.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1;
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
  const session = await ort.InferenceSession.create(modelUrl(), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
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
