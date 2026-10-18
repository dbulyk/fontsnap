// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSelection, textInRect } from '../../src/select/overlay';
import { createChromeStub } from './helpers/chrome-stub';

let stub: ReturnType<typeof createChromeStub>;

beforeEach(() => {
  stub = createChromeStub();
  stub.install();
  stub.chrome.runtime.sendMessage.mockResolvedValue({ ok: true, data: { opened: true } });
  vi.useFakeTimers();
  // Both animation frames run at once; the 30 ms wait is advanced by the fake timers.
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.set(window, '__fontsnapActive', false);
  document.documentElement.innerHTML = '<head></head><body></body>';
});

const overlay = () =>
  document.documentElement.querySelector<HTMLElement>('div[style*="crosshair"]');
const mouse = (type: string, x: number, y: number) =>
  new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });

function drag(from: [number, number], to: [number, number]): void {
  const ov = overlay();
  ov?.dispatchEvent(mouse('mousedown', ...from));
  ov?.dispatchEvent(mouse('mousemove', ...to));
  ov?.dispatchEvent(mouse('mouseup', ...to));
}

describe('startSelection', () => {
  it('draws a full-screen crosshair overlay above the page with the localized hint', () => {
    startSelection(window);
    const ov = overlay();
    expect(ov).not.toBeNull();
    expect(ov?.style.position).toBe('fixed');
    expect(ov?.style.zIndex).toBe('2147483647');
    expect(ov?.style.cursor).toBe('crosshair');
    expect(ov?.textContent).toBe(stub.chrome.i18n.getMessage('selectHint'));
    expect(ov?.textContent).not.toBe('');
  });

  it('is idempotent: a second injection does not add a second overlay', () => {
    startSelection(window);
    startSelection(window);
    expect(document.documentElement.querySelectorAll('div[style*="crosshair"]')).toHaveLength(1);
  });

  it('Escape cancels the selection, removes the overlay and allows a new one', () => {
    startSelection(window);
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(overlay()).toBeNull();
    startSelection(window);
    expect(overlay()).not.toBeNull();
    // the Escape listener of the first overlay is gone
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(overlay()).not.toBeNull();
  });

  it('ignores other keys', () => {
    startSelection(window);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(overlay()).not.toBeNull();
  });

  it('draws the selection box while dragging, from any corner', () => {
    startSelection(window);
    const ov = overlay();
    const box = ov?.firstElementChild as HTMLElement;
    expect(box.style.display).toBe('none');
    ov?.dispatchEvent(mouse('mousedown', 100, 80));
    expect(box.style.display).toBe('block');
    ov?.dispatchEvent(mouse('mousemove', 40, 30));
    expect([box.style.left, box.style.top, box.style.width, box.style.height]).toEqual([
      '40px',
      '30px',
      '60px',
      '50px',
    ]);
  });

  it('does nothing on mouse movement before a drag has started', () => {
    startSelection(window);
    overlay()?.dispatchEvent(mouse('mousemove', 10, 10));
    overlay()?.dispatchEvent(mouse('mouseup', 10, 10));
    vi.advanceTimersByTime(100);
    expect(stub.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('sends the viewport rectangle, device pixel ratio and the selected text after the overlay is gone', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '  selected words  ',
    } as unknown as Selection);
    window.devicePixelRatio = 2;
    startSelection(window);
    drag([200, 100], [50, 60]);
    expect(overlay()).toBeNull();
    // not before the extra 30 ms that keep the overlay out of the screenshot
    expect(stub.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({
      type: 'fontsnap-rect',
      rect: { x: 50, y: 60, w: 150, h: 40 },
      dpr: 2,
      text: 'selected words',
    });
  });

  it('falls back to a device pixel ratio of 1', () => {
    window.devicePixelRatio = 0;
    startSelection(window);
    drag([10, 10], [60, 60]);
    vi.advanceTimersByTime(30);
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ dpr: 1 }),
    );
  });

  it('caps the selected text at 80 characters', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'y'.repeat(300),
    } as unknown as Selection);
    startSelection(window);
    drag([10, 10], [60, 60]);
    vi.advanceTimersByTime(30);
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'y'.repeat(80) }),
    );
  });

  it('uses the text of the page under the rectangle when nothing is selected', () => {
    document.body.innerHTML = '<p id="a">Hello   world</p>';
    const text = document.getElementById('a')?.firstChild as Text;
    const realRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = realRange();
      range.getBoundingClientRect = () =>
        ({ left: 20, right: 120, top: 20, bottom: 40 }) as DOMRect;
      return range;
    });
    vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => '',
    } as unknown as Selection);
    startSelection(window);
    drag([10, 10], [200, 100]);
    vi.advanceTimersByTime(30);
    expect(text.nodeValue).toBe('Hello   world');
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello world' }),
    );
  });

  it.each([
    [
      [10, 10],
      [14, 100],
    ],
    [
      [10, 10],
      [100, 14],
    ],
    [
      [10, 10],
      [10, 10],
    ],
  ] as [[number, number], [number, number]][])(
    'ignores a selection smaller than 8 px (%j → %j) but still removes the overlay',
    (from, to) => {
      startSelection(window);
      drag(from, to);
      vi.advanceTimersByTime(100);
      expect(overlay()).toBeNull();
      expect(stub.chrome.runtime.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('survives a selection API that throws and a service worker that does not answer', async () => {
    vi.spyOn(window, 'getSelection').mockImplementation(() => {
      throw new Error('no selection');
    });
    stub.chrome.runtime.sendMessage.mockRejectedValue(new Error('Receiving end does not exist'));
    startSelection(window);
    drag([10, 10], [60, 60]);
    vi.advanceTimersByTime(30);
    await vi.runAllTimersAsync();
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('can be started again after a finished selection', () => {
    startSelection(window);
    drag([10, 10], [60, 60]);
    startSelection(window);
    expect(overlay()).not.toBeNull();
  });
});

describe('textInRect', () => {
  const rectOf = (box: Partial<DOMRect>) => () =>
    ({ left: 0, right: 0, top: 0, bottom: 0, ...box }) as DOMRect;
  function withBoxes(html: string, boxes: Partial<DOMRect>[]): void {
    document.body.innerHTML = html;
    const realRange = document.createRange.bind(document);
    let i = 0;
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = realRange();
      range.getBoundingClientRect = () => rectOf(boxes[i++] ?? {})();
      return range;
    });
  }

  it('joins the text nodes that intersect the rectangle, collapsing whitespace', () => {
    withBoxes('<p>one   two</p><p>far away</p><p>three</p>', [
      { left: 10, right: 50, top: 10, bottom: 20 },
      { left: 900, right: 990, top: 10, bottom: 20 },
      { left: 10, right: 50, top: 30, bottom: 40 },
    ]);
    expect(textInRect(document, { x: 0, y: 0, w: 100, h: 100 })).toBe('one two three');
  });

  it('skips blank text nodes and stops after 80 characters', () => {
    withBoxes(`<p>${'a'.repeat(60)}</p><p>${'b'.repeat(60)}</p><p>${'c'.repeat(60)}</p>`, [
      { right: 10, bottom: 10 },
      { right: 10, bottom: 10 },
      { right: 10, bottom: 10 },
    ]);
    const text = textInRect(document, { x: 0, y: 0, w: 100, h: 100 });
    expect(text).toHaveLength(80);
    expect(text.startsWith('a'.repeat(60) + ' b')).toBe(true);
    expect(textInRect(document, { x: 5000, y: 5000, w: 1, h: 1 })).toBe('');
  });

  it('walks the root element when the document has no <body> (an SVG or XML page)', () => {
    document.body.remove();
    document.documentElement.append(document.createTextNode('plain root text'));
    const realRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = realRange();
      range.getBoundingClientRect = () => ({ left: 0, right: 10, top: 0, bottom: 10 }) as DOMRect;
      return range;
    });
    expect(document.body).toBeNull();
    expect(textInRect(document, { x: 0, y: 0, w: 100, h: 100 })).toBe('plain root text');
  });

  it('answers an empty string when the document cannot be walked', () => {
    document.body.innerHTML = '<p>text</p>';
    const realRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = realRange();
      range.getBoundingClientRect = () => {
        throw new Error('no layout');
      };
      return range;
    });
    expect(textInRect(document, { x: 0, y: 0, w: 10, h: 10 })).toBe('');
  });
});
