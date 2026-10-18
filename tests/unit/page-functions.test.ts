import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadImagePixels } from '../../src/background/load-image';
import { measureImage } from '../../src/background/measure';

// The two functions that chrome.scripting serializes into a web page, run here against stand-ins for the document they see.
afterEach(() => {
  vi.unstubAllGlobals();
});

interface Scroller {
  scrollLeft: number;
  scrollTop: number;
  parentElement: Scroller | null;
}

const scroller = (left: number, top: number, parent: Scroller | null = null): Scroller => ({
  scrollLeft: left,
  scrollTop: top,
  parentElement: parent,
});

function page(options: {
  images?: unknown[];
  frames?: unknown[];
  dpr?: number;
  size?: [number, number];
}) {
  const frames: (() => void)[] = [];
  vi.stubGlobal('document', {
    images: options.images ?? [],
    getElementsByTagName: (name: string) => (name === 'iframe' ? (options.frames ?? []) : []),
  });
  vi.stubGlobal('window', {
    devicePixelRatio: options.dpr,
    innerWidth: options.size?.[0] ?? 800,
    innerHeight: options.size?.[1] ?? 600,
  });
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
    frames.push(cb);
    cb();
  });
  return frames;
}

const SRC = 'https://x/y.png';
const element = (extra: Record<string, unknown> = {}) => ({
  currentSrc: SRC,
  src: '',
  scrollIntoView: vi.fn(),
  getBoundingClientRect: () => ({ left: 3, top: 4, width: 50, height: 60 }),
  parentElement: null,
  ...extra,
});

describe('measureImage', () => {
  it('finds the image by currentSrc (a <picture> or srcset), scrolls it into view and measures it after two frames', async () => {
    const img = element();
    const frames = page({ images: [{ currentSrc: 'other', src: 'other' }, img], dpr: 2 });
    await expect(measureImage(SRC, 'image', null)).resolves.toEqual({
      rect: { x: 3, y: 4, w: 50, h: 60 },
      dpr: 2,
      saved: [],
      box: { x: 0, y: 0, w: 800, h: 600 },
    });
    expect(img.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(frames).toHaveLength(2);
  });

  it('also finds an image by its src, and falls back to a pixel ratio of 1', async () => {
    page({ images: [element({ currentSrc: '', src: SRC })] });
    await expect(measureImage(SRC, 'image', null)).resolves.toMatchObject({ dpr: 1 });
  });

  it('answers null for an image that is not in the document', async () => {
    page({ images: [] });
    await expect(measureImage(SRC, 'image', null)).resolves.toBeNull();
  });

  it('takes the one that is on screen when several images have the same URL', async () => {
    const hidden = element({
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    });
    const below = element({
      getBoundingClientRect: () => ({ left: 0, top: 5000, width: 10, height: 10 }),
    });
    const shown = element({
      getBoundingClientRect: () => ({ left: 9, top: 9, width: 10, height: 10 }),
    });
    page({ images: [hidden, below, shown] });
    await expect(measureImage(SRC, 'image', null)).resolves.toMatchObject({
      rect: { x: 9, y: 9, w: 10, h: 10 },
    });
    expect(shown.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(below.scrollIntoView).not.toHaveBeenCalled();
  });

  it('records the scroll position of every ancestor, nearest first, before it scrolls', async () => {
    const root = scroller(0, 700);
    const box = scroller(5, 40, root);
    const img = element({ parentElement: box });
    page({ images: [img] });
    img.scrollIntoView.mockImplementation(() => {
      box.scrollTop = 0;
      root.scrollTop = 1200;
    });
    await expect(measureImage(SRC, 'image', null)).resolves.toMatchObject({
      saved: [5, 40, 0, 700],
    });
  });

  it('writes the recorded positions back and answers null', async () => {
    const root = scroller(0, 1200);
    const box = scroller(0, 0, root);
    const img = element({ parentElement: box });
    page({ images: [img] });
    await expect(measureImage(SRC, 'image', [5, 40, 0, 700])).resolves.toBeNull();
    expect([box.scrollLeft, box.scrollTop, root.scrollLeft, root.scrollTop]).toEqual([
      5, 40, 0, 700,
    ]);
    expect(img.scrollIntoView).not.toHaveBeenCalled();
  });

  it('measures the one iframe with that src, without scrolling, with its client box', async () => {
    const frame = element({
      currentSrc: undefined,
      src: 'https://frame.example/',
      clientLeft: 2,
      clientTop: 3,
      clientWidth: 300,
      clientHeight: 200,
    });
    page({ frames: [element({ src: 'https://other/' }), frame] });
    await expect(measureImage('https://frame.example/', 'frame', null)).resolves.toEqual({
      rect: { x: 3, y: 4, w: 50, h: 60 },
      dpr: 1,
      saved: [],
      box: { x: 2, y: 3, w: 300, h: 200 },
    });
    expect(frame.scrollIntoView).not.toHaveBeenCalled();
  });

  it('answers null when two iframes have the same src, or none', async () => {
    const frame = () => element({ src: 'https://frame.example/' });
    page({ frames: [frame(), frame()] });
    await expect(measureImage('https://frame.example/', 'frame', null)).resolves.toBeNull();
    page({ frames: [] });
    await expect(measureImage('https://frame.example/', 'frame', null)).resolves.toBeNull();
  });
});

describe('loadImagePixels', () => {
  const PNG_BYTES = [137, 80, 78, 71];
  const PNG = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`;
  const constructed: FakeImage[] = [];
  const canvases: FakeCanvas[] = [];
  /** What the next convertToBlob calls do, in order; the last entry repeats. */
  let outcomes: ('ok' | 'tainted')[] = [];
  let calls = 0;
  let decodeFails = false;
  let naturalWidth = 40;

  class FakeImage {
    crossOrigin = '';
    src = '';
    complete = true;
    naturalHeight = 20;
    get naturalWidth() {
      return naturalWidth;
    }
    constructor() {
      constructed.push(this);
    }
    decode(): Promise<void> {
      return decodeFails ? Promise.reject(new Error('decode')) : Promise.resolve();
    }
  }
  class FakeCanvas {
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      canvases.push(this);
    }
    getContext() {
      return { drawImage: vi.fn() };
    }
    convertToBlob() {
      const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
      return outcome === 'tainted'
        ? Promise.reject(new DOMException('tainted', 'SecurityError'))
        : Promise.resolve({
            arrayBuffer: () => Promise.resolve(new Uint8Array(PNG_BYTES).buffer),
          });
    }
  }

  const setup = (images: unknown[], ...results: ('ok' | 'tainted')[]) => {
    constructed.length = 0;
    canvases.length = 0;
    outcomes = results.length > 0 ? results : ['ok'];
    calls = 0;
    decodeFails = false;
    naturalWidth = 40;
    vi.stubGlobal('document', { images });
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  };
  const shown = (extra: Record<string, unknown> = {}) => ({
    currentSrc: SRC,
    src: SRC,
    complete: true,
    naturalWidth: 40,
    naturalHeight: 20,
    ...extra,
  });

  it('draws the image that is on the page as it is: no second request', async () => {
    setup([shown()]);
    await expect(loadImagePixels(SRC)).resolves.toBe(PNG);
    expect(constructed).toHaveLength(0);
    expect(canvases).toEqual([expect.objectContaining({ width: 40, height: 20 })]);
  });

  it('loads the clicked URL again with CORS when the first draw is tainted', async () => {
    setup([shown()], 'tainted', 'ok');
    await expect(loadImagePixels(SRC)).resolves.toBe(PNG);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({ crossOrigin: 'anonymous', src: SRC });
  });

  it('loads the URL when the page has no such element (a lazy or CSS image)', async () => {
    setup([]);
    await expect(loadImagePixels(SRC)).resolves.toBe(PNG);
    expect(constructed[0]).toMatchObject({ crossOrigin: 'anonymous', src: SRC });
  });

  it('answers null when even the CORS load is tainted', async () => {
    setup([], 'tainted');
    await expect(loadImagePixels(SRC)).resolves.toBeNull();
  });

  it('answers null when the image cannot be decoded', async () => {
    setup([]);
    decodeFails = true;
    await expect(loadImagePixels(SRC)).resolves.toBeNull();
  });

  it('answers null for an image without a size', async () => {
    setup([]);
    naturalWidth = 0;
    await expect(loadImagePixels(SRC)).resolves.toBeNull();
  });

  it('scales the longest side to 2400', async () => {
    setup([shown({ naturalWidth: 5000, naturalHeight: 1000 })]);
    await loadImagePixels(SRC);
    expect(canvases).toEqual([expect.objectContaining({ width: 2400, height: 480 })]);
  });
});
