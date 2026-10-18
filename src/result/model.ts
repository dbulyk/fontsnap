import * as ort from 'onnxruntime-web/wasm';
import { prep, softmax } from '../shared/core/pipeline';
import { makeRanker, type Meta } from '../shared/core/ranker';
import type { Img } from '../shared/core/image';

export interface Model {
  ranker: ReturnType<typeof makeRanker>;
  /** Class probabilities for one normalized crop (320x320 NCHW float32 → logits → softmax). */
  probs: (crop: Img) => Promise<Float64Array>;
}

/**
 * Loads the family table and the EfficientNet-B3 ONNX model (fp16) that ship inside the extension and
 * runs them with onnxruntime-web (WASM, 'wasm-unsafe-eval' in the CSP). The runtime files come from `ort/`
 * (see scripts/lib/vendor.ts for the pinned list).
 */
export async function loadModel(): Promise<Model> {
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 1)
    : 1;
  const meta = (await (await fetch(chrome.runtime.getURL('model/meta.json'))).json()) as Meta;
  const ranker = makeRanker(meta);
  const session = await ort.InferenceSession.create(
    chrome.runtime.getURL('model/model_fp16.onnx'),
    {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    },
  );
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
