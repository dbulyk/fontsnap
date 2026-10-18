import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadModel } from '../../src/result/model';
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
