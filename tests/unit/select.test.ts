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
  Reflect.deleteProperty(document, 'elementsFromPoint');
  document.documentElement.innerHTML = '<head></head><body></body>';
});

const overlay = () =>
  document.documentElement.querySelector<HTMLElement>('div[style*="crosshair"]');
const mouse = (type: string, x: number, y: number) =>
  new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });

/** A selection with the given text whose one line box is `line` (a viewport box). */
function selectionOf(
  text: string,
  line: Partial<DOMRect> = { left: 60, right: 150, top: 70, bottom: 90 },
  collapsed = text === '',
): Selection {
  return {
    isCollapsed: collapsed,
    rangeCount: text === '' ? 0 : 1,
    getRangeAt: () => ({
      getClientRects: () => [{ left: 0, right: 0, top: 0, bottom: 0, ...line }],
    }),
    toString: () => text,
  } as unknown as Selection;
}

/** Computed paint at a point. Omitted fields use the values Chromium returns for a transparent element. */
interface StackPaint {
  opacity?: string;
  backgroundColor?: string;
  backgroundImage?: string;
}

/**
 * Layout for happy-dom, which does not place boxes.
 * `boxes` are the line boxes of each element's text (and the border box of a field with that id).
 * `stack`, top to bottom, is what `elementsFromPoint` returns; the first entry is `elementFromPoint`.
 * `noBox` elements have no CSS box, as `display: contents` does.
 */
function layout(
  boxes: Record<string, Partial<DOMRect>>,
  onTop?: (x: number, y: number) => Element | null,
  options?: {
    stack?: (x: number, y: number) => readonly Element[];
    paint?: (el: Element) => StackPaint;
    noBox?: readonly string[];
  },
): void {
  const realRange = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = realRange();
    range.getClientRects = () => {
      const id = range.startContainer.parentElement?.id ?? '';
      const box = boxes[id];
      return (box
        ? [{ left: 0, right: 0, top: 0, bottom: 0, ...box }]
        : []) as unknown as DOMRectList;
    };
    return range;
  });
  const hitsAt = (x: number, y: number): Element[] => {
    const listed = options?.stack?.(x, y);
    if (listed !== undefined) return [...listed];
    if (onTop !== undefined) {
      const hit = onTop(x, y);
      return hit === null ? [] : [hit];
    }
    const ids = Object.keys(boxes).filter((id) => {
      const b = boxes[id];
      if (b === undefined) return false;
      return x >= (b.left ?? 0) && x <= (b.right ?? 0) && y >= (b.top ?? 0) && y <= (b.bottom ?? 0);
    });
    const hits: Element[] = [];
    for (const id of ids.reverse()) {
      const hit = document.getElementById(id);
      if (hit !== null) hits.push(hit);
    }
    return hits;
  };
  vi.spyOn(document, 'elementFromPoint').mockImplementation((x, y) => hitsAt(x, y)[0] ?? null);
  document.elementsFromPoint = (x, y) => hitsAt(x, y);
  const paintOf = options?.paint;
  if (paintOf !== undefined) {
    const realStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const style = realStyle(el);
      const paint = paintOf(el);
      if (
        paint.opacity === undefined &&
        paint.backgroundColor === undefined &&
        paint.backgroundImage === undefined
      ) {
        return style;
      }
      return {
        opacity: paint.opacity ?? '1',
        backgroundColor: paint.backgroundColor ?? 'rgba(0, 0, 0, 0)',
        backgroundImage: paint.backgroundImage ?? 'none',
        display: style.display,
        visibility: style.visibility,
      } as CSSStyleDeclaration;
    });
  }
  const noBox = new Set(options?.noBox ?? []);
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    if (noBox.has(this.id)) return [] as unknown as DOMRectList;
    const box = boxes[this.id];
    // happy-dom's own getClientRects is one zero rect. Keep that for elements the test did not place.
    return [
      box === undefined
        ? { left: 0, right: 0, top: 0, bottom: 0 }
        : { left: 0, right: 0, top: 0, bottom: 0, ...box },
    ] as unknown as DOMRectList;
  });
}

function el(id: string): Element {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found;
}

function setRange(id: string, start: number, end: number): void {
  const field = el(id);
  if (!(field instanceof HTMLTextAreaElement) && !(field instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not a field`);
  }
  field.selectionStart = start;
  field.selectionEnd = end;
}

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
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf('  selected words  '));
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
    vi.spyOn(window, 'getSelection').mockReturnValue(
      selectionOf('y'.repeat(300), { right: 50, bottom: 50 }),
    );
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
    layout({ a: { left: 20, right: 120, top: 20, bottom: 40 } });
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf(''));
    startSelection(window);
    drag([10, 10], [200, 100]);
    vi.advanceTimersByTime(30);
    expect(text.nodeValue).toBe('Hello   world');
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Hello world' }),
    );
  });

  // The user report: the frame was over «TT Polihaus…», the preview showed «БУКВОПЕЧАТАЮЩЕЙ…» selected elsewhere on the page.
  it('ignores a selection outside the rectangle and takes the visible text under it', () => {
    document.body.innerHTML = '<p id="a">TT Polihaus — экспериментальный гротеск</p>';
    layout({ a: { left: 20, right: 180, top: 220, bottom: 260 } });
    vi.spyOn(window, 'getSelection').mockReturnValue(
      selectionOf('БУКВОПЕЧАТАЮЩЕЙ СВЯЗИ', { left: 20, right: 300, top: 10, bottom: 30 }),
    );
    startSelection(window);
    drag([10, 200], [200, 300]);
    vi.advanceTimersByTime(30);
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'TT Polihaus — экспериментальный гротеск' }),
    );
  });

  it('ignores a collapsed selection (a caret) inside the rectangle', () => {
    document.body.innerHTML = '<p id="a">page text</p>';
    layout({ a: { left: 20, right: 120, top: 20, bottom: 40 } });
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf('caret', undefined, true));
    startSelection(window);
    drag([10, 10], [200, 100]);
    vi.advanceTimersByTime(30);
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'page text' }),
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
  const frame = { x: 0, y: 0, w: 100, h: 100 };

  it('joins the text nodes that intersect the rectangle, collapsing whitespace', () => {
    document.body.innerHTML = '<p id="a">one   two</p><p id="b">far away</p><p id="c">three</p>';
    layout({
      a: { left: 10, right: 50, top: 10, bottom: 20 },
      b: { left: 900, right: 990, top: 10, bottom: 20 },
      c: { left: 10, right: 50, top: 30, bottom: 40 },
    });
    expect(textInRect(document, frame)).toBe('one two three');
  });

  it('skips blank text nodes and stops after 80 characters', () => {
    document.body.innerHTML = `<p id="a">${'a'.repeat(60)}</p> <p id="b">${'b'.repeat(60)}</p><p id="c">${'c'.repeat(60)}</p>`;
    layout({
      a: { right: 10, bottom: 10 },
      b: { top: 20, right: 10, bottom: 30 },
      c: { top: 40, right: 10, bottom: 50 },
    });
    const text = textInRect(document, frame);
    expect(text).toHaveLength(80);
    expect(text.startsWith('a'.repeat(60) + ' b')).toBe(true);
    expect(textInRect(document, { x: 5000, y: 5000, w: 1, h: 1 })).toBe('');
  });

  it.each([
    ['visibility: hidden', '<p id="t" style="visibility:hidden">secret</p>'],
    ['opacity: 0', '<div style="opacity:0"><p id="t">secret</p></div>'],
    ['display: none', '<p id="t" style="display:none">secret</p>'],
    ['a textarea with opacity 0', '<textarea id="t" style="opacity:0">secret</textarea>'],
    ['an <option>', '<select><option id="t">secret</option></select>'],
    ['<noscript>', '<noscript><span id="t">secret</span></noscript>'],
  ])('skips text the user does not see: %s', (_name, html) => {
    document.body.innerHTML = `${html}<p id="v">visible</p>`;
    layout({ t: { right: 50, bottom: 10 }, v: { top: 20, right: 50, bottom: 30 } });
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('skips text covered by another element', () => {
    document.body.innerHTML = '<p id="t">covered</p><div id="cover"></div><p id="v">visible</p>';
    layout({ t: { right: 50, bottom: 10 }, v: { top: 20, right: 50, bottom: 30 } }, undefined, {
      stack: (_x, y) => (y < 15 ? [el('cover'), el('t')] : [el('v')]),
      paint: (hit) => (hit.id === 'cover' ? { backgroundColor: 'rgb(255, 255, 255)' } : {}),
    });
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('takes the words of a phrase and the inline element inside it', () => {
    document.body.innerHTML = '<p id="t">outer <b id="inner">bold</b></p>';
    layout(
      {
        t: { left: 10, right: 40, top: 10, bottom: 24 },
        inner: { left: 40, right: 80, top: 10, bottom: 24 },
      },
      undefined,
      { stack: (x) => (x < 40 ? [el('t')] : [el('inner'), el('t')]) },
    );
    expect(textInRect(document, frame)).toBe('outer bold');
  });

  it('takes text that does not receive pointer events', () => {
    document.body.innerHTML = '<div id="wrap"><p id="t">pointer free</p></div>';
    layout({ t: { left: 10, right: 90, top: 10, bottom: 30 } }, undefined, {
      stack: () => [el('wrap')],
    });
    expect(textInRect(document, frame)).toBe('pointer free');
  });

  it('takes text under a transparent layer', () => {
    document.body.innerHTML = '<p id="t">under clear</p><div id="catcher"></div>';
    layout({ t: { left: 10, right: 90, top: 10, bottom: 30 } }, undefined, {
      stack: () => [el('catcher'), el('t')],
      paint: (hit) => (hit.id === 'catcher' ? { backgroundColor: 'rgba(0, 0, 0, 0)' } : {}),
    });
    expect(textInRect(document, frame)).toBe('under clear');
  });

  it('takes a heading when a transparent link is stretched over it', () => {
    document.body.innerHTML =
      '<div id="card"><h2 id="title">Card title</h2><a id="link" href="#read">Read</a></div>';
    layout(
      {
        title: { left: 10, right: 90, top: 10, bottom: 36 },
        link: { left: 10, right: 50, top: 200, bottom: 220 },
      },
      undefined,
      {
        stack: () => [el('link'), el('title')],
        paint: (hit) => (hit.id === 'link' ? { backgroundColor: 'rgba(0, 0, 0, 0)' } : {}),
      },
    );
    expect(textInRect(document, frame)).toBe('Card title');
  });

  it.each([
    ['an opaque layer', { backgroundColor: 'rgb(255, 255, 255)' }],
    ['a translucent layer', { backgroundColor: 'rgba(255, 255, 255, 0.4)' }],
    [
      'a layer that only paints a background image',
      { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(white, white)' },
    ],
  ])('skips text covered by %s inside its owner', (_name, paint) => {
    document.body.innerHTML =
      '<p id="t">covered words<span id="cover"></span></p><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, right: 80, top: 10, bottom: 28 },
        v: { left: 10, right: 80, top: 40, bottom: 58 },
      },
      undefined,
      {
        stack: (_x, y) => (y < 34 ? [el('cover'), el('t')] : [el('v')]),
        paint: (hit) => (hit.id === 'cover' ? paint : {}),
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('takes text under a layer whose opacity is 0', () => {
    document.body.innerHTML = '<p id="t">under clear</p><div id="cover"></div>';
    layout({ t: { left: 10, right: 90, top: 10, bottom: 30 } }, undefined, {
      stack: () => [el('cover'), el('t')],
      paint: (hit) =>
        hit.id === 'cover' ? { opacity: '0', backgroundColor: 'rgb(255, 255, 255)' } : {},
    });
    expect(textInRect(document, frame)).toBe('under clear');
  });

  it('takes text whose element has no box when a parent box is visible', () => {
    document.body.innerHTML =
      '<p id="p"><span id="t" style="display:contents">shown letters</span></p>';
    layout({ t: { left: 10, right: 80, top: 10, bottom: 30 } }, undefined, {
      noBox: ['t'],
      stack: () => [el('p')],
    });
    expect(textInRect(document, frame)).toBe('shown letters');
  });

  it('takes visible letters marked aria-hidden', () => {
    document.body.innerHTML =
      '<div aria-hidden="true"><span id="t">secret</span></div><p id="v">visible</p>';
    layout({ t: { right: 50, bottom: 10 }, v: { top: 20, right: 50, bottom: 30 } });
    expect(textInRect(document, frame)).toBe('secret visible');
  });

  it('takes the selected part of a textarea that meets the frame', () => {
    document.body.innerHTML = '<textarea id="f">hello world</textarea>';
    setRange('f', 0, 5);
    layout({ f: { left: 70, top: 10, right: 160, bottom: 40 } });
    expect(textInRect(document, frame)).toBe('hello');
  });

  it('takes a textarea value when the whole field sits inside the frame', () => {
    document.body.innerHTML = '<textarea id="f">whole value</textarea>';
    layout({ f: { left: 10, top: 10, right: 80, bottom: 40 } });
    expect(textInRect(document, frame)).toBe('whole value');
  });

  it('skips a textarea that crosses the frame when nothing is selected', () => {
    document.body.innerHTML = '<textarea id="f">partial value</textarea><p id="v">visible</p>';
    layout({
      f: { left: 70, top: 10, right: 160, bottom: 40 },
      v: { left: 10, top: 50, right: 60, bottom: 70 },
    });
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('skips a textarea selection that does not meet the frame', () => {
    document.body.innerHTML = '<textarea id="f">hello world</textarea><p id="v">visible</p>';
    setRange('f', 0, 5);
    layout({
      f: { left: 400, top: 10, right: 480, bottom: 40 },
      v: { left: 10, top: 10, right: 40, bottom: 30 },
    });
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('takes a text field value when the field sits inside the frame', () => {
    document.body.innerHTML = '<input id="f" type="text" value="typed words">';
    layout({ f: { left: 10, top: 10, right: 80, bottom: 40 } });
    expect(textInRect(document, frame)).toBe('typed words');
  });

  it('takes the selected part of a text field that meets the frame', () => {
    document.body.innerHTML = '<input id="f" type="text" value="hello world">';
    setRange('f', 6, 11);
    layout({ f: { left: 70, top: 10, right: 160, bottom: 40 } });
    expect(textInRect(document, frame)).toBe('world');
  });

  it('never reads a password field', () => {
    document.body.innerHTML =
      '<input id="f" type="password" value="SecretPass"><p id="v">visible</p>';
    setRange('f', 0, 6);
    layout({
      f: { left: 10, top: 10, right: 80, bottom: 40 },
      v: { left: 10, top: 50, right: 60, bottom: 70 },
    });
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('reads a field once, between the text before it and the text after it', () => {
    document.body.innerHTML =
      '<p id="a">before</p><textarea id="f">field</textarea><p id="b">after</p>';
    layout({
      a: { left: 10, top: 10, right: 40, bottom: 20 },
      f: { left: 10, top: 30, right: 80, bottom: 50 },
      b: { left: 10, top: 60, right: 40, bottom: 80 },
    });
    expect(textInRect(document, frame)).toBe('before field after');
  });

  it('walks the root element when the document has no <body> (an SVG or XML page)', () => {
    document.body.remove();
    document.documentElement.append(document.createTextNode('plain root text'));
    const realRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = realRange();
      range.getClientRects = () =>
        [{ left: 0, right: 10, top: 0, bottom: 10 }] as unknown as DOMRectList;
      return range;
    });
    document.elementsFromPoint = () => [document.documentElement];
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(document.documentElement);
    expect(document.body).toBeNull();
    expect(textInRect(document, frame)).toBe('plain root text');
  });

  it('answers an empty string when the document cannot be walked', () => {
    document.body.innerHTML = '<p>text</p>';
    const realRange = document.createRange.bind(document);
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = realRange();
      range.getClientRects = () => {
        throw new Error('no layout');
      };
      return range;
    });
    expect(textInRect(document, { x: 0, y: 0, w: 10, h: 10 })).toBe('');
  });
});
