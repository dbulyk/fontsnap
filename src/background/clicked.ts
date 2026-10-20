// "Identify font in this image": the image that was right-clicked, as pixels. A ladder, each step entered only when the one above it
// produced no pixels (or failed):
//   1. the pixels are loaded in the frame of the click (loadImagePixels, load-image.ts): the element that is drawn, or the srcUrl
//      loaded again with CORS;
//   2. a crop of a screenshot, by the box of the image × devicePixelRatio, with the scroll position put back (measureImage);
//   3. the whole visible area, with a hint on the result page.
// The pixels reach nobody but this worker (the result of executeScript); every address handed to a page is the srcUrl of the click.
import { frameRect, validRect, type CaptureEntry, type Rect } from '../shared/capture';
import { errorMessage } from '../shared/errors';
import { loadImagePixels } from './load-image';
import { measureImage, type MeasuredImage } from './measure';
import { base64ToDataUrl, cropToDataUrl, decodeDataImage, reencodeWithinQuota } from './shot';

export interface ClickedImageInfo {
  srcUrl: string;
  /** The frame the click happened in; the top frame when absent. */
  frameId?: number | undefined;
  frameUrl?: string | undefined;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// A page that does not answer (an image on a slow server, a frame whose animation frames are throttled) must not keep the worker from
// opening the result tab: the loader may take a while to download, a measurement is a few frames.
const LOAD_TIMEOUT_MS = 20_000;
const MEASURE_TIMEOUT_MS = 5_000;
// The last step has nothing after it, and captureVisibleTab fails now and then for no reason of the page's ("Failed to capture tab:
// image readback failed", the compositor has not painted the tab yet): it is tried a few times before the error reaches the user.
const CAPTURE_ATTEMPTS = 3;
const CAPTURE_RETRY_MS = 300;

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('The page did not answer'));
    }, ms);
    promise
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
      })
      .catch(() => undefined);
  });
}

/** The screenshot of the visible area, taken again after a short pause when the browser fails to read it back. */
async function captureWithRetry(windowId: number): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (e) {
      if (attempt >= CAPTURE_ATTEMPTS) throw e;
      await new Promise((ok) => setTimeout(ok, CAPTURE_RETRY_MS));
    }
  }
}

async function measure(
  tabId: number,
  frameId: number,
  target: string,
  kind: 'image' | 'frame',
  saved: readonly number[] | null,
): Promise<MeasuredImage | null> {
  const [first] = await within(
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      args: [target, kind, saved],
      func: measureImage,
    }),
    MEASURE_TIMEOUT_MS,
  );
  return first?.result ?? null;
}

/**
 * Step 2. The positions of every scroller are recorded before the image is scrolled into view and written back in `finally`, also
 * when the screenshot or the crop fails. An image in an iframe is measured in the viewport of its frame and moved by the position of
 * the `<iframe>` in the top frame (found by the frame URL, which has to name exactly one); anything that cannot be known throws.
 * @throws {Error} when the image cannot be measured, or is outside the screenshot
 */
async function croppedFromScreenshot(
  tab: chrome.tabs.Tab,
  tabId: number,
  info: ClickedImageInfo,
): Promise<string> {
  const frameId = info.frameId ?? 0;
  const restores: (() => Promise<unknown>)[] = [];
  try {
    let frame: MeasuredImage | null = null;
    if (frameId !== 0) {
      if (!info.frameUrl) throw new Error('The frame of the image is not known');
      const frameUrl = info.frameUrl;
      frame = await measure(tabId, 0, frameUrl, 'frame', null);
      if (!frame) throw new Error('The frame of the image was not found');
      const baseline = frame.saved;
      restores.push(() => measure(tabId, 0, frameUrl, 'frame', baseline));
    }
    const image = await measure(tabId, frameId, info.srcUrl, 'image', null);
    if (!image) throw new Error('Could not access this image');
    const saved = image.saved;
    restores.push(() => measure(tabId, frameId, info.srcUrl, 'image', saved));
    let rect: Rect = image.rect;
    if (frame && info.frameUrl) {
      // the frame may have moved with the scroll that brought the image into view
      const moved = await measure(tabId, 0, info.frameUrl, 'frame', null);
      if (!moved) throw new Error('The frame of the image was not found');
      // throws when the frame found by its URL is not the frame of the click (the same address can be a nested frame of another
      // frame) and when the frame has padding
      rect = frameRect(image.rect, image.box, moved.rect, moved.box, moved.outer);
    }
    if (!validRect(rect)) throw new Error('Could not access this image');
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return await cropToDataUrl(shot, rect, image.dpr);
  } finally {
    for (const restore of restores.reverse()) await restore().catch(() => undefined);
  }
}

/** The capture entry for the right-clicked image; never rejects: a failure is an entry with an error. */
export async function clickedImage(
  info: ClickedImageInfo,
  tab: chrome.tabs.Tab | undefined,
): Promise<CaptureEntry> {
  const decoded = await decodeDataImage(info.srcUrl);
  if (decoded !== undefined) return { dataUrl: decoded, text: '' };
  if (tab?.id === undefined) return { error: 'Could not access this image' };
  const tabId = tab.id;
  const frameId = info.frameId ?? 0;
  try {
    // the target and the arguments of this call are fixed by lint (fontsnap/execute-script) and by verify-dist: one frame, and the srcUrl
    const [first] = await within(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        args: [info.srcUrl],
        func: loadImagePixels,
      }),
      LOAD_TIMEOUT_MS,
    );
    const pixels = first?.result;
    if (typeof pixels === 'string' && BASE64.test(pixels)) {
      return { dataUrl: await reencodeWithinQuota(base64ToDataUrl(pixels, 'image/png')), text: '' };
    }
  } catch {
    // the page refused the script, the image is not readable, or it did not decode: the screenshot is next
  }
  try {
    return { dataUrl: await croppedFromScreenshot(tab, tabId, info), text: '' };
  } catch {
    // not found, not scriptable, outside the screenshot: the whole visible area is next
  }
  try {
    const shot = await captureWithRetry(tab.windowId);
    return { dataUrl: await reencodeWithinQuota(shot), text: '', note: 'whole-view' };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}
