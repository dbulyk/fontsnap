import type { Rect } from '../shared/capture';
import { nonEmpty, sendRect } from './chrome';
import { MAX_PREVIEW_GRAPHEMES, fitsPreview, graphemeCount } from './graphemes';

/**
 * A document can lack <body> (an SVG or XML page) although the DOM types say otherwise: the element is taken as a parameter
 * that may be null, so that no cast is needed (this code takes none, see eslint.config.js, PAGE_PROCESS_GLOBS).
 */
function bodyOrRoot(body: HTMLElement | null, root: HTMLElement): HTMLElement {
  return body ?? root;
}

/** The text walker skips these. textarea and input are read as fields, so their nodes are not counted twice. */
const NOT_SHOWN_TAGS = 'textarea, input, select, option, script, style, noscript, template';
const NOT_SHOWN = `${NOT_SHOWN_TAGS}, :is(${NOT_SHOWN_TAGS}) *`;

/** Name / id / label tokens that mark a field as sensitive. When in doubt, skip. */
const SENSITIVE_TOKEN =
  /pass|pwd|pw|pin|cvv|cvc|csc|otp|card|password|пароль/i;

/** The part of `line` inside the rectangle, or null when they do not overlap. */
function overlap(line: DOMRect, r: Rect): Rect | null {
  const x = Math.max(line.left, r.x);
  const y = Math.max(line.top, r.y);
  const w = Math.min(line.right, r.x + r.w) - x;
  const h = Math.min(line.bottom, r.y + r.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Alpha of a computed color. An unparsed color counts as covering. */
function colorAlpha(color: string): number {
  if (color === 'transparent') return 0;
  const match = /^rgba?\(([^)]+)\)$/.exec(color);
  if (match === null) return 1;
  const body = match[1];
  if (body === undefined) return 1;
  const slash = body.split('/');
  if (slash.length === 2) return alphaOf(slash[1] ?? '');
  const parts = body.split(',');
  if (parts.length === 4) return alphaOf(parts[3] ?? '');
  return 1;
}

function alphaOf(raw: string): number {
  const text = raw.trim();
  if (text.endsWith('%')) {
    const n = Number(text.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : 1;
  }
  const n = Number(text);
  return Number.isFinite(n) ? n : 1;
}

const PAINTING_TAG = /^(?:IMG|VIDEO|CANVAS|IFRAME|SVG|OBJECT|EMBED)$/;

function fromDom(rect: DOMRect): Rect {
  return { x: rect.left, y: rect.top, w: rect.right - rect.left, h: rect.bottom - rect.top };
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** `rect(top, right, bottom, left)` offsets are from the border box's top-left. `auto` keeps that edge. */
function applyClip(clip: string, border: Rect): Rect {
  const body = /^rect\(([^)]*)\)$/i.exec(clip.trim())?.[1] ?? '';
  const parts = body.split(/[,\s]+/).filter((part) => part !== '');
  const edge = (raw: string | undefined, start: number, size: number, open: boolean): number => {
    const token = (raw ?? '').trim().toLowerCase();
    if (token === '' || token === 'auto') return open ? start : start + size;
    const n = Number(token.endsWith('px') ? token.slice(0, -2) : token);
    return Number.isFinite(n) ? start + n : open ? start : start + size;
  };
  const x = edge(parts[3], border.x, border.w, true);
  const y = edge(parts[0], border.y, border.h, true);
  const right = edge(parts[1], border.x, border.w, false);
  const bottom = edge(parts[2], border.y, border.h, false);
  return { x, y, w: right - x, h: bottom - y };
}

/** inset(50%) and inset(100%) are the sr-only clip-path. Any other clip-path is only the border box. */
function clipPathEmpties(path: string): boolean {
  const flat = path.trim().toLowerCase().replace(/\s+/g, '');
  return flat === 'inset(50%)' || flat === 'inset(100%)';
}

/** The border box when this element clips, an empty rect for an sr-only clip-path, or null. */
function clipLimit(el: Element): Rect | null {
  const style = getComputedStyle(el);
  const path = style.clipPath;
  const clip = style.getPropertyValue('clip').trim();
  if (
    style.overflow === 'visible' &&
    style.overflowX === 'visible' &&
    style.overflowY === 'visible' &&
    clip === 'auto' &&
    path === 'none'
  ) {
    return null;
  }
  if (clipPathEmpties(path)) return { x: 0, y: 0, w: 0, h: 0 };
  const border = fromDom(el.getBoundingClientRect());
  if (path !== 'none') return border;
  return clip === 'auto' ? border : applyClip(clip, border);
}

/** html/body scroll the viewport; their overflow is not an ancestor clip for framed text. */
function isViewportClipper(el: Element, doc: Document): boolean {
  return el === doc.documentElement || el === doc.body;
}

/**
 * Whether `ancestor` is a containing block that can clip `owner` via overflow.
 * Fixed: transform/filter/contain/will-change. Absolute: positioned or transform/filter. Else: all.
 */
function containingBlockFor(ancestor: Element, owner: Element): boolean {
  const pos = getComputedStyle(owner).position;
  if (pos === 'fixed') {
    const style = getComputedStyle(ancestor);
    return (
      style.transform !== 'none' ||
      style.filter !== 'none' ||
      style.contain === 'paint' ||
      style.contain === 'strict' ||
      style.willChange.includes('transform')
    );
  }
  if (pos === 'absolute') {
    const style = getComputedStyle(ancestor);
    return style.position !== 'static' || style.transform !== 'none' || style.filter !== 'none';
  }
  return true;
}

/** Walk parents with :modal / :popover-open. No closest (refused). */
function inTopLayer(el: Element): boolean {
  let current: Element | null = el;
  while (current !== null) {
    try {
      if (current.matches(':modal') || current.matches(':popover-open')) return true;
    } catch {
      return false;
    }
    current = current.parentElement;
  }
  return false;
}

/**
 * The part of `line` inside the frame and the clips that actually contain `owner`.
 * The owner's own clip always applies. Top-layer owners skip ancestor clip.
 */
function visiblePart(line: DOMRect, frame: Rect, owner: Element, doc: Document): Rect | null {
  let part = overlap(line, frame);
  if (part === null) return null;
  const own = clipLimit(owner);
  if (own !== null) {
    part = intersect(part, own);
    if (part === null) return null;
  }
  if (inTopLayer(owner)) return part;
  let current: Element | null = owner.parentElement;
  while (part !== null && current !== null) {
    if (!isViewportClipper(current, doc) && containingBlockFor(current, owner)) {
      const limit = clipLimit(current);
      if (limit !== null) part = intersect(part, limit);
    }
    current = current.parentElement;
  }
  return part;
}

function masked(style: CSSStyleDeclaration): boolean {
  const security = style.getPropertyValue('-webkit-text-security').trim().toLowerCase();
  return security !== '' && security !== 'none';
}

/**
 * `display: contents` has no box, so the nearest ancestor that does is what `checkVisibility` can see.
 * Visibility is read on the owner itself: it is inherited, and a contents box would otherwise be skipped.
 */
function styleVisible(owner: Element): boolean {
  const style = getComputedStyle(owner);
  if (style.visibility === 'hidden' || masked(style)) return false;
  let current: Element | null = owner;
  while (current !== null && current.getClientRects().length === 0) current = current.parentElement;
  return current?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ?? false;
}

function paints(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.opacity === '0') return false;
  if (PAINTING_TAG.test(el.tagName.toUpperCase())) return true;
  return style.backgroundImage !== 'none' || colorAlpha(style.backgroundColor) > 0;
}

/** Paint only counts when the hit point lies in the element's own client rects (not a stretched ::after). */
function paintsAtPoint(el: Element, cx: number, cy: number): boolean {
  for (const box of el.getClientRects()) {
    if (cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom) return paints(el);
  }
  return false;
}

/**
 * `pointer-events: none` skips cover only when set on the element itself: computed none while the parent is
 * not none. Inherited none from body (parent also none) must not skip cover. Inline style is not read here
 * (page-process code may not read `.style`); an inline none still shows up in the computed style.
 */
function peOwn(el: Element): boolean {
  const own = getComputedStyle(el).pointerEvents;
  if (own !== 'none') return false;
  const parent = el.parentElement;
  if (parent === null) return true;
  return getComputedStyle(parent).pointerEvents !== 'none';
}

/**
 * Hit-testing skips an element with its own `pointer-events: none`, so the stack would blame the layer under a
 * floating label or a hero caption. Those elements are not checked for covering.
 */
function covered(doc: Document, owner: Element, part: Rect): boolean {
  if (peOwn(owner)) return false;
  const cx = part.x + part.w / 2;
  const cy = part.y + part.h / 2;
  const stack = doc.elementsFromPoint(cx, cy);
  for (const hit of stack) {
    if (hit === owner) return false;
    if (owner.contains(hit)) {
      if (paintsAtPoint(hit, cx, cy)) return true;
      continue;
    }
    if (hit.contains(owner)) continue;
    if (paintsAtPoint(hit, cx, cy)) return true;
  }
  return false;
}

function clean(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function labelText(el: HTMLInputElement | HTMLTextAreaElement): string {
  const parts: string[] = [];
  const list = el.labels;
  if (list === null) return '';
  for (const label of list) {
    parts.push(label.textContent);
  }
  return parts.join(' ');
}

/** Fields that must never enter the preview (passwords, cards, OTP, and lookalikes). */
function sensitiveField(el: HTMLTextAreaElement | HTMLInputElement): boolean {
  if (el instanceof HTMLInputElement && el.type.toLowerCase() === 'password') return true;
  if (masked(getComputedStyle(el))) return true;
  if (/(?:current-password|new-password|one-time-code)/i.test(el.autocomplete)) return true;
  if (/(?:^|\s)cc-/i.test(el.autocomplete)) return true;
  if (SENSITIVE_TOKEN.test(el.name) || SENSITIVE_TOKEN.test(el.id)) return true;
  if (SENSITIVE_TOKEN.test(el.ariaLabel ?? '') || SENSITIVE_TOKEN.test(labelText(el))) return true;
  if (el instanceof HTMLInputElement) {
    const kind = el.type.toLowerCase();
    const numeric =
      el.inputMode.toLowerCase() === 'numeric' || kind === 'number' || kind === 'tel';
    if (numeric && el.maxLength >= 0 && el.maxLength <= 8) return true;
  } else if (el.inputMode.toLowerCase() === 'numeric' && el.maxLength >= 0 && el.maxLength <= 8) {
    return true;
  }
  return false;
}

function fieldPiece(
  doc: Document,
  el: HTMLTextAreaElement | HTMLInputElement,
  frame: Rect,
): string {
  if (el instanceof HTMLInputElement && el.type.toLowerCase() !== 'text') return '';
  if (sensitiveField(el)) return '';
  if (!styleVisible(el)) return '';
  let boxes = 0;
  let crossed = false;
  let inside = true;
  for (const box of el.getClientRects()) {
    boxes += 1;
    const part = visiblePart(box, frame, el, doc);
    const shown = part !== null && !covered(doc, el, part);
    if (shown) crossed = true;
    if (
      !shown ||
      box.left < frame.x ||
      box.top < frame.y ||
      box.right > frame.x + frame.w ||
      box.bottom > frame.y + frame.h
    ) {
      inside = false;
    }
  }
  // No client rect leaves `inside` true. display:none is that case, and a shown parent does not make it visible.
  if (boxes === 0) return '';
  const start = el.selectionStart;
  const end = el.selectionEnd;
  if (start !== null && end !== null && start !== end) {
    return crossed ? clean(el.value.slice(start, end)) : '';
  }
  return inside ? clean(el.value) : '';
}

/** Character offsets `[from, to)` whose boxes meet `line`, or null when none do. */
function lineOffsets(range: Range, node: Node, line: DOMRect): [number, number] | null {
  const value = node.nodeValue ?? '';
  let from = -1;
  let to = -1;
  for (let i = 0; i < value.length; i++) {
    range.setStart(node, i);
    range.setEnd(node, i + 1);
    const box = range.getBoundingClientRect();
    const midY = (box.top + box.bottom) / 2;
    const midX = (box.left + box.right) / 2;
    const hit =
      midY >= line.top &&
      midY <= line.bottom &&
      midX >= line.left &&
      midX <= line.right;
    if (hit) {
      if (from < 0) from = i;
      to = i + 1;
    } else if (from >= 0) {
      break;
    }
  }
  return from < 0 || to < 0 ? null : [from, to];
}

/**
 * Text of the node whose line boxes meet the frame. Only those lines are kept (not the whole nodeValue).
 */
function textPiece(doc: Document, range: Range, node: Node, frame: Rect): string {
  const value = node.nodeValue ?? '';
  const owner = node.parentElement;
  if (!value.trim() || owner === null) return '';
  if (owner.matches(NOT_SHOWN)) return '';
  if (!styleVisible(owner)) return '';
  range.selectNodeContents(node);
  const lines: DOMRect[] = [];
  for (const line of range.getClientRects()) lines.push(line);
  const parts: string[] = [];
  for (const line of lines) {
    const part = visiblePart(line, frame, owner, doc);
    if (part === null || covered(doc, owner, part)) continue;
    const offsets = lineOffsets(range, node, line);
    if (offsets === null) continue;
    const slice = value.slice(offsets[0], offsets[1]);
    if (slice.trim()) parts.push(slice);
  }
  return parts.length === 0 ? '' : clean(parts.join(' '));
}

// visible text of the page under the dragged rectangle (used as the preview sample when no selection is in it)
export function textInRect(doc: Document, r: Rect): string {
  const out: string[] = [];
  const range = doc.createRange();
  const root = bodyOrRoot(doc.body, doc.documentElement);
  const tw = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let count = 0;
  let textNodes = 0;
  try {
    for (
      let node = tw.nextNode();
      node && count <= MAX_PREVIEW_GRAPHEMES && textNodes < 20000;
      node = tw.nextNode()
    ) {
      let piece = '';
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        piece = fieldPiece(doc, node, r);
      } else if (node.nodeValue !== null) {
        textNodes += 1;
        piece = textPiece(doc, range, node, r);
      } else {
        continue;
      }
      if (!piece) continue;
      count += (out.length === 0 ? 0 : 1) + graphemeCount(piece);
      if (count > MAX_PREVIEW_GRAPHEMES) return '';
      out.push(piece);
    }
  } catch {
    return '';
  }
  return out.join(' ');
}

/** The selected text, only when a line of the selection lies in the rectangle: a selection elsewhere on the page is not what was framed. */
function selectionIn(selection: Selection | null, r: Rect): string {
  if (selection === null || selection.isCollapsed) return '';
  for (let i = 0; i < selection.rangeCount; i++) {
    for (const line of selection.getRangeAt(i).getClientRects()) {
      if (overlap(line, r) !== null) return fitsPreview(selection.toString().trim());
    }
  }
  return '';
}

/**
 * Injected on demand: draw a selection rectangle, then send its viewport rect to the service worker.
 *
 * This runs in the page's process, where the CSP of the extension does not apply, so `win` is used through a closed list of
 * members (eslint.config.js, OVERLAY_WINDOW_MEMBERS): document, addEventListener, removeEventListener, getSelection,
 * requestAnimationFrame, devicePixelRatio, and `__fontsnapActive`, the marker of a window that already shows the overlay (a
 * second injection does nothing; it lives in the isolated world of the content script, which the page can not see).
 * It is never aliased, cast, destructured, indexed by a computed name or passed on.
 */
export function startSelection(win: Window): void {
  if (win.__fontsnapActive === true) return;
  win.__fontsnapActive = true;
  const doc = win.document;
  const ov = doc.createElement('div');
  const box = doc.createElement('div');
  const hint = doc.createElement('div');
  Object.assign(ov.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    cursor: 'crosshair',
    background: 'rgba(0,0,0,0.15)',
  });
  Object.assign(box.style, {
    position: 'fixed',
    border: '2px solid #4f7cff',
    background: 'rgba(79,124,255,0.08)',
    display: 'none',
    pointerEvents: 'none',
  });
  Object.assign(hint.style, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    background: '#111',
    color: '#fff',
    font: '13px system-ui,sans-serif',
    padding: '6px 12px',
    borderRadius: '6px',
    pointerEvents: 'none',
  });
  hint.textContent = nonEmpty(chrome.i18n.getMessage('selectHint'), 'selectHint');
  ov.append(box, hint);
  doc.documentElement.appendChild(ov);
  let sx = 0;
  let sy = 0;
  let drag = false;
  const done = () => {
    if (!ov.isConnected) return;
    ov.remove();
    win.removeEventListener('keydown', key, true);
    win.__fontsnapActive = false;
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      done();
    }
  };
  win.addEventListener('keydown', key, true);
  ov.addEventListener('mousedown', (e) => {
    e.preventDefault();
    drag = true;
    sx = e.clientX;
    sy = e.clientY;
    Object.assign(box.style, {
      display: 'block',
      left: `${sx}px`,
      top: `${sy}px`,
      width: '0',
      height: '0',
    });
  });
  ov.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const x = Math.min(sx, e.clientX);
    const y = Math.min(sy, e.clientY);
    Object.assign(box.style, {
      left: `${x}px`,
      top: `${y}px`,
      width: `${Math.abs(e.clientX - sx)}px`,
      height: `${Math.abs(e.clientY - sy)}px`,
    });
  });
  ov.addEventListener('mouseup', (e) => {
    if (!drag) return;
    drag = false;
    const rect: Rect = {
      x: Math.min(sx, e.clientX),
      y: Math.min(sy, e.clientY),
      w: Math.abs(e.clientX - sx),
      h: Math.abs(e.clientY - sy),
    };
    done();
    if (rect.w < 8 || rect.h < 8) return;
    let text = '';
    try {
      text = selectionIn(win.getSelection(), rect);
    } catch {
      // selection text is optional
    }
    if (!text) text = textInRect(doc, rect);
    // wait two frames so the overlay is gone from the screenshot
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(() => {
        setTimeout(() => {
          void sendRect({ type: 'fontsnap-rect', rect, dpr: win.devicePixelRatio || 1, text });
        }, 30);
      });
    });
  });
}
