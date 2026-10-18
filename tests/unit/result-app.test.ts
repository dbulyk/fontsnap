import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initResult } from '../../src/result/app';
import type { Model } from '../../src/result/model';
import { makeRanker, type Meta } from '../../src/shared/core/ranker';
import { errorResultHash } from '../../src/shared/capture';
import { visibleResults } from '../../src/shared/ui';
import { createChromeStub } from './helpers/chrome-stub';
import { must } from './helpers/dom';

const modelMock = vi.hoisted(() => ({ loadModel: vi.fn() }));
vi.mock('../../src/result/model', () => modelMock);

const META: Meta = {
  fams: ['inter', 'intertight', 'notosans', 'notosansdisplay', 'notosansjp', 'roboto', 'rare'],
  display: [
    'Inter',
    'Inter Tight',
    'Noto Sans',
    'Noto Sans Display',
    'Noto Sans JP',
    'Roboto',
    'Rare',
  ],
  inGF: [true, true, true, true, true, true, false],
  category: [
    'Sans Serif',
    'Sans Serif',
    'Sans Serif',
    'Sans Serif',
    'Sans Serif',
    'Sans Serif',
    '',
  ],
  rank: [1, 400, 10, 900, 50, 2, 3000],
  classFam: [0, 0, 1, 2, 3, 4, 5, 6],
  merge: { intertight: 'inter', notosansdisplay: 'notosans' },
  keepNoto: ['notosansjp'],
};
/** A confident prediction: the best family takes ~96%, so the tail rounds below 1% and is hidden. */
const CONFIDENT = Float64Array.from([0.96, 0.02, 0.005, 0.005, 0.004, 0.003, 0.002, 0.001]);

let stub: ReturnType<typeof createChromeStub>;
let win: Window;
let document: Document;
let probs: ReturnType<typeof vi.fn<(crop: unknown) => Promise<Float64Array>>>;
let scene: { width: number; height: number; rgba: Uint8ClampedArray };
let bitmapClose: ReturnType<typeof vi.fn>;
let canvasDraws: { id: string; args: number[] }[];

/** A white page with a line of dark glyph-like blocks: enough for the text finder to see a line. */
function textScene(width = 160, height = 48) {
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let x = 12; x < width - 12; x += 14) {
    for (let y = 14; y < 34; y++) {
      for (let dx = 0; dx < 8; dx++) {
        const i = (y * width + x + dx) * 4;
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 10;
      }
    }
  }
  return { width, height, rgba };
}

const $ = (id: string) => must(document.getElementById(id), id);
const field = (id: string) => must(document.querySelector<HTMLInputElement>(`#${id}`), id);
const names = () => [...document.querySelectorAll('#results .name')].map((e) => e.textContent);
const status = () => $('status');

function pick(file: Blob): void {
  const input = field('file');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new win.Event('change') as unknown as Event);
}

async function start(options: { hash?: string; locale?: string } = {}): Promise<void> {
  win = new Window({
    url: `chrome-extension://test-extension-id/result/result.html${options.hash ?? ''}`,
  });
  document = win.document as unknown as Document;
  document.documentElement.innerHTML = readFileSync('src/result/result.html', 'utf8');
  canvasDraws = [];
  (win.HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function (
    this: HTMLCanvasElement,
  ) {
    const id = this.id;
    return {
      drawImage: (...args: number[]) => canvasDraws.push({ id, args: args.slice(1) }),
      getImageData: () => ({ data: scene.rgba }),
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: vi.fn(),
    };
  };
  initResult(document);
  await Promise.resolve();
}

beforeEach(() => {
  stub = createChromeStub();
  stub.install();
  scene = textScene();
  bitmapClose = vi.fn();
  probs = vi.fn(() => Promise.resolve(CONFIDENT));
  const model: Model = { ranker: makeRanker(META), probs };
  modelMock.loadModel.mockReset().mockResolvedValue(model);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width: scene.width, height: scene.height, close: bitmapClose })),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ blob: () => Promise.resolve(new Blob(['png'], { type: 'image/png' })) }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  void win.happyDOM.close();
});

describe('loading', () => {
  it('is localized and shows "Loading model…" until the model is ready, then "Ready."', async () => {
    let release: (m: Model) => void = () => undefined;
    modelMock.loadModel.mockReturnValue(new Promise<Model>((r) => (release = r)));
    await start();
    expect(status().textContent).toBe('Loading model…');
    expect(document.title).toBe('FontSnap — results');
    expect(field('pvText').placeholder).toBe('Type your own text (default: The quick brown fox…)');
    release({ ranker: makeRanker(META), probs });
    await vi.waitFor(() => {
      expect(status().textContent).toBe('Ready. Paste, drop or choose an image.');
    });
    expect(status().className).toBe('status');
  });

  it('shows why the model failed to load', async () => {
    modelMock.loadModel.mockRejectedValue(new Error('wasm compile failed'));
    await start();
    await vi.waitFor(() => {
      expect(status().textContent).toBe('Model failed to load: wasm compile failed');
    });
    expect(status().className).toBe('status err');
  });
});

describe('identifying an image', () => {
  it('analyses a chosen file and lists the best families without any timing', async () => {
    await start();
    await vi.waitFor(() => {
      expect(status().textContent).toMatch(/^Ready/);
    });
    pick(new Blob(['png'], { type: 'image/png' }));
    await vi.waitFor(() => {
      expect($('results').children.length).toBeGreaterThan(0);
    });
    const expected = visibleResults(
      makeRanker(META).rank([CONFIDENT, CONFIDENT], { alpha: 0.5, merge: true, k: 5 }),
    );
    expect(expected.length).toBeLessThan(5); // the <1% tail is hidden
    expect(names()).toEqual(expected.map((r, i) => `${i + 1}. ${r.name}`));
    await vi.waitFor(() => {
      expect(status().textContent).toBe('');
    });
    expect(status().className).toBe('status');
    // pack + crop variants, in this order, each through the model once
    expect(probs).toHaveBeenCalledTimes(2);
    expect($('shot').style.display).toBe('block');
    expect($('dropHint').style.display).toBe('none');
    expect(bitmapClose).toHaveBeenCalled();
  });

  it('ranks exactly as the evaluation does: both crops, popularity prior alpha 0.5, family merge, top 5', async () => {
    const ranker = makeRanker(META);
    const rank = vi.fn(ranker.rank);
    modelMock.loadModel.mockResolvedValue({ ranker: { ...ranker, rank }, probs });
    await start();
    pick(new Blob(['png']));
    await vi.waitFor(() => {
      expect(rank).toHaveBeenCalledTimes(1);
    });
    expect(rank).toHaveBeenCalledWith([CONFIDENT, CONFIDENT], { alpha: 0.5, merge: true, k: 5 });
    // the two test-time-augmentation variants are the packed crop and the stacked crop, in this order
    const crops = probs.mock.calls.map(([crop]) => crop as { w: number; h: number });
    expect(crops).toHaveLength(2);
    expect(crops[0]?.h).toBeLessThanOrEqual(crops[1]?.h ?? 0);
  });

  it('never shows how long the recognition took', async () => {
    await start();
    pick(new Blob(['png']));
    await vi.waitFor(() => {
      expect(status().textContent).toBe('');
    });
    expect(document.body.textContent).not.toMatch(/\b\d+(\.\d+)?\s?(ms|s|sec|seconds)\b/i);
    expect($('results').textContent).not.toMatch(/\bms\b/);
  });

  it('shows "Analyzing…" while the model runs', async () => {
    await start();
    let release: (p: Float64Array) => void = () => undefined;
    probs.mockReturnValue(new Promise<Float64Array>((r) => (release = r)));
    pick(new Blob(['png']));
    await vi.waitFor(() => {
      expect(status().textContent).toBe('Analyzing…');
    });
    probs.mockResolvedValue(CONFIDENT);
    release(CONFIDENT);
    await vi.waitFor(() => {
      expect(status().textContent).toBe('');
    });
  });

  it('warns when no clear text lines are found, but still shows the guess', async () => {
    await start();
    scene = { width: 60, height: 40, rgba: new Uint8ClampedArray(60 * 40 * 4).fill(255) };
    pick(new Blob(['png']));
    await vi.waitFor(() => {
      expect(status().textContent).toMatch(/^No clear text lines/);
    });
    expect(status().className).toBe('status err');
    expect($('results').children.length).toBeGreaterThan(0);
  });

  it('says so when the file is not a readable image', async () => {
    await start();
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('decode'));
    pick(new Blob(['nope']));
    await vi.waitFor(() => {
      expect(status().textContent).toBe('Could not read this image.');
    });
    expect(status().className).toBe('status err');
  });

  it('reports an error from the model', async () => {
    await start();
    probs.mockRejectedValue(new Error('session crashed'));
    pick(new Blob(['png']));
    await vi.waitFor(() => {
      expect(status().textContent).toBe('Error: session crashed');
    });
    expect(status().className).toBe('status err');
  });

  it('downscales huge images so the long side is 2400 px', async () => {
    await start();
    scene = { ...textScene(), width: 6000, height: 3000 };
    pick(new Blob(['png']));
    await vi.waitFor(() => {
      expect($('shot').getAttribute('width')).toBe('2400');
    });
    expect($('shot').getAttribute('height')).toBe('1200');
    expect(canvasDraws.find((d) => d.id === 'shot')?.args).toEqual([0, 0, 2400, 1200]);
  });

  it('keeps small images at their size', async () => {
    await start();
    pick(new Blob(['png']));
    await vi.waitFor(() => {
      expect($('shot').getAttribute('width')).toBe('160');
    });
  });

  it('draws what the model sees (the packed crop) into the debug canvas', async () => {
    await start();
    pick(new Blob(['png']));
    await vi.waitFor(() => {
      expect(Number($('seen').getAttribute('width'))).toBeGreaterThan(0);
    });
  });

  it('drops the result of an older image when a newer one was started', async () => {
    await start();
    const pending: ((p: Float64Array) => void)[] = [];
    probs.mockImplementation(
      () =>
        new Promise<Float64Array>((r) => {
          pending.push(r);
        }),
    );
    pick(new Blob(['one']));
    await vi.waitFor(() => {
      expect(pending).toHaveLength(1);
    });
    pick(new Blob(['two']));
    await vi.waitFor(() => {
      expect(pending).toHaveLength(2);
    });
    // finish the newer run first (pack, then crop), then the older one
    const rare = Float64Array.from([0, 0, 0, 0, 0, 0, 0, 1]);
    const inter = Float64Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
    probs.mockResolvedValueOnce(rare).mockResolvedValueOnce(inter);
    pending[1]?.(rare);
    await vi.waitFor(() => {
      expect(names()[0]).toBe('1. Rare');
    });
    pending[0]?.(inter);
    await vi.waitFor(() => {
      expect(probs).toHaveBeenCalledTimes(4); // the older run finished its work ...
    });
    await Promise.resolve();
    expect(names()[0]).toBe('1. Rare'); // ... and its result was dropped
  });

  it('re-renders the cards with the preview text typed by the user, without re-running the model', async () => {
    await start();
    pick(new Blob(['png']));
    await vi.waitFor(() => {
      expect($('results').children.length).toBeGreaterThan(0);
    });
    const calls = probs.mock.calls.length;
    const input = field('pvText');
    input.value = '  Hello preview ';
    input.dispatchEvent(new win.Event('input') as unknown as Event);
    expect(document.querySelector('.sample')?.textContent).toBe('Hello preview');
    expect(probs.mock.calls.length).toBe(calls);
  });

  it('ignores typing before there is anything to show', async () => {
    await start();
    $('pvText').dispatchEvent(new win.Event('input') as unknown as Event);
    expect($('results').children).toHaveLength(0);
  });
});

describe('paste and drop', () => {
  it('analyses an image pasted from the clipboard and ignores other clipboard content', async () => {
    await start();
    const paste = (items: { type: string; getAsFile: () => Blob | null }[]) => {
      const event = new win.Event('paste');
      Object.defineProperty(event, 'clipboardData', { value: { items } });
      document.dispatchEvent(event as unknown as Event);
    };
    paste([{ type: 'text/plain', getAsFile: () => null }]);
    await Promise.resolve();
    expect(createImageBitmap).not.toHaveBeenCalled();
    paste([
      { type: 'text/plain', getAsFile: () => null },
      { type: 'image/png', getAsFile: () => new Blob(['png'], { type: 'image/png' }) },
    ]);
    await vi.waitFor(() => {
      expect($('results').children.length).toBeGreaterThan(0);
    });
  });

  it('highlights the drop zone while dragging over it', async () => {
    await start();
    const drop = $('drop');
    const over = new win.Event('dragover', { cancelable: true });
    drop.dispatchEvent(over as unknown as Event);
    expect(over.defaultPrevented).toBe(true);
    expect(drop.classList.contains('over')).toBe(true);
    drop.dispatchEvent(new win.Event('dragleave') as unknown as Event);
    expect(drop.classList.contains('over')).toBe(false);
  });

  it('analyses the first image of a drop and ignores non-images', async () => {
    await start();
    const drop = $('drop');
    const dropWith = (files: Partial<File>[]) => {
      const event = new win.Event('drop', { cancelable: true });
      Object.defineProperty(event, 'dataTransfer', { value: { files } });
      drop.dispatchEvent(event as unknown as Event);
      return event;
    };
    drop.classList.add('over');
    const event = dropWith([{ type: 'text/plain' }]);
    expect(event.defaultPrevented).toBe(true);
    expect(drop.classList.contains('over')).toBe(false);
    await Promise.resolve();
    expect(createImageBitmap).not.toHaveBeenCalled();
    dropWith([{ type: 'text/plain' }, new File(['png'], 'a.png', { type: 'image/png' })]);
    await vi.waitFor(() => {
      expect($('results').children.length).toBeGreaterThan(0);
    });
  });

  it('ignores a file dialog that was closed without a file', async () => {
    await start();
    const input = field('file');
    Object.defineProperty(input, 'files', { value: [], configurable: true });
    input.dispatchEvent(new win.Event('change') as unknown as Event);
    await Promise.resolve();
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
});

describe('handoff from the selection / context menu', () => {
  const entry = { dataUrl: 'data:image/png;base64,cG5n', text: 'Selected words' };

  it('loads the stored crop, fills the preview text and clears the entry', async () => {
    stub.session.set('cap_1', entry);
    await start({ hash: '#cap_1' });
    await vi.waitFor(() => {
      expect($('results').children.length).toBeGreaterThan(0);
    });
    expect(field('pvText').value).toBe('Selected words');
    expect(document.querySelector('.sample')?.textContent).toBe('Selected words');
    // decoded in the page, not fetched: the CSP has connect-src 'self', which refuses a data: URL
    expect(fetch).not.toHaveBeenCalledWith(entry.dataUrl);
    const decoded = vi.mocked(createImageBitmap).mock.calls[0]?.[0] as Blob;
    expect(await decoded.text()).toBe('png');
    expect(decoded.type).toBe('image/png');
    expect(stub.chrome.storage.session.remove).toHaveBeenCalledWith('cap_1');
    expect(stub.session.has('cap_1')).toBe(false);
  });

  it('works without preview text', async () => {
    stub.session.set('cap_2', { dataUrl: entry.dataUrl, text: '' });
    await start({ hash: '#cap_2' });
    await vi.waitFor(() => {
      expect($('results').children.length).toBeGreaterThan(0);
    });
    expect(field('pvText').value).toBe('');
  });

  it('shows a capture error stored by the service worker', async () => {
    stub.session.set('cap_3', { error: 'Selection is outside the visible area' });
    await start({ hash: '#cap_3' });
    await vi.waitFor(() => {
      expect(status().textContent).toBe(
        'Capture failed: Selection is outside the visible area — try again or paste a screenshot.',
      );
    });
    expect(status().className).toBe('status err');
    expect(stub.session.has('cap_3')).toBe(false);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('shows an error carried in the URL when session storage could not be used', async () => {
    await start({ hash: `#${errorResultHash('QUOTA exceeded')}` });
    await vi.waitFor(() => {
      expect(status().textContent).toBe(
        'Capture failed: QUOTA exceeded — try again or paste a screenshot.',
      );
    });
    expect(stub.chrome.storage.session.get).not.toHaveBeenCalled();
  });

  it('stays in upload mode when the entry is gone or there is no handoff at all', async () => {
    await start({ hash: '#cap_missing' });
    await vi.waitFor(() => {
      expect(status().textContent).toMatch(/^Ready/);
    });
    await Promise.resolve();
    expect(stub.chrome.storage.session.remove).not.toHaveBeenCalled();
    expect(createImageBitmap).not.toHaveBeenCalled();
    await win.happyDOM.close();
    await start();
    await vi.waitFor(() => {
      expect(status().textContent).toMatch(/^Ready/);
    });
    expect(stub.chrome.storage.session.get).toHaveBeenCalledTimes(1);
  });

  it('ignores a malformed entry', async () => {
    stub.session.set('cap_4', { text: 'no image' });
    await start({ hash: '#cap_4' });
    await vi.waitFor(() => {
      expect(stub.chrome.storage.session.remove).toHaveBeenCalledWith('cap_4');
    });
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('does not touch session storage when the model failed to load', async () => {
    modelMock.loadModel.mockRejectedValue(new Error('nope'));
    stub.session.set('cap_5', entry);
    await start({ hash: '#cap_5' });
    await vi.waitFor(() => {
      expect(status().className).toBe('status err');
    });
    expect(stub.session.has('cap_5')).toBe(true);
  });
});
