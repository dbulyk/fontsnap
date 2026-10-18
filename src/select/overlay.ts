import { sendMessage } from '../shared/messaging';
import { t } from '../shared/i18n';
import type { Rect } from '../shared/capture';

/**
 * A document can lack <body> (an SVG or XML page) although the DOM types say otherwise: the element is taken as a parameter
 * that may be null, so that no cast is needed (this code takes none, see eslint.config.js, PAGE_PROCESS_FILES).
 */
function bodyOrRoot(body: HTMLElement | null, root: HTMLElement): HTMLElement {
  return body ?? root;
}

// text of the page under the dragged rectangle (used as the preview sample when nothing is selected)
export function textInRect(doc: Document, r: Rect): string {
  const out: string[] = [];
  const range = doc.createRange();
  const root = bodyOrRoot(doc.body, doc.documentElement);
  const tw = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let len = 0;
  let n = 0;
  try {
    for (let node = tw.nextNode(); node && len < 80 && n < 20000; node = tw.nextNode(), n++) {
      const value = node.nodeValue ?? '';
      if (!value.trim()) continue;
      range.selectNodeContents(node);
      const b = range.getBoundingClientRect();
      if (b.right < r.x || b.left > r.x + r.w || b.bottom < r.y || b.top > r.y + r.h) continue;
      const piece = value.trim().replace(/\s+/g, ' ');
      out.push(piece);
      len += piece.length + 1;
    }
  } catch {
    return '';
  }
  return out.join(' ').slice(0, 80);
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
  hint.textContent = t('selectHint');
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
      const s = win.getSelection()?.toString();
      text = (s ?? '').trim().slice(0, 80);
    } catch {
      // selection text is optional
    }
    if (!text) text = textInRect(doc, rect);
    // wait two frames so the overlay is gone from the screenshot
    win.requestAnimationFrame(() => {
      win.requestAnimationFrame(() => {
        setTimeout(() => {
          sendMessage({ type: 'fontsnap-rect', rect, dpr: win.devicePixelRatio || 1, text }).catch(
            () => undefined,
          );
        }, 30);
      });
    });
  });
}
