import type { Rect } from '../shared/capture';

/**
 * One of the two functions that FontSnap hands to chrome.scripting.executeScript({ func }) (the other is loadImagePixels in
 * load-image.ts). It is serialized and runs in the web page's process, where the CSP of the extension does not apply, so it lives alone
 * in this file, held to the rules of the content script (eslint.config.js, PAGE_PROCESS_GLOBS: no computed access, no casts, no types
 * of its own but the ones of PAGE_TYPES, `document` only as `document.images` and `document.getElementsByTagName`, `window` only as
 * `window.devicePixelRatio`, `.innerWidth`, `.innerHeight`, and every DOM member on DOM_MEMBERS).
 */
export interface MeasuredImage {
  /** The box of the element in the viewport of its frame, CSS pixels. */
  rect: Rect;
  dpr: number;
  /**
   * Which of the matching elements was measured (its index among them), then `scrollLeft, scrollTop` of every ancestor of the element,
   * nearest first, as they were before the element was scrolled into view.
   */
  saved: number[];
  /**
   * `kind 'image'`: the viewport of the frame (0, 0, innerWidth, innerHeight); `kind 'frame'`: the client box of the iframe - the
   * border on its left and top (clientLeft, clientTop) and the size inside the border, padding included (clientWidth, clientHeight).
   */
  box: Rect;
  /**
   * `kind 'frame'`: the size of the whole border box of the iframe before any CSS scale (offsetWidth, offsetHeight), which with the
   * client box gives the border on the right and at the bottom too; `kind 'image'`: the same as `box`.
   */
  outer: Rect;
}

/**
 * `kind 'image'`: the image of this document that shows `target`. `kind 'frame'`: the one `<iframe>` of this document whose src is
 * `target`. With `saved === null` the element is measured (an image is first scrolled into view and given two animation frames
 * to be painted; the scroll positions that this will change are returned in `saved`). With the list a previous call returned
 * the positions are written back and the answer is null, as it is when the element is not there (or, for a frame, not one).
 */
// Runs inside the page (serialized by chrome.scripting): it may not touch anything from this module.
export async function measureImage(
  target: string,
  kind: 'image' | 'frame',
  saved: readonly number[] | null,
): Promise<MeasuredImage | null> {
  const shown = (e: HTMLElement): boolean => {
    const r = e.getBoundingClientRect();
    return (
      r.width > 0 &&
      r.height > 0 &&
      r.left + r.width > 0 &&
      r.top + r.height > 0 &&
      r.left < window.innerWidth &&
      r.top < window.innerHeight
    );
  };
  const sized = (e: HTMLElement): boolean => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const matches: HTMLElement[] =
    kind === 'image'
      ? [...document.images].filter((i) => i.currentSrc === target || i.src === target)
      : [...document.getElementsByTagName('iframe')].filter((f) => f.src === target);
  const el =
    saved !== null
      ? saved[0] === undefined
        ? undefined
        : matches.at(saved[0])
      : kind === 'frame'
        ? matches.length === 1
          ? matches[0]
          : undefined
        : (matches.find(shown) ?? matches.find(sized) ?? matches[0]);
  if (!el) return null;
  const chain: HTMLElement[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) chain.push(p);
  if (saved !== null) {
    // `instant`: a page with `scroll-behavior: smooth` would otherwise still be moving afterwards
    chain.forEach((p, i) => {
      p.scrollTo({
        left: saved.at(2 * i + 1) ?? p.scrollLeft,
        top: saved.at(2 * i + 2) ?? p.scrollTop,
        behavior: 'instant',
      });
    });
    return null;
  }
  const before = [matches.indexOf(el), ...chain.flatMap((p) => [p.scrollLeft, p.scrollTop])];
  if (kind === 'image') {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    await new Promise((ok) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(ok);
      });
    });
  }
  const b = el.getBoundingClientRect();
  const box: Rect =
    kind === 'image'
      ? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
      : { x: el.clientLeft, y: el.clientTop, w: el.clientWidth, h: el.clientHeight };
  const outer: Rect =
    kind === 'image' ? box : { x: 0, y: 0, w: el.offsetWidth, h: el.offsetHeight };
  return {
    rect: { x: b.left, y: b.top, w: b.width, h: b.height },
    dpr: window.devicePixelRatio || 1,
    saved: before,
    box,
    outer,
  };
}
