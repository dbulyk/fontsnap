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

/**
 * Answers the injected functions: `load` for loadImagePixels, `measure(kind, saved, frame)` for measureImage, `restore` for
 * measureImage with saved positions (true by default: they were put back).
 */
function script(options: {
  load?: () => string | null | Error;
  restore?: () => true | null | Error;
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
      : args[2] !== null
        ? options.restore
          ? options.restore()
          : true
        : (options.measure?.(args[0] as string, args[1] as 'image' | 'frame', null, frame ?? 0) ??
          null);
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

/** When (on the fake clock) each screenshot was asked for. */
let shots: number[];

// `capture` in clicked.ts remembers when it last took a screenshot, so every test starts on a clock an hour after the one before
let clock = Date.now();

beforeEach(() => {
  clock += 3_600_000;
  vi.useFakeTimers({ now: clock });
  stub = createChromeStub();
  stub.install();
  images = installImageApis();
  calls = [];
  shots = [];
  stub.chrome.tabs.captureVisibleTab.mockImplementation(() => {
    shots.push(Date.now());
    return Promise.resolve('data:image/png;base64,c2hvdA==');
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** clickedImage on the fake clock, which is moved on while the worker waits (the pause that keeps two screenshots apart). */
async function clickOn(
  info: Parameters<typeof clickedImage>[0],
  at: chrome.tabs.Tab | undefined,
): ReturnType<typeof clickedImage> {
  const running = clickedImage(info, at);
  const state = { settled: false };
  void running.finally(() => {
    state.settled = true;
  });
  while (!state.settled) await vi.advanceTimersByTimeAsync(50);
  return running;
}

const dataUrl = (type: string, bytes: Uint8Array) =>
  `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;

describe('data: images', () => {
  it('are decoded in the worker: no injection, no screenshot', async () => {
    const src = dataUrl('image/png', new Uint8Array(1000).fill(7));
    const entry = await clickOn({ srcUrl: src, frameId: 0 }, tab);
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
    const entry = await clickOn({ srcUrl: url(), frameId: 0 }, tab);
    expect(entry.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(calls.map((c) => c.fn)).toEqual(['load']);
  });
});

describe('step 1: the pixels are loaded in the frame of the click', () => {
  it('injects loadImagePixels into that frame with the address and nothing else', async () => {
    script({ load: () => PIXELS });
    const entry = await clickOn({ srcUrl: SRC, frameId: 7, frameUrl: 'https://f.example/' }, tab);
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
    await clickOn({ srcUrl: SRC }, tab);
    expect(calls[0]?.frame).toBe(0);
  });

  it('re-encodes the pixels within the session quota (they are decoded, so they must be an image)', async () => {
    script({ load: () => PIXELS });
    await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(images.createImageBitmap).toHaveBeenCalledTimes(1);
    expect(images.encodes[0]).toEqual({ type: 'image/png', quality: undefined });
  });

  it.each([
    ['null', () => null],
    ['not base64', () => 'https://example.invalid/x'],
    ['a refused injection', () => new Error('Cannot access contents of the page')],
  ])('goes to step 2 when the loader answers %s', async (_what, load) => {
    script({ load, measure: () => measured() });
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(entry.note).toBeUndefined();
    expect(images.draws).toEqual([[60, 80, 200, 100, 0, 0, 200, 100]]);
  });
});

describe('step 2: a crop of a screenshot, the scroll position put back', () => {
  it('measures, takes the screenshot, crops by the box × dpr and restores the saved positions', async () => {
    script({ measure: () => measured() });
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
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
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.note).toBe('whole-view');
    expect(calls.filter((c) => c.fn === 'measure').map((c) => c.args[2])).toEqual([null, [1, 2]]);
  });

  // Q1 (the manager of FontSnap): the scroll is put back, also on failure; when it cannot be, that is not passed over in silence,
  // and the whole visible area with the hint is what the user gets
  it.each([
    ['the restore fails', () => new Error('frame is gone')],
    ['the page did not scroll back (it changed meanwhile)', () => null],
  ])('goes to step 3 when %s, after trying to put back every position', async (_what, restore) => {
    script({ measure: () => measured(), restore });
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.note).toBe('whole-view');
    expect(calls.filter((c) => c.fn === 'measure' && c.args[2] !== null)).toHaveLength(1);
  });

  it('puts the frame back too when the image cannot be put back', async () => {
    script({
      measure: (_t, kind) => (kind === 'frame' ? measured({ saved: [0, 7, 8] }) : measured()),
      restore: () => null,
    });
    const entry = await clickOn({ srcUrl: SRC, frameId: 3, frameUrl: 'https://f.example/' }, tab);
    expect(entry.note).toBe('whole-view');
    const restores = calls.filter((c) => c.fn === 'measure' && c.args[2] !== null);
    expect(restores.map((c) => [c.args[1], c.frame])).toEqual([
      ['image', 3],
      ['frame', 0],
    ]);
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
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.note).toBe('whole-view');
  });

  it('crops the visible part of an image that is larger than the screenshot', async () => {
    script({ measure: () => measured({ rect: { x: -100, y: -50, w: 1000, h: 800 }, dpr: 1 }) });
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
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
      const entry = await clickOn(click, tab);
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
      const entry = await clickOn(click, tab);
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
      const entry = await clickOn(click, tab);
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
      const entry = await clickOn(click, tab);
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
      const entry = await clickOn(click, tab);
      expect(entry.note).toBe('whole-view');
      expect(calls.filter((c) => c.fn === 'measure' && c.args[2] !== null).length).toBe(2);
    });

    it('goes to step 3 without measuring when the click does not say which frame URL it came from', async () => {
      script({ measure });
      const entry = await clickOn({ srcUrl: SRC, frameId: 3 }, tab);
      expect(entry.note).toBe('whole-view');
      expect(calls.filter((c) => c.fn === 'measure')).toEqual([]);
    });
  });
});

describe('step 3: the whole visible area with a hint', () => {
  it('keeps the screenshot and says it is the whole view when no injection works', async () => {
    script({ load: () => new Error('refused'), measure: () => new Error('refused') });
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.dataUrl).toMatch(/^data:image\/png/);
    expect(entry.note).toBe('whole-view');
    expect(entry.text).toBe('');
    expect(images.draws).toEqual([[0, 0, 400, 300, 0, 0, 400, 300]]);
  });

  const READBACK = 'Failed to capture tab: image readback failed';

  it('takes the screenshot again, once and after the pause of the quota, when the browser fails to read it back (image readback failed)', async () => {
    script({ load: () => null, measure: () => null });
    stub.chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error(READBACK));
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.dataUrl).toMatch(/^data:image\/png/);
    expect(entry.note).toBe('whole-view');
    expect(entry.error).toBeUndefined();
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('shows the error when the second read-back fails too (no third try)', async () => {
    script({ load: () => null, measure: () => null });
    stub.chrome.tabs.captureVisibleTab.mockRejectedValue(new Error(READBACK));
    await expect(clickOn({ srcUrl: SRC, frameId: 0 }, tab)).resolves.toEqual({ error: READBACK });
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the quota', 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'],
    ['a tab that is not active', 'The tab is not active'],
    ['a page that is not allowed', 'Cannot access contents of the page.'],
    ['no permission', "Either the '<all_urls>' or 'activeTab' permission is required."],
  ])('does not take it again after an error that will come back (%s)', async (_what, message) => {
    script({ load: () => null, measure: () => null });
    stub.chrome.tabs.captureVisibleTab.mockRejectedValue(new Error(message));
    await expect(clickOn({ srcUrl: SRC, frameId: 0 }, tab)).resolves.toEqual({ error: message });
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(1);
  });

  it('shows the error when even the screenshot cannot be taken', async () => {
    script({ load: () => null, measure: () => null });
    stub.chrome.tabs.captureVisibleTab.mockRejectedValue(new Error('The tab is not active'));
    await expect(clickOn({ srcUrl: SRC, frameId: 0 }, tab)).resolves.toEqual({
      error: 'The tab is not active',
    });
  });

  it('shows an error when there is no tab to script', async () => {
    await expect(clickOn({ srcUrl: SRC, frameId: 0 }, undefined)).resolves.toEqual({
      error: 'Could not access this image',
    });
    expect(stub.chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
});

// Chrome lets an extension call captureVisibleTab twice a second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND): the third call within the
// second fails with the quota, whatever the page does. Steps 2 and 3 take their screenshots through one helper that keeps the calls apart.
describe('the screenshots of steps 2 and 3 stay within the quota of Chrome', () => {
  const READBACK = 'Failed to capture tab: image readback failed';
  /** No window of one second holds more than two of the times. */
  const withinQuota = (times: number[]): boolean =>
    times.every((time, i) => (times[i + 2] ?? Infinity) - time >= 1000);

  it('step 2 and step 3 after it: the second screenshot waits for the pause', async () => {
    script({ measure: () => measured({ rect: { x: 5000, y: 0, w: 10, h: 10 } }) });
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.note).toBe('whole-view');
    expect(shots).toHaveLength(2);
    expect((shots[1] ?? 0) - (shots[0] ?? 0)).toBeGreaterThanOrEqual(1000);
  });

  it('step 2 that fails to read back is taken again, and the crop is still the image', async () => {
    script({ measure: () => measured() });
    stub.chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error(READBACK));
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.note).toBeUndefined();
    expect(images.draws).toEqual([[60, 80, 200, 100, 0, 0, 200, 100]]);
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
  });

  it('a read-back that fails in step 2 and again in the retry goes on to step 3, which is the third screenshot, still within the quota', async () => {
    script({ measure: () => measured() });
    stub.chrome.tabs.captureVisibleTab
      .mockRejectedValueOnce(new Error(READBACK))
      .mockRejectedValueOnce(new Error(READBACK));
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.note).toBe('whole-view');
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(3);
    expect(withinQuota(shots)).toBe(true);
  });

  it('two clicks one after the other do not make a third call within the second', async () => {
    script({ load: () => null, measure: () => null });
    await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(shots).toHaveLength(3);
    expect(withinQuota(shots)).toBe(true);
  });

  it('clicks at the same time do not take their screenshots together', async () => {
    script({ load: () => null, measure: () => null });
    const all = Promise.all([1, 2, 3, 4].map(() => clickedImage({ srcUrl: SRC, frameId: 0 }, tab)));
    await vi.advanceTimersByTimeAsync(10_000);
    const entries = await all;
    expect(entries.every((e) => e.note === 'whole-view')).toBe(true);
    expect(shots).toHaveLength(4);
    expect(withinQuota(shots)).toBe(true);
  });

  it('shows the read-back error, not the error of the retry, when the retry fails too', async () => {
    script({ load: () => null, measure: () => null });
    stub.chrome.tabs.captureVisibleTab
      .mockRejectedValueOnce(new Error(READBACK))
      .mockRejectedValueOnce(
        new Error('This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'),
      );
    await expect(clickOn({ srcUrl: SRC, frameId: 0 }, tab)).resolves.toEqual({ error: READBACK });
  });
});

// QA of round 2, nit 1: captureVisibleTab takes the tab that is in front of the window. A click that waited for its turn behind
// another one found the result tab of the first click in front, and Chrome refused the screenshot ("activeTab permission is required").
describe('the screenshot is of the tab of the click', () => {
  it('is not taken when that tab is no longer in front, and says so', async () => {
    script({ load: () => null, measure: () => null });
    stub.chrome.tabs.get.mockResolvedValue({ id: 5, active: false } as chrome.tabs.Tab);
    const entry = await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(entry.error).toMatch(/no longer in front/);
    expect(stub.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('asks for the tab of the click itself, right before each screenshot', async () => {
    script({ measure: () => measured({ rect: { x: 5000, y: 0, w: 10, h: 10 } }) });
    await clickOn({ srcUrl: SRC, frameId: 0 }, tab);
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledTimes(2);
    expect(stub.chrome.tabs.get.mock.calls).toEqual([[5], [5]]);
  });
});

describe('a page that does not answer', () => {
  it('does not keep the worker waiting for the loader: step 2 follows after the time is up', async () => {
    stub.chrome.scripting.executeScript.mockImplementation((injection) => {
      const { func, args } = injection as { func: unknown; args: unknown[] };
      return func === loadImagePixels
        ? new Promise(() => undefined)
        : Promise.resolve([{ result: args[2] === null ? measured() : true }]);
    });
    const done = clickedImage({ srcUrl: SRC, frameId: 0 }, tab);
    await vi.advanceTimersByTimeAsync(30_000);
    const entry = await done;
    expect(entry.note).toBeUndefined();
    expect(images.draws).toEqual([[60, 80, 200, 100, 0, 0, 200, 100]]);
  });

  it('gives up on a page that never answers a measurement and shows the whole view', async () => {
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
    await clickOn({ srcUrl: SRC, frameId: 4, frameUrl: 'https://frame.example/' }, tab);
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
