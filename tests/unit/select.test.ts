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

/**
 * Computed style on top of what the element already has.
 * Omitted fields use the values Chromium computes for a transparent element.
 */
interface StackPaint {
  opacity?: string;
  backgroundColor?: string;
  backgroundImage?: string;
  visibility?: string;
  overflow?: string;
  overflowX?: string;
  overflowY?: string;
  clip?: string;
  clipPath?: string;
  pointerEvents?: string;
  textSecurity?: string;
  position?: string;
  transform?: string;
  translate?: string;
  rotate?: string;
  scale?: string;
  filter?: string;
  perspective?: string;
  contain?: string;
  willChange?: string;
}

type BoxSpec = Partial<DOMRect> | Partial<DOMRect>[];

function asLines(spec: BoxSpec | undefined): Partial<DOMRect>[] {
  if (spec === undefined) return [];
  if (Array.isArray(spec)) {
    const lines: Partial<DOMRect>[] = [];
    for (const box of spec) lines.push(box);
    return lines;
  }
  return [spec];
}

function firstBox(spec: BoxSpec | undefined): Partial<DOMRect> | undefined {
  const lines = asLines(spec);
  return lines[0];
}

/**
 * Layout for happy-dom, which does not place boxes.
 * `boxes` are the line boxes of each element's text (and the border box of a field with that id).
 * A value may be one box or several line boxes; character ranges map into those lines.
 * `bounds` are border boxes for clipping; a placed element uses its line box when no bound is given.
 * `stack`, top to bottom, is what `elementsFromPoint` returns.
 * `noBox` elements have no CSS box, as `display: contents` does.
 * happy-dom leaves overflow, clip and background empty. Chromium computes `visible`, `auto`, `none`
 * and a transparent color, so the style spy speaks Chromium and then applies `paint`.
 */
function layout(
  boxes: Record<string, BoxSpec>,
  onTop?: (x: number, y: number) => Element | null,
  options?: {
    stack?: (x: number, y: number) => readonly Element[];
    paint?: (el: Element) => StackPaint;
    noBox?: readonly string[];
    bounds?: Record<string, Partial<DOMRect>>;
    /** Glyph boxes taller than the line (line-height ≤ 1): extend into the neighbour. */
    denseGlyphs?: boolean;
  },
): void {
  const ownerId = (node: Node): string => {
    if (node instanceof Element) return node.id;
    return node.parentElement?.id ?? '';
  };
  const charBox = (id: string, index: number): DOMRect => {
    const lines = asLines(boxes[id]);
    const text = document.getElementById(id)?.textContent ?? '';
    if (lines.length === 0) {
      return { left: 0, right: 0, top: 0, bottom: 0 } as DOMRect;
    }
    if (lines.length === 1) {
      return { left: 0, right: 0, top: 0, bottom: 0, ...lines[0] } as DOMRect;
    }
    const per = Math.max(1, Math.ceil(text.length / lines.length));
    const line = lines[Math.min(lines.length - 1, Math.floor(index / per))] ?? lines[0] ?? {};
    const top = line.top ?? 0;
    const bottom = line.bottom ?? 0;
    if (options?.denseGlyphs === true) {
      return { left: 0, right: 0, ...line, top: top - 6, bottom: bottom + 6 } as DOMRect;
    }
    return { left: 0, right: 0, top: 0, bottom: 0, ...line } as DOMRect;
  };
  const realRange = document.createRange.bind(document);
  vi.spyOn(document, 'createRange').mockImplementation(() => {
    const range = realRange();
    range.getClientRects = () => {
      const id = ownerId(range.startContainer);
      const lines = asLines(boxes[id]);
      return lines.map((box) => ({
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        ...box,
      })) as unknown as DOMRectList;
    };
    range.getBoundingClientRect = () => {
      const id = ownerId(range.startContainer);
      if (
        range.startContainer === range.endContainer &&
        range.endOffset === range.startOffset + 1
      ) {
        return charBox(id, range.startOffset);
      }
      const lines = asLines(boxes[id]);
      if (lines.length === 0) {
        return { left: 0, right: 0, top: 0, bottom: 0 } as DOMRect;
      }
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      for (const box of lines) {
        left = Math.min(left, box.left ?? 0);
        top = Math.min(top, box.top ?? 0);
        right = Math.max(right, box.right ?? 0);
        bottom = Math.max(bottom, box.bottom ?? 0);
      }
      return { left, top, right, bottom } as DOMRect;
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
      const lines = asLines(boxes[id]);
      return lines.some((b) => {
        return (
          x >= (b.left ?? 0) && x <= (b.right ?? 0) && y >= (b.top ?? 0) && y <= (b.bottom ?? 0)
        );
      });
    });
    const hits: Element[] = [];
    for (const id of ids.reverse()) {
      const hit = document.getElementById(id);
      if (hit !== null) hits.push(hit);
    }
    return hits;
  };
  document.elementsFromPoint = (x, y) => hitsAt(x, y);
  const realStyle = window.getComputedStyle.bind(window);
  const paintOf = options?.paint;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
    const real = realStyle(el);
    const paint = paintOf?.(el) ?? {};
    const pick = (over: string | undefined, value: string, fallback: string): string => {
      if (over !== undefined && over !== '') return over;
      if (value !== '') return value;
      return fallback;
    };
    const overflow = pick(paint.overflow, real.overflow, 'visible');
    const security = paint.textSecurity ?? real.getPropertyValue('-webkit-text-security');
    const clip = pick(paint.clip, real.getPropertyValue('clip'), 'auto');
    return {
      display: real.display === '' ? 'block' : real.display,
      opacity: pick(paint.opacity, real.opacity, '1'),
      visibility: pick(paint.visibility, real.visibility, 'visible'),
      backgroundColor: pick(paint.backgroundColor, real.backgroundColor, 'rgba(0, 0, 0, 0)'),
      backgroundImage: pick(paint.backgroundImage, real.backgroundImage, 'none'),
      overflow,
      overflowX: pick(paint.overflowX, real.overflowX, overflow),
      overflowY: pick(paint.overflowY, real.overflowY, overflow),
      clipPath: pick(paint.clipPath, real.clipPath, 'none'),
      pointerEvents: pick(paint.pointerEvents, real.pointerEvents, 'auto'),
      position: pick(paint.position, real.position, 'static'),
      transform: pick(paint.transform, real.transform, 'none'),
      translate: pick(paint.translate, real.translate, 'none'),
      rotate: pick(paint.rotate, real.rotate, 'none'),
      scale: pick(paint.scale, real.scale, 'none'),
      filter: pick(paint.filter, real.filter, 'none'),
      perspective: pick(paint.perspective, real.perspective, 'none'),
      contain: pick(paint.contain, real.contain, 'none'),
      willChange: pick(paint.willChange, real.willChange, 'auto'),
      getPropertyValue: (property: string) => {
        if (property === '-webkit-text-security') return security === '' ? 'none' : security;
        if (property === 'clip') return clip;
        return real.getPropertyValue(property);
      },
    } as CSSStyleDeclaration;
  });
  const bounds = options?.bounds ?? {};
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = bounds[this.id] ?? firstBox(boxes[this.id]);
    return {
      left: 0,
      top: 0,
      right: 0,
      bottom: 0,
      ...(box ?? {}),
    } as DOMRect;
  });
  const noBox = new Set(options?.noBox ?? []);
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    if (noBox.has(this.id)) return [] as unknown as DOMRectList;
    const lines = asLines(boxes[this.id]);
    // happy-dom's own getClientRects is one zero rect. Keep that for elements the test did not place.
    if (lines.length === 0) {
      return [{ left: 0, right: 0, top: 0, bottom: 0 }] as unknown as DOMRectList;
    }
    return lines.map((box) => ({
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      ...box,
    })) as unknown as DOMRectList;
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

  it('drops a selection longer than 100 graphemes', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(
      selectionOf('y'.repeat(101), { right: 50, bottom: 50 }),
    );
    startSelection(window);
    drag([10, 10], [60, 60]);
    vi.advanceTimersByTime(30);
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: '' }),
    );
  });

  it('keeps a selection of exactly 100 graphemes', () => {
    vi.spyOn(window, 'getSelection').mockReturnValue(
      selectionOf('y'.repeat(100), { right: 50, bottom: 50 }),
    );
    startSelection(window);
    drag([10, 10], [60, 60]);
    vi.advanceTimersByTime(30);
    expect(stub.chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'y'.repeat(100) }),
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

  it('keeps 100 graphemes and drops a longer capture', () => {
    document.body.innerHTML = `<p id="a">${'a'.repeat(100)}</p>`;
    layout({ a: { right: 40, bottom: 20 } });
    expect(textInRect(document, frame)).toBe('a'.repeat(100));
  });

  it('drops 101 graphemes, including a join and a multi-code-unit character', () => {
    document.body.innerHTML = `<p id="a">${'a'.repeat(101)}</p>`;
    layout({ a: { right: 40, bottom: 20 } });
    expect(textInRect(document, frame)).toBe('');
  });

  it('keeps 100 thumbs-up graphemes', () => {
    document.body.innerHTML = `<p id="a">${'👍'.repeat(100)}</p>`;
    layout({ a: { right: 40, bottom: 20 } });
    expect(textInRect(document, frame)).toBe('👍'.repeat(100));
  });

  it('drops 101 thumbs-up graphemes', () => {
    document.body.innerHTML = `<p id="a">${'👍'.repeat(101)}</p>`;
    layout({ a: { right: 40, bottom: 20 } });
    expect(textInRect(document, frame)).toBe('');
  });

  it('drops two pieces once the joining space passes 100 graphemes', () => {
    document.body.innerHTML = `<p id="a">${'a'.repeat(50)}</p><p id="b">${'b'.repeat(50)}</p>`;
    layout({
      a: { right: 10, bottom: 10 },
      b: { top: 20, right: 10, bottom: 30 },
    });
    expect(textInRect(document, frame)).toBe('');
    expect(textInRect(document, { x: 5000, y: 5000, w: 1, h: 1 })).toBe('');
  });

  it('keeps two pieces that join to exactly 100 graphemes', () => {
    document.body.innerHTML = `<p id="a">${'a'.repeat(50)}</p><p id="b">${'b'.repeat(49)}</p>`;
    layout({
      a: { right: 10, bottom: 10 },
      b: { top: 20, right: 10, bottom: 30 },
    });
    expect(textInRect(document, frame)).toBe(`${'a'.repeat(50)} ${'b'.repeat(49)}`);
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
    layout(
      {
        t: { right: 50, bottom: 10 },
        cover: { left: 0, right: 50, top: 0, bottom: 10 },
        v: { top: 20, right: 50, bottom: 30 },
      },
      undefined,
      {
        stack: (_x, y) => (y < 15 ? [el('cover'), el('t')] : [el('v')]),
        paint: (hit) => (hit.id === 'cover' ? { backgroundColor: 'rgb(255, 255, 255)' } : {}),
      },
    );
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

  it('takes text that does not receive pointer events over an opaque sibling', () => {
    document.body.innerHTML =
      '<div id="slide"></div><p id="t" style="pointer-events:none">pointer free</p>';
    layout({ t: { left: 10, right: 90, top: 10, bottom: 30 } }, undefined, {
      stack: () => [el('slide')],
      paint: (hit) => (hit.id === 'slide' ? { backgroundColor: 'rgb(20, 40, 60)' } : {}),
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
        cover: { left: 10, right: 80, top: 10, bottom: 28 },
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
      paint: (hit) => (hit.id === 'p' ? { backgroundColor: 'rgb(255, 255, 255)' } : {}),
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

  it('does not read .value of a password field (masks are what is painted)', () => {
    document.body.innerHTML =
      '<input id="f" type="password" value="SecretPass"><p id="v">visible</p>';
    setRange('f', 0, 6);
    layout({
      f: { left: 10, top: 10, right: 80, bottom: 40 },
      v: { left: 10, top: 50, right: 60, bottom: 70 },
    });
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('does not read .value when text-security paints masks', () => {
    document.body.innerHTML =
      '<input id="f" type="text" value="MaskedBankPass"><p id="v">visible</p>';
    layout(
      {
        f: { left: 10, top: 10, right: 80, bottom: 40 },
        v: { left: 10, top: 50, right: 60, bottom: 70 },
      },
      undefined,
      { paint: (el) => (el.id === 'f' ? { textSecurity: 'disc' } : {}) },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('skips letters whose owner disguises them with text security', () => {
    document.body.innerHTML = '<p id="t">TRAP secret</p><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, top: 10, right: 80, bottom: 28 },
        v: { left: 10, top: 40, right: 70, bottom: 58 },
      },
      undefined,
      { paint: (el) => (el.id === 't' ? { textSecurity: 'disc' } : {}) },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('reads an email field when it sits inside the frame', () => {
    document.body.innerHTML = '<input id="f" type="email" value="ada@example.com">';
    layout({ f: { left: 10, top: 10, right: 80, bottom: 40 } });
    expect(textInRect(document, frame)).toBe('ada@example.com');
  });

  it('reads a search input', () => {
    document.body.innerHTML = '<input id="f" type="search" value="query words">';
    layout({ f: { left: 10, top: 10, right: 80, bottom: 40 } });
    expect(textInRect(document, frame)).toBe('query words');
  });

  it('reads an input with no type and an input with an unknown type', () => {
    document.body.innerHTML = '<input id="f" value="plain words">';
    layout({ f: { left: 10, top: 10, right: 80, bottom: 40 } });
    expect(textInRect(document, frame)).toBe('plain words');
  });

  it('reads an input whose type is not a real type', () => {
    document.body.innerHTML = '<input id="f" type="not-a-type" value="odd type">';
    layout({ f: { left: 10, top: 10, right: 80, bottom: 40 } });
    expect(textInRect(document, frame)).toBe('odd type');
  });

  it('does not read a textarea that has no box', () => {
    document.body.innerHTML =
      '<textarea id="f" style="display:none">DisplayNoneTextarea</textarea><p id="v">visible</p>';
    layout({ v: { left: 10, top: 10, right: 60, bottom: 30 } }, undefined, { noBox: ['f'] });
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('skips a textarea covered by an opaque layer', () => {
    document.body.innerHTML =
      '<textarea id="f">CoveredFieldValue</textarea><div id="cover"></div><p id="v">visible</p>';
    layout(
      {
        f: { left: 10, top: 10, right: 80, bottom: 40 },
        cover: { left: 10, top: 10, right: 80, bottom: 40 },
        v: { left: 10, top: 60, right: 70, bottom: 80 },
      },
      undefined,
      {
        stack: (_x, y) => (y < 50 ? [el('cover'), el('f')] : [el('v')]),
        paint: (el) => (el.id === 'cover' ? { backgroundColor: 'rgb(255, 255, 255)' } : {}),
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('skips text clipped by an ancestor overflow box', () => {
    document.body.innerHTML =
      '<div id="clip" style="overflow:hidden"><p id="t">TRAP clipped</p></div><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, top: 50, right: 80, bottom: 70 },
        v: { left: 10, top: 80, right: 70, bottom: 96 },
      },
      undefined,
      { bounds: { clip: { left: 0, top: 0, right: 100, bottom: 30 } } },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('skips text clipped only on overflow-x', () => {
    document.body.innerHTML =
      '<div id="clip"><p id="t">TRAP clipped</p></div><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, top: 50, right: 80, bottom: 70 },
        v: { left: 10, top: 80, right: 70, bottom: 96 },
      },
      undefined,
      {
        bounds: { clip: { left: 0, top: 0, right: 100, bottom: 30 } },
        paint: (el) =>
          el.id === 'clip'
            ? { overflow: 'visible', overflowX: 'hidden', overflowY: 'visible' }
            : {},
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('skips text clipped to an empty rect()', () => {
    document.body.innerHTML = '<p id="t">TRAP clip</p><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, top: 10, right: 80, bottom: 28 },
        v: { left: 10, top: 40, right: 70, bottom: 58 },
      },
      undefined,
      {
        bounds: { t: { left: 10, top: 10, right: 200, bottom: 80 } },
        paint: (el) => (el.id === 't' ? { clip: 'rect(0px, 0px, 0px, 0px)' } : {}),
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it.each(['inset(100%)', 'inset(50%)'])('skips text clipped by clip-path %s', (path) => {
    document.body.innerHTML = '<p id="t">TRAP inset</p><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, top: 10, right: 80, bottom: 28 },
        v: { left: 10, top: 40, right: 70, bottom: 58 },
      },
      undefined,
      { paint: (el) => (el.id === 't' ? { clipPath: path } : {}) },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('keeps text inside a clip-path that is not an inset', () => {
    document.body.innerHTML = '<p id="t">inside words</p>';
    layout({ t: { left: 10, top: 10, right: 80, bottom: 28 } }, undefined, {
      bounds: { t: { left: 10, top: 10, right: 90, bottom: 40 } },
      paint: (el) => (el.id === 't' ? { clipPath: 'circle(50%)' } : {}),
    });
    expect(textInRect(document, frame)).toBe('inside words');
  });

  it.each([
    ['an image', 'img'],
    ['a canvas', 'canvas'],
    ['an svg', 'svg'],
  ])('skips text covered by %s', (_name, tag) => {
    document.body.innerHTML = `<p id="t">covered</p><${tag} id="cover"></${tag}><p id="v">visible</p>`;
    layout(
      {
        t: { left: 10, top: 10, right: 80, bottom: 28 },
        cover: { left: 10, top: 10, right: 80, bottom: 28 },
        v: { left: 10, top: 40, right: 70, bottom: 58 },
      },
      undefined,
      { stack: (_x, y) => (y < 34 ? [el('cover'), el('t')] : [el('v')]) },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('skips display:contents text whose own visibility is hidden', () => {
    document.body.innerHTML =
      '<p id="p"><span id="t" style="display:contents;visibility:hidden">TRAP secret</span></p><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, top: 10, right: 80, bottom: 28 },
        v: { left: 10, top: 40, right: 70, bottom: 58 },
      },
      undefined,
      {
        noBox: ['t'],
        stack: (_x, y) => (y < 34 ? [el('p')] : [el('v')]),
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('takes a floating label that does not receive pointer events', () => {
    document.body.innerHTML =
      '<div id="group"><label id="t" style="pointer-events:none">Floating Label</label><input id="f"></div>';
    layout(
      {
        t: { left: 10, top: 10, right: 80, bottom: 28 },
        f: { left: 8, top: 8, right: 90, bottom: 40 },
      },
      undefined,
      {
        stack: () => [el('f')],
        paint: (hit) => {
          if (hit.id === 't') return { pointerEvents: 'none' };
          if (hit.id === 'f') return { backgroundColor: 'rgb(255, 255, 255)' };
          return {};
        },
      },
    );
    expect(textInRect(document, frame)).toBe('Floating Label');
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
    layout({});
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = realRange();
      const box = { left: 0, right: 10, top: 0, bottom: 10 } as DOMRect;
      range.getClientRects = () => [box] as unknown as DOMRectList;
      range.getBoundingClientRect = () => box;
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

  it('keeps only the framed line of a multi-line text node', () => {
    document.body.innerHTML = '<p id="t">AAAAABBBBBCCCCC</p>';
    layout(
      {
        t: [
          { left: 10, right: 90, top: 0, bottom: 16 },
          { left: 10, right: 90, top: 20, bottom: 36 },
          { left: 10, right: 90, top: 40, bottom: 56 },
        ],
      },
      undefined,
      { stack: () => [el('t')] },
    );
    expect(textInRect(document, { x: 0, y: 18, w: 100, h: 20 })).toBe('BBBBB');
  });

  it('does not skip cover when pointer-events:none is only inherited from body', () => {
    document.body.innerHTML =
      '<p id="t">Article text</p><div id="cover"></div><p id="v">Sign in</p>';
    layout(
      {
        t: { left: 10, right: 90, top: 10, bottom: 30 },
        cover: { left: 0, right: 100, top: 0, bottom: 100 },
        v: { left: 20, right: 80, top: 40, bottom: 60 },
      },
      undefined,
      {
        stack: (_x, y) => (y < 35 ? [el('cover'), el('t')] : [el('v')]),
        paint: (hit) => {
          if (hit === document.body) return { pointerEvents: 'none' };
          if (hit.id === 't') return { pointerEvents: 'none' };
          if (hit.id === 'cover') {
            return { pointerEvents: 'auto', backgroundColor: 'rgba(0, 0, 0, 0.5)' };
          }
          return {};
        },
      },
    );
    expect(textInRect(document, frame)).toBe('Sign in');
  });

  it('takes fixed text that escapes an overflow:hidden ancestor without a containing block', () => {
    document.body.innerHTML =
      '<nav id="nav"><div id="t" style="position:fixed">MenuItem one</div></nav>';
    layout({ t: { left: 10, right: 120, top: 50, bottom: 70 } }, undefined, {
      bounds: { nav: { left: 0, top: 0, right: 200, bottom: 40 } },
      paint: (hit) => {
        if (hit.id === 'nav') return { overflow: 'hidden' };
        if (hit.id === 't') return { position: 'fixed' };
        return {};
      },
      stack: () => [el('t')],
    });
    expect(textInRect(document, { x: 0, y: 40, w: 200, h: 40 })).toBe('MenuItem one');
  });

  it('clips fixed text when a transform CB sits under overflow:hidden', () => {
    document.body.innerHTML =
      '<div id="clip"><div id="wrap"><p id="t">TRAP fixed</p></div></div><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, right: 90, top: 50, bottom: 70 },
        v: { left: 10, right: 70, top: 80, bottom: 96 },
      },
      undefined,
      {
        bounds: { clip: { left: 0, top: 0, right: 100, bottom: 30 } },
        paint: (hit) => {
          if (hit.id === 'clip') return { overflow: 'hidden' };
          if (hit.id === 'wrap') return { transform: 'matrix(1, 0, 0, 1, 0, 0)' };
          if (hit.id === 't') return { position: 'fixed' };
          return {};
        },
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('treats perspective as a fixed containing block', () => {
    document.body.innerHTML =
      '<div id="clip"><div id="wrap"><p id="t">TRAP fixed</p></div></div><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, right: 90, top: 50, bottom: 70 },
        v: { left: 10, right: 70, top: 80, bottom: 96 },
      },
      undefined,
      {
        bounds: { clip: { left: 0, top: 0, right: 100, bottom: 30 } },
        paint: (hit) => {
          if (hit.id === 'clip') return { overflow: 'hidden' };
          if (hit.id === 'wrap') return { perspective: '800px' };
          if (hit.id === 't') return { position: 'fixed' };
          return {};
        },
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('treats contain:layout as a fixed containing block', () => {
    document.body.innerHTML =
      '<div id="clip"><div id="wrap"><p id="t">TRAP fixed</p></div></div><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, right: 90, top: 50, bottom: 70 },
        v: { left: 10, right: 70, top: 80, bottom: 96 },
      },
      undefined,
      {
        bounds: { clip: { left: 0, top: 0, right: 100, bottom: 30 } },
        paint: (hit) => {
          if (hit.id === 'clip') return { overflow: 'hidden' };
          if (hit.id === 'wrap') return { contain: 'layout' };
          if (hit.id === 't') return { position: 'fixed' };
          return {};
        },
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('clips absolute text via a relative parent under overflow:hidden', () => {
    document.body.innerHTML =
      '<div id="clip"><div id="rel"><p id="t">TRAP abs</p></div></div><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, right: 90, top: 50, bottom: 70 },
        v: { left: 10, right: 70, top: 80, bottom: 96 },
      },
      undefined,
      {
        bounds: { clip: { left: 0, top: 0, right: 100, bottom: 30 } },
        paint: (hit) => {
          if (hit.id === 'clip') return { overflow: 'hidden' };
          if (hit.id === 'rel') return { position: 'relative' };
          if (hit.id === 't') return { position: 'absolute' };
          return {};
        },
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('ignores opaque siblings under the pe:none wrapper parent, not the whole document', () => {
    document.body.innerHTML =
      '<div id="group"><div id="bg"></div><div id="wrap"><h1 id="t">Hero Caption</h1></div></div>';
    layout(
      {
        t: { left: 10, right: 120, top: 10, bottom: 40 },
        bg: { left: 0, right: 200, top: 0, bottom: 50 },
      },
      undefined,
      {
        stack: () => [el('bg'), el('t')],
        paint: (hit) => {
          if (hit.id === 'wrap') return { pointerEvents: 'none' };
          if (hit.id === 't') return { pointerEvents: 'none' };
          if (hit.id === 'bg') return { backgroundColor: 'rgb(34, 68, 102)' };
          return {};
        },
      },
    );
    expect(textInRect(document, { x: 0, y: 0, w: 200, h: 50 })).toBe('Hero Caption');
  });

  it('keeps cover from a cookie wall outside the pe:none wrapper parent', () => {
    document.body.innerHTML =
      '<div id="group"><div id="wrap"><h1 id="t">Hero Shop now</h1></div></div><div id="cookie"></div><p id="v">Cookie wall</p>';
    layout(
      {
        t: { left: 10, right: 120, top: 10, bottom: 40 },
        cookie: { left: 0, right: 200, top: 0, bottom: 100 },
        v: { left: 20, right: 160, top: 50, bottom: 70 },
      },
      undefined,
      {
        stack: (_x, y) => (y < 45 ? [el('cookie'), el('t')] : [el('v')]),
        paint: (hit) => {
          if (hit.id === 'wrap') return { pointerEvents: 'none' };
          if (hit.id === 't') return { pointerEvents: 'none' };
          if (hit.id === 'cookie') return { backgroundColor: 'rgb(255, 255, 255)' };
          return {};
        },
      },
    );
    expect(textInRect(document, frame)).toBe('Cookie wall');
  });

  it('clips fixed text when a translate CB sits under overflow:hidden', () => {
    document.body.innerHTML =
      '<div id="clip"><div id="wrap"><p id="t">TRAP fixed</p></div></div><p id="v">visible</p>';
    layout(
      {
        t: { left: 10, right: 90, top: 50, bottom: 70 },
        v: { left: 10, right: 70, top: 80, bottom: 96 },
      },
      undefined,
      {
        bounds: { clip: { left: 0, top: 0, right: 100, bottom: 30 } },
        paint: (hit) => {
          if (hit.id === 'clip') return { overflow: 'hidden' };
          if (hit.id === 'wrap') return { translate: '0px' };
          if (hit.id === 't') return { position: 'fixed' };
          return {};
        },
      },
    );
    expect(textInRect(document, frame)).toBe('visible');
  });

  it('does not take a checkbox value (it is not painted as text)', () => {
    document.body.innerHTML =
      '<input id="f" type="checkbox" checked value="on"><p id="v">Remember me</p>';
    layout(
      {
        f: { left: 10, right: 30, top: 10, bottom: 30 },
        v: { left: 40, right: 140, top: 10, bottom: 30 },
      },
      undefined,
      { stack: () => [el('v')] },
    );
    expect(textInRect(document, frame)).toBe('Remember me');
  });

  it('keeps only characters whose center meets the framed line (dense line-height)', () => {
    // Contiguous line boxes; glyphs taller than the line overlap the neighbour (line-height ≤ 1).
    document.body.innerHTML = '<p id="t">AAAAABBBBB</p>';
    layout(
      {
        t: [
          { left: 10, right: 90, top: 0, bottom: 16 },
          { left: 10, right: 90, top: 16, bottom: 32 },
        ],
      },
      undefined,
      { stack: () => [el('t')], denseGlyphs: true },
    );
    // Frame only the second line; first-line glyphs that overlap it must not join.
    expect(textInRect(document, { x: 0, y: 16, w: 100, h: 16 })).toBe('BBBBB');
  });

  it('takes a heading when a painted stretched link only covers its own box', () => {
    document.body.innerHTML =
      '<div id="card"><h2 id="title">Card Title Here</h2><a id="link" href="#">Go</a></div>';
    layout(
      {
        title: { left: 10, right: 200, top: 10, bottom: 40 },
        link: { left: 10, right: 80, top: 50, bottom: 70 },
      },
      undefined,
      {
        stack: () => [el('link'), el('title')],
        paint: (hit) => (hit.id === 'link' ? { backgroundColor: 'rgb(13, 110, 253)' } : {}),
      },
    );
    expect(textInRect(document, { x: 0, y: 0, w: 220, h: 45 })).toBe('Card Title Here');
  });
});
