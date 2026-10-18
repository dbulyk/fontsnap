import { vi } from 'vitest';

export interface ImageApiOptions {
  /** Size of every decoded bitmap (the "screenshot"). */
  bitmap?: { width: number; height: number };
  /** Bytes convertToBlob produces for a type (and JPEG quality); default: a few bytes. */
  encode?: (type: string, quality: number | undefined) => number;
  /** Make createImageBitmap reject for a blob of this type. */
  undecodableType?: string;
}

/**
 * Stubs of the browser APIs the service worker uses to crop a screenshot: OffscreenCanvas, createImageBitmap
 * and a fetch that must stay unused. Everything is recorded for assertions.
 */
export function installImageApis(options: ImageApiOptions = {}) {
  const size = options.bitmap ?? { width: 400, height: 300 };
  const draws: number[][] = [];
  const ops: string[] = [];
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
      const ctx = {
        fillStyle: '',
        fillRect: (...args: number[]) => {
          ops.push(`fill ${ctx.fillStyle} ${args.join(',')}`);
        },
        drawImage: (...args: unknown[]) => {
          ops.push('draw');
          draws.push(args.slice(1) as number[]);
        },
      };
      return ctx;
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

  // the service worker makes no request at all (connect-src 'self'): every test asserts that this stub was not called
  const fetchStub = vi.fn<(input: string, init?: RequestInit) => Promise<never>>(() =>
    Promise.reject(new TypeError('Failed to fetch')),
  );

  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  vi.stubGlobal('fetch', fetchStub);

  return { draws, ops, canvases, encodes, bitmaps, createImageBitmap, fetch: fetchStub };
}
