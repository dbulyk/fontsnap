/**
 * The other function that FontSnap hands to chrome.scripting.executeScript({ func }) (the first is measureImage in measure.ts): step 1
 * of reading the image that was right-clicked. It runs in the isolated world of the frame where the click happened, which is the
 * web page's process, outside the CSP of the extension, so it is held to the rules of the content script (eslint.config.js,
 * PAGE_PROCESS_GLOBS) with ONE exception that nothing else has: `new Image()` with `crossOrigin = 'anonymous'` and a single
 * `<image>.src = src`, where `src` is the first parameter - the srcUrl of the click and no other address (DOM_MEMBERS.fromParameter).
 * It returns the pixels as a PNG data URL, or null; they go to the service worker as the result of executeScript and nowhere else.
 */
// Runs inside the page (serialized by chrome.scripting): it may not touch anything from this module.
export async function loadImagePixels(src: string): Promise<string | null> {
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
      return `data:image/png;base64,${btoa(text)}`;
    } catch {
      return null;
    }
  };
  const known = [...document.images].find((i) => i.currentSrc === src || i.src === src);
  if (known?.complete) {
    const pixels = await draw(known);
    if (pixels !== null) return pixels;
  }
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = src;
  try {
    await image.decode();
  } catch {
    return null;
  }
  return draw(image);
}
