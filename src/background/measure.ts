import type { Rect } from '../shared/capture';

/**
 * The one function that FontSnap hands to chrome.scripting.executeScript({ func }). It is serialized and runs in the web page's
 * process, where the CSP of the extension does not apply, so it lives alone in this file, held to the rules of the content script
 * (eslint.config.js, PAGE_PROCESS_FILES: no computed access, no casts, `document` only as `document.images`, `window` only as
 * `window.devicePixelRatio`) and is the only function the lint accepts as `func`.
 */
export interface MeasuredImage {
  rect: Rect;
  dpr: number;
}

// Runs inside the page (serialized by chrome.scripting): it may not touch anything from this module.
export async function measureImage(src: string): Promise<MeasuredImage | null> {
  const img = [...document.images].find((i) => i.currentSrc === src || i.src === src);
  if (!img) return null;
  img.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  await new Promise((ok) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(ok);
    });
  });
  const b = img.getBoundingClientRect();
  return {
    rect: { x: b.left, y: b.top, w: b.width, h: b.height },
    dpr: window.devicePixelRatio || 1,
  };
}
