import { vi } from 'vitest';

interface FetchAnswer {
  ok: boolean;
  blob: () => Promise<Blob>;
}

export interface ImageApiOptions {
  /** Size of every decoded bitmap (the "screenshot"). */
  bitmap?: { width: number; height: number };
  /** Bytes convertToBlob produces for a type (and JPEG quality); default: a few bytes. */
  encode?: (type: string, quality: number | undefined) => number;
  /** Answer for a non-data: URL passed to fetch(); throw to simulate CORS / network failure. */
  remote?: (url: string) => { ok: boolean; blob: Blob } | Promise<{ ok: boolean; blob: Blob }>;
  /** Make createImageBitmap reject for a blob of this type. */
  undecodableType?: string;
}

/**
 * Stubs of the browser APIs the service worker uses to crop a screenshot: OffscreenCanvas, createImageBitmap
 * and fetch (for data: URLs and the image URL of the context menu). Everything is recorded for assertions.
 */
export function installImageApis(options: ImageApiOptions = {}) {
  const size = options.bitmap ?? { width: 400, height: 300 };
  const draws: number[][] = [];
  const canvases: { width: number; height: number }[] = [];
  const encodes: { type: string; quality: number | undefined }[] = [];
  const bitmaps: { close: ReturnType<typeof vi.fn> }[] = [];

  class FakeOffscreenCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {
      canvases.push(this);
    }
    getContext() {
      return {
        drawImage: (...args: unknown[]) => {
          draws.push(args.slice(1) as number[]);
        },
      };
    }
    convertToBlob(opts: { type: string; quality?: number }) {
      encodes.push({ type: opts.type, quality: opts.quality });
      const length = options.encode?.(opts.type, opts.quality) ?? 4;
      return Promise.resolve(new Blob([new Uint8Array(length).fill(65)], { type: opts.type }));
    }
  }

  const createImageBitmap = vi.fn((blob: Blob) => {
    if (options.undecodableType !== undefined && blob.type === options.undecodableType) {
      return Promise.reject(new Error('The source image could not be decoded.'));
    }
    const bitmap = { ...size, close: vi.fn() };
    bitmaps.push(bitmap);
    return Promise.resolve(bitmap);
  });

  const fetchStub = vi.fn<(input: string, init?: RequestInit) => Promise<FetchAnswer>>(
    async (input) => {
      if (input.startsWith('data:')) {
        const comma = input.indexOf(',');
        const type = input.slice(5, input.indexOf(';'));
        const bytes = Uint8Array.from(atob(input.slice(comma + 1)), (c) => c.charCodeAt(0));
        return { ok: true, blob: () => Promise.resolve(new Blob([bytes], { type })) };
      }
      if (!options.remote) throw new TypeError('Failed to fetch');
      const answer = await options.remote(input);
      return { ok: answer.ok, blob: () => Promise.resolve(answer.blob) };
    },
  );

  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  vi.stubGlobal('fetch', fetchStub);

  return { draws, canvases, encodes, bitmaps, createImageBitmap, fetch: fetchStub };
}
