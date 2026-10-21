import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBackground } from '../../src/background/handlers';
import { MAX_DATA_URL_CHARS } from '../../src/shared/capture';
import { MENU_IMAGE } from '../../src/shared/constants';
import {
  CONTENT_SCRIPT_SENDER,
  createChromeStub,
  EXTENSION_PAGE_SENDER,
  type InstalledReason,
} from './helpers/chrome-stub';
import { installImageApis, type ImageApiOptions } from './helpers/image-apis';

const tab = {
  id: 5,
  index: 2,
  windowId: 9,
  url: 'https://page.example/article',
} as chrome.tabs.Tab;
const RESULT = 'chrome-extension://test-extension-id/result/result.html';
const WELCOME = 'chrome-extension://test-extension-id/welcome/welcome.html';
const rectMessage = {
  type: 'fontsnap-rect',
  rect: { x: 10, y: 20, w: 100, h: 40 },
  dpr: 2,
  text: 'Hello',
};

let stub: ReturnType<typeof createChromeStub>;
let images: ReturnType<typeof installImageApis>;

function setup(options: ImageApiOptions = {}) {
  stub = createChromeStub();
  stub.install();
  images = installImageApis(options);
  registerBackground();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The tab the worker opened last, and the capture entry stored for it. */
async function openedResult() {
  await vi.waitFor(() => {
    expect(stub.chrome.tabs.create).toHaveBeenCalled();
  });
  const call = stub.chrome.tabs.create.mock.calls.at(-1)?.[0];
  const hash = call?.url?.split('#')[1] ?? '';
  return { call, hash, entry: stub.session.get(hash) as Record<string, unknown> | undefined };
}

describe('registration', () => {
  beforeEach(() => {
    setup();
  });

  it('registers every listener synchronously at load so Chrome can wake the worker', () => {
    expect(stub.listeners()).toEqual({
      installed: 1,
      actionClicked: 1,
      menuClicked: 1,
      message: 1,
    });
  });
});

describe('onInstalled: context menus and welcome page', () => {
  beforeEach(() => {
    setup();
  });

  it('recreates both context menus (an image menu and a region menu)', async () => {
    await stub.fireInstalled('update');
    expect(stub.chrome.contextMenus.removeAll).toHaveBeenCalledTimes(1);
    expect(stub.chrome.contextMenus.create.mock.calls.map(([item]) => item)).toEqual([
      {
        id: MENU_IMAGE,
        title: stub.chrome.i18n.getMessage('ctxImage'),
        contexts: ['image'],
      },
      {
        id: 'fontsnap-select',
        title: stub.chrome.i18n.getMessage('ctxSelect'),
        contexts: ['page', 'selection', 'link'],
      },
    ]);
    expect(stub.chrome.i18n.getMessage('ctxImage')).not.toBe('');
  });

  it('keeps the region menu off images (the image menu owns them)', async () => {
    await stub.fireInstalled('install');
    const select = stub.chrome.contextMenus.create.mock.calls
      .map(([item]) => item)
      .find((item) => item.id === 'fontsnap-select');
    expect(select?.contexts).not.toContain('image');
  });

  it.each([
    [false, '0'],
    [true, '1'],
  ])('opens the welcome page on install with pinned=%s → ?pinned=%s', async (isOnToolbar, flag) => {
    stub.chrome.action.getUserSettings.mockResolvedValueOnce({ isOnToolbar });
    await stub.fireInstalled('install');
    await vi.waitFor(() => {
      expect(stub.chrome.tabs.create).toHaveBeenCalledWith({ url: `${WELCOME}?pinned=${flag}` });
    });
    expect(stub.chrome.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to the pin instructions when getUserSettings fails (Chrome < 91)', async () => {
    stub.chrome.action.getUserSettings.mockRejectedValueOnce(new Error('not a function'));
    await stub.fireInstalled('install');
    await vi.waitFor(() => {
      expect(stub.chrome.tabs.create).toHaveBeenCalledWith({ url: `${WELCOME}?pinned=0` });
    });
  });

  it.each(['update', 'chrome_update', 'shared_module_update'] satisfies InstalledReason[])(
    'does not open the welcome page on %s',
    async (reason) => {
      await stub.fireInstalled(reason);
      await Promise.resolve();
      expect(stub.chrome.action.getUserSettings).not.toHaveBeenCalled();
      expect(stub.chrome.tabs.create).not.toHaveBeenCalled();
    },
  );
});

describe('toolbar icon and region menu: start selection', () => {
  beforeEach(() => {
    setup();
  });

  it('injects the selection overlay into the clicked tab', async () => {
    await stub.fireActionClicked(tab);
    expect(stub.chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 5 },
      files: ['select.js'],
    });
    expect(stub.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('does the same from the "region" context menu', async () => {
    await stub.fireMenuClicked({ menuItemId: 'fontsnap-select' }, tab);
    expect(stub.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it.each([
    'chrome://extensions/',
    'edge://settings',
    'about:blank',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://example.com/',
    'chrome-extension://abc/page.html',
    'chrome-search://local-ntp/local-ntp.html',
    'https://chromewebstore.google.com/detail/x',
    'https://chrome.google.com/webstore/detail/x',
  ])('opens the upload-mode result page instead on %s', async (url) => {
    await stub.fireActionClicked({ ...tab, url });
    expect(stub.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(stub.chrome.tabs.create).toHaveBeenCalledWith({ url: RESULT });
  });

  it('treats ordinary look-alike addresses as ordinary pages', async () => {
    await stub.fireActionClicked({ ...tab, url: 'https://example.com/chrome://x' });
    expect(stub.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('opens upload mode when there is no tab id', async () => {
    await stub.fireActionClicked({ url: 'https://page.example/' } as chrome.tabs.Tab);
    await stub.fireActionClicked(undefined);
    expect(stub.chrome.tabs.create).toHaveBeenCalledTimes(2);
    expect(stub.chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('falls back to upload mode when injection fails (file:// without access, PDF viewer)', async () => {
    stub.chrome.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access'));
    await stub.fireActionClicked(tab);
    await vi.waitFor(() => {
      expect(stub.chrome.tabs.create).toHaveBeenCalledWith({ url: RESULT });
    });
  });

  it('ignores an unknown context menu item and an image item without a source URL', async () => {
    await stub.fireMenuClicked({ menuItemId: 'other' }, tab);
    await stub.fireMenuClicked({ menuItemId: MENU_IMAGE }, tab);
    expect(stub.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(stub.chrome.tabs.create).not.toHaveBeenCalled();
  });
});

describe('selection message: screenshot → crop → session → result tab', () => {
  it('crops the selection in device pixels and hands a PNG to the result page', async () => {
    setup();
    expect(await stub.dispatch(rectMessage)).toEqual({ ok: true, data: { opened: true } });
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(9, { format: 'png' });
    // rect {10,20,100,40} at dpr 2 → source x20 y40 w200 h80, drawn 1:1 into a 200x80 canvas
    expect(images.draws).toEqual([[20, 40, 200, 80, 0, 0, 200, 80]]);
    expect(images.canvases.map(({ width, height }) => [width, height])).toEqual([[200, 80]]);
    expect(images.bitmaps.every((b) => b.close.mock.calls.length === 1)).toBe(true);
    const { call, hash, entry } = await openedResult();
    expect(hash).toMatch(/^cap_[0-9a-f-]{36}$/);
    expect(call).toEqual({ url: `${RESULT}#${hash}`, index: 3 });
    expect(entry?.['text']).toBe('Hello');
    expect(entry?.['dataUrl']).toMatch(/^data:image\/png;base64,/);
  });

  it('downscales a crop whose long side is above 2400 px', async () => {
    setup({ bitmap: { width: 6000, height: 3000 } });
    await stub.dispatch({ ...rectMessage, rect: { x: 0, y: 0, w: 4800, h: 2400 }, dpr: 1 });
    expect(images.canvases.map(({ width, height }) => [width, height])).toEqual([[2400, 1200]]);
    expect(images.draws).toEqual([[0, 0, 4800, 2400, 0, 0, 2400, 1200]]);
  });

  it('uses 1 for an invalid device pixel ratio', async () => {
    setup();
    await stub.dispatch({ ...rectMessage, dpr: 'two' });
    await stub.dispatch({ ...rectMessage, dpr: -3 });
    expect(images.draws).toEqual([
      [10, 20, 100, 40, 0, 0, 100, 40],
      [10, 20, 100, 40, 0, 0, 100, 40],
    ]);
  });

  it('drops preview text longer than 100 graphemes and keeps 100', async () => {
    setup();
    await stub.dispatch({ ...rectMessage, text: 'x'.repeat(100) });
    expect((await openedResult()).entry?.['text']).toBe('x'.repeat(100));
    await stub.dispatch({ ...rectMessage, text: 'x'.repeat(101) });
    expect((await openedResult()).entry?.['text']).toBe('');
    await stub.dispatch({ ...rectMessage, text: '👍'.repeat(100) });
    expect((await openedResult()).entry?.['text']).toBe('👍'.repeat(100));
    await stub.dispatch({ ...rectMessage, text: '👍'.repeat(101) });
    expect((await openedResult()).entry?.['text']).toBe('');
  });

  it('re-encodes a crop that is too big for session storage as JPEG, walking the quality ladder', async () => {
    setup({
      encode: (type, quality) =>
        type === 'image/png' ? MAX_DATA_URL_CHARS : quality === 0.92 ? MAX_DATA_URL_CHARS : 100,
    });
    await stub.dispatch(rectMessage);
    expect(images.encodes).toEqual([
      { type: 'image/png', quality: undefined },
      { type: 'image/jpeg', quality: 0.92 },
      { type: 'image/jpeg', quality: 0.85 },
    ]);
    const { entry } = await openedResult();
    expect(entry?.['dataUrl']).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('shows the error in the result tab when even the smallest JPEG is too big', async () => {
    setup({ encode: () => MAX_DATA_URL_CHARS });
    expect(await stub.dispatch(rectMessage)).toEqual({ ok: true, data: { opened: true } });
    const { entry } = await openedResult();
    expect(entry).toEqual({ error: 'Image too large for temporary storage' });
  });

  it('shows the capture error in the result tab', async () => {
    setup();
    stub.chrome.tabs.captureVisibleTab.mockRejectedValueOnce(new Error('Cannot capture'));
    await stub.dispatch(rectMessage);
    expect((await openedResult()).entry).toEqual({ error: 'Cannot capture' });
  });

  it('explains a selection outside the visible area', async () => {
    setup();
    await stub.dispatch({ ...rectMessage, rect: { x: 900, y: 900, w: 50, h: 50 }, dpr: 1 });
    expect((await openedResult()).entry).toEqual({
      error: 'Selection is outside the visible area',
    });
  });

  it('keeps the worker alive until the result tab is open (the response comes last)', async () => {
    setup();
    let release: (url: string) => void = () => undefined;
    stub.chrome.tabs.captureVisibleTab.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const response = vi.fn();
    void stub.dispatch(rectMessage).then(response);
    await Promise.resolve();
    expect(response).not.toHaveBeenCalled();
    expect(stub.chrome.tabs.create).not.toHaveBeenCalled();
    release('data:image/png;base64,c2hvdA==');
    await vi.waitFor(() => {
      expect(response).toHaveBeenCalledWith({ ok: true, data: { opened: true } });
    });
    expect(stub.chrome.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('gives every capture its own UUID key', async () => {
    setup();
    await stub.dispatch(rectMessage);
    await stub.dispatch(rectMessage);
    expect([...stub.session.keys()]).toHaveLength(2);
    const [a, b] = [...stub.session.keys()];
    expect(a).toMatch(/^cap_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it.each([
    ['an extension page', EXTENSION_PAGE_SENDER],
    ['another extension', { ...CONTENT_SCRIPT_SENDER, id: 'other' }],
    [
      'a sender without a tab',
      { id: 'test-extension-id', url: 'https://page.example/', frameId: 0 },
    ],
  ])('ignores a selection from %s: no screenshot, no tab', async (_who, sender) => {
    setup();
    expect(await stub.dispatch(rectMessage, sender)).toBeUndefined();
    expect(stub.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(stub.chrome.tabs.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid rectangle without taking a screenshot', async () => {
    setup();
    expect(
      await stub.dispatch({ ...rectMessage, rect: { x: 0, y: 0, w: -1, h: 5 } }),
    ).toMatchObject({
      ok: false,
    });
    expect(stub.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });
});

describe('storage failures never leave the user without a result tab', () => {
  it('stores a tiny error entry when the capture does not fit', async () => {
    setup();
    stub.chrome.tabs.captureVisibleTab.mockResolvedValueOnce('data:image/png;base64,c2hvdA==');
    stub.chrome.storage.session.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    await stub.dispatch(rectMessage);
    const { hash, entry } = await openedResult();
    expect(hash).toMatch(/^cap_/);
    expect(entry).toEqual({ error: 'QUOTA_BYTES quota exceeded' });
  });

  it('puts the error into the URL when storage is unusable altogether', async () => {
    setup();
    stub.chrome.storage.session.set.mockRejectedValue(new Error('storage is down'));
    await stub.dispatch(rectMessage);
    const { call } = await openedResult();
    expect(call?.url).toBe(`${RESULT}#err=${encodeURIComponent('storage is down')}`);
    expect(stub.session.size).toBe(0);
  });
});

// the screenshots of clicked.ts are kept a second apart and the helper remembers the last one, so each test starts on a fake clock an
// hour after the one before (vi.waitFor moves a fake clock on)
let clock = Date.now();

describe('right-click on an image', () => {
  beforeEach(() => {
    clock += 3_600_000;
    vi.useFakeTimers({ now: clock });
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const dataUrl = (type: string, bytes: Uint8Array) =>
    `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
  const png = () => dataUrl('image/png', new Uint8Array(1000).fill(7));
  const click = (srcUrl = 'https://cdn.example/photo.png') =>
    stub.fireMenuClicked({ menuItemId: MENU_IMAGE, srcUrl }, tab);
  const measured = (w = 100, h = 50) => ({
    result: {
      rect: { x: 30, y: 40, w, h },
      dpr: 2,
      saved: [],
      box: { x: 0, y: 0, w: 400, h: 300 },
      outer: { x: 0, y: 0, w: 400, h: 300 },
    },
  });
  const PIXELS = 'UElYRUxT';

  it('decodes a data: URL image itself and hands it over: no request, no screenshot', async () => {
    setup();
    const src = png();
    await click(src);
    const { call, entry } = await openedResult();
    expect(images.fetch).not.toHaveBeenCalled();
    expect(entry?.['dataUrl']).toBe(src);
    expect(entry?.['text']).toBe('');
    expect(call?.index).toBe(3);
    expect(stub.chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(stub.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it('reads an image of another origin where the click happened: no download, no screenshot', async () => {
    setup();
    stub.chrome.scripting.executeScript.mockResolvedValueOnce([{ result: PIXELS }]);
    await stub.fireMenuClicked(
      { menuItemId: MENU_IMAGE, srcUrl: 'https://cdn.example/photo.png', frameId: 7 },
      tab,
    );
    const { entry } = await openedResult();
    // not a request of the worker: the CSP refuses it, so none is tried
    expect(images.fetch).not.toHaveBeenCalled();
    expect(stub.chrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 5, frameIds: [7] },
        args: ['https://cdn.example/photo.png'],
      }),
    );
    expect(stub.chrome.tabs.captureVisibleTab).not.toHaveBeenCalled();
    expect(entry?.['dataUrl']).toMatch(/^data:image\/png;base64,/);
    expect(entry?.['text']).toBe('');
    expect(entry?.['note']).toBeUndefined();
  });

  it('crops a screenshot when the page cannot hand the pixels over', async () => {
    setup();
    stub.chrome.scripting.executeScript
      .mockResolvedValueOnce([{ result: null }])
      .mockResolvedValueOnce([measured()])
      .mockResolvedValue([{ result: true }]);
    await click('https://cdn.example/photo.png');
    const { entry } = await openedResult();
    expect(stub.chrome.tabs.captureVisibleTab).toHaveBeenCalledWith(9, { format: 'png' });
    expect(images.draws).toEqual([[60, 80, 200, 100, 0, 0, 200, 100]]);
    expect(entry?.['note']).toBeUndefined();
  });

  it('hands over the whole visible area with a hint when the image cannot be isolated', async () => {
    setup();
    stub.chrome.scripting.executeScript.mockResolvedValue([{ result: null }]);
    await click();
    const { entry } = await openedResult();
    expect(entry?.['dataUrl']).toMatch(/^data:image\/png;base64,/);
    expect(entry?.['text']).toBe('');
    expect(entry?.['note']).toBe('whole-view');
  });

  it('shows the error of the screenshot when even the whole view cannot be taken', async () => {
    setup();
    stub.chrome.scripting.executeScript.mockRejectedValue(new Error('Cannot access contents'));
    stub.chrome.tabs.captureVisibleTab.mockRejectedValue(new Error('The tab is not active'));
    await click();
    expect((await openedResult()).entry).toEqual({ error: 'The tab is not active' });
  });

  it('goes on to the page when a data: URL is not a picture it can use (the ladder itself: clicked.test.ts)', async () => {
    setup();
    stub.chrome.scripting.executeScript.mockResolvedValueOnce([{ result: PIXELS }]);
    await click(dataUrl('image/svg+xml', new TextEncoder().encode('<svg/>')));
    const { entry } = await openedResult();
    expect(images.fetch).not.toHaveBeenCalled();
    expect(stub.chrome.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(entry?.['dataUrl']).toMatch(/^data:image\/png;base64,/);
  });
});
