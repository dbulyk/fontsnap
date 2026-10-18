import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isAllowedSender,
  MessagingError,
  onMessage,
  sendMessage,
  sendTabMessage,
} from '../../src/shared/messaging';
import {
  CONTENT_SCRIPT_SENDER,
  createChromeStub,
  EXTENSION_BARE_ORIGIN,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  EXTENSION_PAGE_SENDER,
} from './helpers/chrome-stub';
import { PROTOTYPE_NAMES } from './helpers/media';

const rect = { type: 'fontsnap-rect', rect: { x: 1, y: 2, w: 30, h: 40 }, dpr: 2, text: 'Hi' };
const opened = { opened: true } as const;
const contentScript = CONTENT_SCRIPT_SENDER;
let stub: ReturnType<typeof createChromeStub>;

beforeEach(() => {
  stub = createChromeStub();
  stub.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('onMessage', () => {
  it('answers with the handler result', async () => {
    onMessage({ 'fontsnap-rect': () => opened });
    expect(await stub.dispatch(rect)).toEqual({ ok: true, data: opened });
  });

  it('supports async handlers', async () => {
    onMessage({ 'fontsnap-rect': () => Promise.resolve(opened) });
    expect(await stub.dispatch(rect)).toEqual({ ok: true, data: opened });
  });

  it('keeps the message channel open until an async handler is done (the worker stays alive)', async () => {
    let release: () => void = () => undefined;
    onMessage({
      'fontsnap-rect': () =>
        new Promise<typeof opened>((resolve) => {
          release = () => {
            resolve(opened);
          };
        }),
    });
    const listener = stub.chrome.runtime.onMessage.addListener.mock.calls[0]?.[0];
    const sendResponse = vi.fn();
    expect(listener?.(rect, contentScript, sendResponse)).toBe(true);
    await Promise.resolve();
    expect(sendResponse).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: opened });
    });
  });

  it('turns a throwing handler into an error response', async () => {
    onMessage({
      'fontsnap-rect': () => {
        throw new Error('boom');
      },
    });
    expect(await stub.dispatch(rect)).toEqual({ ok: false, error: 'boom' });
  });

  it('turns a rejecting handler into an error response', async () => {
    onMessage({ 'fontsnap-rect': () => Promise.reject(new Error('later')) });
    expect(await stub.dispatch(rect)).toEqual({ ok: false, error: 'later' });
  });

  it.each([null, undefined, 'fontsnap-rect', 7, {}, { type: 'unknown' }])(
    'ignores foreign message %j without throwing',
    async (message) => {
      onMessage({ 'fontsnap-rect': () => opened });
      expect(await stub.dispatch(message)).toBeUndefined();
    },
  );

  it('rejects a malformed payload of a handled type', async () => {
    const handler = vi.fn(() => opened);
    onMessage({ 'fontsnap-rect': handler });
    const response = await stub.dispatch({
      type: 'fontsnap-rect',
      rect: { x: 0, y: 0, w: 0, h: 0 },
    });
    expect(response).toMatchObject({ ok: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes the parsed request and the sender to the handler', async () => {
    const handler = vi.fn(() => opened);
    onMessage({ 'fontsnap-rect': handler });
    await stub.dispatch({ ...rect, extra: 'dropped' }, contentScript);
    expect(handler).toHaveBeenCalledWith(rect, contentScript);
  });

  it('returns an unsubscribe function', () => {
    const off = onMessage({ 'fontsnap-rect': () => opened });
    expect(stub.listenerCount()).toBe(1);
    off();
    expect(stub.listenerCount()).toBe(0);
  });

  it('ignores a type it has no handler for so another context can answer', async () => {
    onMessage({});
    expect(await stub.dispatch(rect)).toBeUndefined();
  });
});

describe('sendMessage', () => {
  it('resolves with the data of a successful response', async () => {
    onMessage({ 'fontsnap-rect': () => opened });
    await expect(
      sendMessage({ type: 'fontsnap-rect', rect: rect.rect, dpr: 2, text: 'Hi' }),
    ).resolves.toEqual(opened);
  });

  it('rejects with MessagingError on an error response', async () => {
    onMessage({
      'fontsnap-rect': () => {
        throw new Error('nope');
      },
    });
    await expect(
      sendMessage({ type: 'fontsnap-rect', rect: rect.rect, dpr: 2, text: 'Hi' }),
    ).rejects.toThrow(new MessagingError('nope'));
  });

  it('rejects on a malformed response', async () => {
    stub.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: true, data: { opened: 'x' } });
    await expect(
      sendMessage({ type: 'fontsnap-rect', rect: rect.rect, dpr: 2, text: 'Hi' }),
    ).rejects.toBeInstanceOf(MessagingError);
  });

  it('rejects when nobody answers', async () => {
    await expect(
      sendMessage({ type: 'fontsnap-rect', rect: rect.rect, dpr: 2, text: 'Hi' }),
    ).rejects.toBeInstanceOf(MessagingError);
  });

  it('wraps transport errors', async () => {
    stub.chrome.runtime.sendMessage.mockRejectedValueOnce(
      new Error('Could not establish connection'),
    );
    await expect(
      sendMessage({ type: 'fontsnap-rect', rect: rect.rect, dpr: 2, text: 'Hi' }),
    ).rejects.toThrow(/Could not establish connection/);
  });
});

describe('sendTabMessage', () => {
  it('targets the given tab', async () => {
    onMessage({ 'fontsnap-rect': () => opened });
    await expect(
      sendTabMessage(42, { type: 'fontsnap-rect', rect: rect.rect, dpr: 2, text: 'Hi' }),
    ).resolves.toEqual(opened);
    expect(stub.chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
      type: 'fontsnap-rect',
      rect: rect.rect,
      dpr: 2,
      text: 'Hi',
    });
  });
});

describe('onMessage and inherited names', () => {
  it.each(PROTOTYPE_NAMES)(
    'ignores a message of type %s without calling a handler or answering',
    async (name) => {
      const handler = vi.fn(() => opened);
      onMessage({ 'fontsnap-rect': handler });
      const message = JSON.parse(`{"type":"${name}"}`) as unknown;
      await expect(stub.dispatch(message, contentScript)).resolves.toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    },
  );
});

describe('sender policy', () => {
  it('lets the selection overlay (a content script in the top frame) send the rectangle', async () => {
    onMessage({ 'fontsnap-rect': () => opened });
    expect(await stub.dispatch(rect, contentScript)).toEqual({ ok: true, data: opened });
  });

  it.each([
    ['another extension', { ...contentScript, id: 'another-extension-id' }],
    [
      'a sender without an id',
      { url: 'https://page.example/', tab: { id: 5 } as chrome.tabs.Tab, frameId: 0 },
    ],
    ['an extension page (the result page never sends a selection)', EXTENSION_PAGE_SENDER],
    ['a content script in a sub-frame', { ...contentScript, frameId: 4 }],
    ['a sender without a tab', { id: EXTENSION_ID, url: 'https://page.example/', frameId: 0 }],
    [
      'a web page claiming our origin',
      { ...contentScript, url: `${EXTENSION_ORIGIN}result/result.html` },
    ],
    [
      'a look-alike origin',
      { id: EXTENSION_ID, url: 'chrome-extension://test-extension-idevil/x.html' },
    ],
  ])(
    'ignores fontsnap-rect from %s without calling the handler or answering',
    async (_who, sender) => {
      const handler = vi.fn(() => opened);
      onMessage({ 'fontsnap-rect': handler });
      expect(await stub.dispatch(rect, sender)).toBeUndefined();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('checks the sender before validating the payload', async () => {
    onMessage({ 'fontsnap-rect': () => opened });
    // A malformed payload from a foreign sender gets no error response either.
    expect(
      await stub.dispatch({ type: 'fontsnap-rect', rect: 'x' }, EXTENSION_PAGE_SENDER),
    ).toBeUndefined();
  });
});

describe('isAllowedSender', () => {
  const extensionPage = EXTENSION_PAGE_SENDER;

  it('maps each sender kind to who may use it', () => {
    expect(isAllowedSender(['extension-page'], extensionPage)).toBe(true);
    expect(isAllowedSender(['extension-page'], contentScript)).toBe(false);
    expect(isAllowedSender(['content-script'], contentScript)).toBe(true);
    expect(isAllowedSender(['content-script'], extensionPage)).toBe(false);
    expect(isAllowedSender(['extension-page', 'content-script'], contentScript)).toBe(true);
    expect(isAllowedSender(['extension-page', 'content-script'], extensionPage)).toBe(true);
    expect(isAllowedSender([], extensionPage)).toBe(false);
  });

  it('never accepts a foreign id, even from a content script', () => {
    expect(isAllowedSender(['content-script'], { ...contentScript, id: 'other' })).toBe(false);
  });

  it('does not treat an extension page that pretends to have a tab as a content script', () => {
    const pageInTab = {
      ...extensionPage,
      tab: { id: 1 } as chrome.tabs.Tab,
      frameId: 0,
    };
    expect(isAllowedSender(['content-script'], pageInTab)).toBe(false);
  });

  it('compares against the real extension origin, trailing slash included', () => {
    expect(EXTENSION_ORIGIN.endsWith('/')).toBe(true);
  });

  describe('frames', () => {
    const tab = { id: 7 } as chrome.tabs.Tab;

    it('rejects a content script in a frame other than the top frame', () => {
      expect(isAllowedSender(['content-script'], { ...contentScript, frameId: 3 })).toBe(false);
    });

    it('rejects a content script with no frameId (the top frame is never assumed)', () => {
      const unknownFrame = { ...contentScript };
      delete unknownFrame.frameId;
      expect(isAllowedSender(['content-script'], unknownFrame)).toBe(false);
    });

    it('accepts a content script in the top frame', () => {
      expect(isAllowedSender(['content-script'], contentScript)).toBe(true);
    });

    it('rejects an extension page framed inside another tab page, but not one in a top frame', () => {
      expect(
        isAllowedSender(['extension-page'], {
          ...extensionPage,
          tab,
          frameId: 2,
        }),
      ).toBe(false);
      expect(isAllowedSender(['extension-page'], { ...extensionPage, tab })).toBe(false);
      expect(
        isAllowedSender(['extension-page'], {
          ...extensionPage,
          tab,
          frameId: 0,
        }),
      ).toBe(true);
    });

    it('lets a tab-less extension page (the real popup) through whatever its frameId', () => {
      expect(isAllowedSender(['extension-page'], { ...extensionPage, frameId: 0 })).toBe(true);
      expect(isAllowedSender(['extension-page'], { ...extensionPage, frameId: 4 })).toBe(true);
    });
  });

  describe('origin', () => {
    it.each([
      ['a web origin', 'https://evil.example'],
      ['a look-alike extension origin', 'chrome-extension://test-extension-idevil'],
      ['the origin with a trailing slash', `${EXTENSION_BARE_ORIGIN}/`],
      ['an opaque origin', 'null'],
    ])('rejects an extension-page URL that comes with %s', (_name, origin) => {
      expect(isAllowedSender(['extension-page'], { ...extensionPage, origin })).toBe(false);
    });

    it('accepts the matching origin', () => {
      expect(
        isAllowedSender(['extension-page'], {
          ...extensionPage,
          origin: EXTENSION_BARE_ORIGIN,
        }),
      ).toBe(true);
    });

    // Chrome sets sender.origin for every document, so a sender without one is not one of our
    // pages, whatever its URL claims.
    it('rejects an extension page without an origin', () => {
      const withoutOrigin = { ...extensionPage };
      delete withoutOrigin.origin;
      expect(isAllowedSender(['extension-page'], withoutOrigin)).toBe(false);
    });

    it('never takes a sender that claims our origin for a content script', () => {
      const claiming = { ...contentScript, origin: EXTENSION_BARE_ORIGIN };
      expect(isAllowedSender(['content-script'], claiming)).toBe(false);
    });
  });
});
