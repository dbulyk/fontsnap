import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickedImage } from '../../src/background/clicked';
import { loadImagePixels } from '../../src/background/load-image';
import { measureImage, type MeasuredImage } from '../../src/background/measure';
import { MAX_IMAGE_BYTES } from '../../src/shared/capture';
import { createChromeStub } from './helpers/chrome-stub';
import { installImageApis } from './helpers/image-apis';

// The ladder of "Identify font in this image": (1) the pixels loaded in the frame of the click, (2) a crop of a screenshot with the
// scroll position restored, (3) the whole visible area with a hint. The page functions are stood in for by `script`.
const tab = {
  id: 5,
  index: 2,
  windowId: 9,
  url: 'https://page.example/article',
} as chrome.tabs.Tab;
const SRC = 'https://cdn.example/photo.png';
const PIXELS = 'UElYRUxT';

interface Call {
  fn: 'load' | 'measure';
  frame: number | undefined;
  args: unknown[];
}

let stub: ReturnType<typeof createChromeStub>;
let images: ReturnType<typeof installImageApis>;
let calls: Call[];

/** Answers the injected functions: `load` for loadImagePixels, `measure(kind, saved, frame)` for measureImage. */
function script(options: {
  load?: () => string | null | Error;
  measure?: (
    target: string,
    kind: 'image' | 'frame',
    saved: readonly number[] | null,
    frame: number,
  ) => MeasuredImage | null | Error;
}) {
  stub.chrome.scripting.executeScript.mockImplementation((injection) => {
    const { func, args, target } = injection as {
      func: unknown;
      args: unknown[];
      target: { frameIds?: number[] };
    };
    const frame = target.frameIds?.[0];
    const isLoad = func === loadImagePixels;
    if (!isLoad && func !== measureImage) throw new Error('an unknown function was injected');
    calls.push({ fn: isLoad ? 'load' : 'measure', frame, args });
    const answer = isLoad
      ? (options.load?.() ?? null)
      : (options.measure?.(
          args[0] as string,
          args[1] as 'image' | 'frame',
          args[2] as number[] | null,
          frame ?? 0,
        ) ?? null);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve([{ result: answer }]);
  });
}

const measured = (extra: Partial<MeasuredImage> = {}): MeasuredImage => ({
  rect: { x: 30, y: 40, w: 100, h: 50 },
  dpr: 2,
  saved: [1, 2],
  box: { x: 0, y: 0, w: 800, h: 600 },
  outer: { x: 0, y: 0, w: 800, h: 600 },
  ...extra,
});

beforeEach(() => {
  stub = createChromeStub();
  stub.install();
  images = installImageApis();
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const dataUrl = (type: string, bytes: Uint8Array) =>
  `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

describe('data: images', () => {
  it('are decoded in the worker: no injection, no screenshot', async () => {
    const src = dataUrl('image/png', new Uint8Array(1000).fill(7));
    const entry = await clickedImage({ srcUrl: src, frameId: 0 }, tab);
    expect(entry).toEqual({ dataUrl: src, text: '' });
    expect(stub.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(stub.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it.each([
    ['an SVG', () => dataUrl('image/svg+xml', new TextEncoder().encode('<svg/>'))],
    ['not an image', () => dataUrl('text/html', new TextEncoder().encode('x'))],
    ['too large', () => dataUrl('image/png', new Uint8Array(MAX_IMAGE_BYTES))],
    ['malformed', () => 'data:image/png;base64,@@@@'],
  ])('go down the ladder when the data: URL is %s', async (_what, url) => {
    script({ load: () => PIXELS });
    const entry = await clickedImage({ srcUrl: url(), frameId: 0 }, tab);
    expect(entry.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(calls.map((c) => c.fn)).toEqual(['load']);
  });
});

describe('step 1: the pixels are loaded in the frame of the click', () => {
  it('injects loadImagePixels into that frame with the address and nothing else', async () => {
    script({ load: () => PIXELS });
    const entry = await clickedImage(
      { srcUrl: SRC, frameId: 7, frameUrl: 'https://f.example/' },
      tab,
    );
    expect(entry.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(entry.text).toBe('');
    expect(entry.note).toBeUndefined();
    expect(stub.chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 5, frameIds: [7] },
      args: [SRC],
      func: loadImagePixels,
    });
    expect(stub.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(images.fetch).not.toHaveBeenCalled();
  });

  it('uses the top frame when the click has no frame', async () => {
    script({ load: () => PIXELS });
    await clickedImage({ srcUrl: SRC }, tab);
    expect(calls[0]?.frame).toBe(0);
  });

  it('re-encodes the pixels within the session quota (they are decoded, so they must be an image)', async () => {
    script({ load: () => PIXELS });
    await clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    expect(images.createImageBitmap).toHaveBeenCalledTimes(1);
    expect(images.encodes[0]).toEqual({ type: 'image/png', quality: undefined });
  });

  it.each([
    ['null', () => null],
    ['not base64', () => 'https://example.invalid/x'],
    ['a refused injection', () => new Error('Cannot access contents of the page')],
  ])('goes to step 2 when the loader answers %s', async (_what, load) => {
    script({ load, measure: () => measured() });
    const entry = await clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(entry.note).toBeUndefined();
    expect(images.draws).toEqual([[60, 80, 200, 100, 0, 0, 200, 100]]);
  });
});

describe('step 2: a crop of a screenshot, the scroll position put back', () => {
  it('measures, takes the screenshot, crops by the box × dpr and restores the saved positions', async () => {
    script({ measure: () => measured() });
    const entry = await clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.dataUrl).toMatch(/^data:image\/png/);
    expect(entry.note).toBeUndefined();
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(9, { format: 'png' });
    expect(images.draws).toEqual([[60, 80, 200, 100, 0, 0, 200, 100]]);
    expect(calls.filter((c) => c.fn === 'measure').map((c) => c.args)).toEqual([
      [SRC, 'image', null],
      [SRC, 'image', [1, 2]],
    ]);
  });

  it('restores the scroll position even when the screenshot fails (and goes on to step 3)', async () => {
    script({ measure: () => measured() });
    stub.chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('no activeTab'));
    const entry = await clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.note).toBe('whole-view');
    expect(calls.filter((c) => c.fn === 'measure').map((c) => c.args[2])).toEqual([null, [1, 2]]);
  });

  it('keeps going when the restore itself fails', async () => {
    script({
      measure: (_t, _k, saved) => (saved === null ? measured() : new Error('frame is gone')),
    });
    const entry = await clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.dataUrl).toBeDefined();
    expect(entry.note).toBeUndefined();
  });

  it.each([
    ['the image is not found', () => null],
    ['its box is empty', () => measured({ rect: { x: 0, y: 0, w: 0, h: 0 } })],
    [
      'it is entirely outside the screenshot',
      () => measured({ rect: { x: 5000, y: 0, w: 10, h: 10 } }),
    ],
  ])('goes to step 3 when %s', async (_what, measure) => {
    script({ measure });
    const entry = await clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.note).toBe('whole-view');
  });

  it('crops the visible part of an image that is larger than the screenshot', async () => {
    script({ measure: () => measured({ rect: { x: -100, y: -50, w: 1000, h: 800 }, dpr: 1 }) });
    const entry = await clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.note).toBeUndefined();
    expect(images.draws).toEqual([[0, 0, 400, 300, 0, 0, 400, 300]]);
  });

  describe('in an iframe: the position of the frame is added', () => {
    const FRAME = 'https://frame.example/';
    const click = { srcUrl: SRC, frameId: 3, frameUrl: FRAME };
    const measure = (target: string, kind: 'image' | 'frame', _saved: unknown, frame: number) => {
      if (kind === 'frame') {
        return measured({
          rect: { x: 10, y: 20, w: 300, h: 200 },
          dpr: 1,
          saved: [0, 50],
          box: { x: 1, y: 1, w: 298, h: 198 },
          outer: { x: 0, y: 0, w: 300, h: 200 },
        });
      }
      return frame === 3 && target === SRC
        ? measured({
            rect: { x: 10, y: 20, w: 40, h: 30 },
            dpr: 1,
            saved: [0, 0],
            box: { x: 0, y: 0, w: 298, h: 198 },
          })
        : null;
    };

    it('measures the frame, then the image, then the frame again, and puts both back', async () => {
      script({ measure });
      const entry = await clickedImage(click, tab);
      expect(entry.note).toBeUndefined();
      expect(calls.filter((c) => c.fn === 'measure').map((c) => [c.frame, ...c.args])).toEqual([
        [0, FRAME, 'frame', null],
        [3, SRC, 'image', null],
        [0, FRAME, 'frame', null],
        [3, SRC, 'image', [0, 0]],
        [0, FRAME, 'frame', [0, 50]],
      ]);
      expect(images.draws).toEqual([[21, 41, 40, 30, 0, 0, 40, 30]]);
    });

    it.each([
      [
        'the iframe is not found (or there are two)',
        () => {
          script({ measure: (t, k, s, f) => (k === 'frame' ? null : measure(t, k, s, f)) });
        },
      ],
      [
        'the frame cannot be scripted',
        () => {
          script({ measure: () => new Error('Cannot access contents') });
        },
      ],
    ])('goes to step 3 when %s', async (_what, arrange) => {
      arrange();
      const entry = await clickedImage(click, tab);
      expect(entry.note).toBe('whole-view');
      // the frame is looked for first: with no iframe to put it in, the image is not even scrolled into view
      expect(calls.filter((c) => c.fn === 'measure' && c.args[1] === 'image')).toEqual([]);
    });

    it('goes to step 3 when the frame found by its URL is not the frame of the click (a nested frame with the same URL)', async () => {
      script({
        measure: (target, kind, saved, frame) =>
          kind === 'frame'
            ? measured({
                rect: { x: 10, y: 20, w: 520, h: 420 },
                dpr: 1,
                saved: [0],
                box: { x: 1, y: 1, w: 500, h: 400 },
                outer: { x: 0, y: 0, w: 520, h: 420 },
              })
            : measure(target, kind, saved, frame),
      });
      const entry = await clickedImage(click, tab);
      expect(entry.note).toBe('whole-view');
      expect(images.draws).toEqual([[0, 0, 400, 300, 0, 0, 400, 300]]);
    });

    it('follows a border of its own on every side of the iframe', async () => {
      // border 7 | 2 and 3 | 11: the document inside is 291 x 186 and starts 7 and 3 pixels in
      script({
        measure: (target, kind, _saved, frame) =>
          kind === 'frame'
            ? measured({
                rect: { x: 10, y: 20, w: 300, h: 200 },
                dpr: 1,
                saved: [0, 50],
                box: { x: 7, y: 3, w: 291, h: 186 },
                outer: { x: 0, y: 0, w: 300, h: 200 },
              })
            : frame === 3 && target === SRC
              ? measured({
                  rect: { x: 10, y: 20, w: 40, h: 30 },
                  dpr: 1,
                  saved: [0, 0],
                  box: { x: 0, y: 0, w: 291, h: 186 },
                })
              : null,
      });
      const entry = await clickedImage(click, tab);
      expect(entry.note).toBeUndefined();
      expect(images.draws).toEqual([[27, 43, 40, 30, 0, 0, 40, 30]]);
    });

    it('goes to step 3 when the iframe has padding (which side it is on cannot be read), and puts the scroll back', async () => {
      script({
        measure: (target, kind, _saved, frame) =>
          kind === 'frame'
            ? measured({
                rect: { x: 10, y: 20, w: 300, h: 200 },
                dpr: 1,
                saved: [0, 50],
                box: { x: 1, y: 1, w: 298, h: 198 },
                outer: { x: 0, y: 0, w: 300, h: 200 },
              })
            : frame === 3 && target === SRC
              ? measured({
                  rect: { x: 10, y: 20, w: 40, h: 30 },
                  dpr: 1,
                  saved: [0, 0],
                  box: { x: 0, y: 0, w: 284, h: 192 },
                })
              : null,
      });
      const entry = await clickedImage(click, tab);
      expect(entry.note).toBe('whole-view');
      expect(calls.filter((c) => c.fn === 'measure' && c.args[2] !== null).length).toBe(2);
    });

    it('goes to step 3 without measuring when the click does not say which frame URL it came from', async () => {
      script({ measure });
      const entry = await clickedImage({ srcUrl: SRC, frameId: 3 }, tab);
      expect(entry.note).toBe('whole-view');
      expect(calls.filter((c) => c.fn === 'measure')).toEqual([]);
    });
  });
});

describe('step 3: the whole visible area with a hint', () => {
  it('keeps the screenshot and says it is the whole view when no injection works', async () => {
    script({ load: () => new Error('refused'), measure: () => new Error('refused') });
    const entry = await clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.dataUrl).toMatch(/^data:image\/png/);
    expect(entry.note).toBe('whole-view');
    expect(entry.text).toBe('');
    expect(images.draws).toEqual([[0, 0, 400, 300, 0, 0, 400, 300]]);
  });

  it('takes the screenshot again when the browser fails to read it back once (image readback failed)', async () => {
    script({ load: () => null, measure: () => null });
    stub.chrome.tabs.captureVisibleTab.mockRejectedValueOnce(
      new Error('Failed to capture tab: image readback failed'),
    );
    const entry = await clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.dataUrl).toMatch(/^data:image\/png/);
    expect(entry.note).toBe('whole-view');
    expect(entry.error).toBeUndefined();
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('shows the error when even the screenshot cannot be taken', async () => {
    script({ load: () => null, measure: () => null });
    stub.chrome.tabs.captureVisibleTab.mockRejectedValue(new Error('The tab is not active'));
    await expect(clickedImage({ srcUrl: SRC, frameId: 0 }, tab)).resolves.toEqual({
      error: 'The tab is not active',
    });
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(3);
  });

  it('shows an error when there is no tab to script', async () => {
    await expect(clickedImage({ srcUrl: SRC, frameId: 0 }, undefined)).resolves.toEqual({
      error: 'Could not access this image',
    });
    expect(stub.chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe('a page that does not answer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not keep the worker waiting for the loader: step 2 follows after the time is up', async () => {
    vi.useFakeTimers();
    stub.chrome.scripting.executeScript.mockImplementation((injection) => {
      const { func } = injection as { func: unknown };
      return func === loadImagePixels
        ? new Promise(() => undefined)
        : Promise.resolve([{ result: measured() }]);
    });
    const done = clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    await vi.advanceTimersByTimeAsync(30_000);
    const entry = await done;
    expect(entry.note).toBeUndefined();
    expect(images.draws).toEqual([[60, 80, 200, 100, 0, 0, 200, 100]]);
  });

  it('gives up on a page that never answers a measurement and shows the whole view', async () => {
    vi.useFakeTimers();
    stub.chrome.scripting.executeScript.mockImplementation(() => new Promise(() => undefined));
    const done = clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await done).note).toBe('whole-view');
  });
});

describe('what is handed to the page', () => {
  it('is only the address of the image, the frame URL, the kind and the saved numbers', async () => {
    script({
      load: () => null,
      measure: (_t, k) =>
        k === 'frame' ? measured() : measured({ rect: { x: 1, y: 1, w: 20, h: 20 } }),
    });
    await clickedImage({ srcUrl: SRC, frameId: 4, frameUrl: 'https://frame.example/' }, tab);
    for (const call of calls) {
      for (const arg of call.args) {
        const fine =
          arg === null ||
          typeof arg === 'string' ||
          (Array.isArray(arg) && arg.every((n) => typeof n === 'number'));
        expect(fine, JSON.stringify(call)).toBe(true);
      }
    }
    expect(calls.every((c) => (c.fn === 'load' ? c.args.length === 1 : c.args.length === 3))).toBe(
      true,
    );
  });
});
