/**
 * The other function that FontSnap hands to chrome.scripting.executeScript({ func }) (the first is measureImage in measure.ts): step 1
 * of reading the image that was right-clicked. It runs in the isolated world of the frame where the click happened, which is the
 * web page's process, outside the CSP of the extension, so it is held to the rules of the content script (eslint.config.js,
 * PAGE_PROCESS_GLOBS) with ONE exception that nothing else has: `new Image()` with `crossOrigin = 'anonymous'` and a single
 * `<image>.src = src`, where `src` is the first parameter - the srcUrl of the click and no other address (DOM_MEMBERS.fromParameter).
 * It returns the pixels as a PNG, base64 encoded (the worker makes a data URL of it), plus lang/hint from the DOM image when found;
 * they go to the service worker as the result of executeScript and nowhere else.
 *
 * Everything this function needs must live inside its body: chrome.scripting serializes only this function (Function#toString), so a
 * module-level helper is a ReferenceError in the page and the ladder falls through to a screenshot.
 */
/** What loadImagePixels hands back through executeScript (structured-clone). */
export interface LoadedImagePixels {
  /** PNG bytes as base64, or null when the element was found but the canvas was unreadable. */
  png: string | null;
  lang?: string;
  hint?: string;
}

// Runs inside the page (serialized by chrome.scripting): it may not touch anything from this module.
export async function loadImagePixels(src: string): Promise<LoadedImagePixels | null> {
  const draw = async (image: HTMLImageElement): Promise<string | null> => {
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    if (w < 1 || h < 1) return null;
    const k = Math.min(1, 2400 / Math.max(w, h));
    const canvas = new OffscreenCanvas(
      Math.max(1, Math.round(w * k)),
      Math.max(1, Math.round(h * k)),
    );
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    try {
      // a canvas that was given a picture of another origin without CORS refuses to hand its pixels over (SecurityError)
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      let text = '';
      for (const byte of new Uint8Array(await blob.arrayBuffer()))
        text += String.fromCharCode(byte);
      return btoa(text);
    } catch {
      return null;
    }
  };
  const attachHints = (out: LoadedImagePixels, el: HTMLImageElement): void => {
    const alt = el.getAttribute('alt') ?? '';
    const title = el.getAttribute('title') ?? '';
    const hint = (alt !== '' ? alt : title).trim().slice(0, 80);
    let lang = '';
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
      const value = node.lang;
      if (value) {
        lang = value;
        break;
      }
    }
    if (!lang) lang = document.documentElement.lang;
    if (lang) out.lang = lang;
    if (hint) out.hint = hint;
  };
  const known = [...document.images].find((i) => i.currentSrc === src || i.src === src);
  // Draw first (same order as before hints existed), then attach lang/hint from the DOM element.
  if (known?.complete) {
    const pixels = await draw(known);
    if (pixels !== null) {
      const out: LoadedImagePixels = { png: pixels };
      attachHints(out, known);
      return out;
    }
  }
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = src;
  try {
    await image.decode();
  } catch {
    if (known) {
      const out: LoadedImagePixels = { png: null };
      attachHints(out, known);
      return out;
    }
    return null;
  }
  const pixels = await draw(image);
  if (pixels !== null) {
    const out: LoadedImagePixels = { png: pixels };
    if (known) attachHints(out, known);
    return out;
  }
  if (known) {
    const out: LoadedImagePixels = { png: null };
    attachHints(out, known);
    return out;
  }
  return null;
}
