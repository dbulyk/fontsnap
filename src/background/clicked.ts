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
  readonly srcUrl: string;
  /** The frame the click happened in; the top frame when absent. */
  readonly frameId?: number | undefined;
  readonly frameUrl?: string | undefined;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// A page that does not answer (an image on a slow server, a frame whose animation frames are throttled) must not keep the worker from
// opening the result tab: the loader may take a while to download, a measurement is a few frames.
const LOAD_TIMEOUT_MS = 20_000;
const MEASURE_TIMEOUT_MS = 5_000;
// Chrome lets an extension call captureVisibleTab twice a second (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND); a third call within the
// second fails with the quota. Every screenshot of steps 2 and 3 goes through `capture`, which keeps the calls a second apart (so two
// calls never fall in one second, also across two clicks) and takes the picture again, once, when the browser says "image readback
// failed". That error is transient: measured in Chromium (e2e build, 8 browsers and 8 busy loops on 8 cores), a screenshot asked for
// soon after the page changed what it shows fails that way in about a quarter of the runs, 3 in 100 half a second after the change and
// none after a second or after the page had drawn two frames; the second call always worked. The quota, a tab that is not active or a
// page that may not be captured come back every time, so they are not tried again.
const CAPTURE_GAP_MS = 1000;
const READBACK_FAILED = 'image readback failed';
const NOT_IN_FRONT =
  'The tab of the image is no longer in front: go back to it and click the image again';
let lastCaptureAt = 0;

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

/** The screenshot of the visible area of the tab of the click (a data: URL). */
async function capture(tabId: number, windowId: number): Promise<string> {
  let first: unknown;
  try {
    return await captureInTurn(tabId, windowId);
  } catch (e) {
    if (!errorMessage(e).includes(READBACK_FAILED)) throw e;
    first = e;
  }
  try {
    return await captureInTurn(tabId, windowId);
  } catch {
    // the error of the retry is not shown: the read-back failure is what went wrong
    throw first;
  }
}

/** One captureVisibleTab, a second after the one before; the turn is taken before waiting, so clicks at the same time queue up. */
async function captureInTurn(tabId: number, windowId: number): Promise<string> {
  const at = Math.max(Date.now(), lastCaptureAt + CAPTURE_GAP_MS);
  lastCaptureAt = at;
  const wait = at - Date.now();
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  // captureVisibleTab takes whatever tab is in front of the window: while this click waited for its turn, the result tab of an
  // earlier click may have come to the front
  if (!(await chrome.tabs.get(tabId)).active) throw new Error(NOT_IN_FRONT);
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

/** measureImage for an image in the frame of the click, or for an `<iframe>` (kind 'frame') in the top frame of its tab. */
type Measure = (
  target: string,
  kind: 'image' | 'frame',
  saved: readonly number[] | null,
) => Promise<MeasuredImage | true | null>;

/**
 * Step 2. The positions of every scroller are recorded before the image is scrolled into view and written back in `finally`, also
 * when the screenshot or the crop fails. An image in an iframe is measured in the viewport of its frame and moved by the position of
 * the `<iframe>` in the top frame (found by the frame URL, which has to name exactly one); anything that cannot be known throws.
 * @throws {Error} when the image cannot be measured, or is outside the screenshot
 */
async function croppedFromScreenshot(
  measure: Measure,
  shoot: () => Promise<string>,
  { srcUrl, frameId, frameUrl }: { srcUrl: string; frameId: number; frameUrl: string | undefined },
): Promise<string> {
  const find = async (target: string, kind: 'image' | 'frame') => {
    const found = await measure(target, kind, null);
    return found === true ? null : found;
  };
  const restores: (() => Promise<boolean>)[] = [];
  const restore = (target: string, kind: 'image' | 'frame', saved: readonly number[]) => {
    restores.push(async () => (await measure(target, kind, saved)) === true);
  };
  let restored = true;
  let crop: string;
  try {
    let frame: MeasuredImage | null = null;
    if (frameId !== 0) {
      if (!frameUrl) throw new Error('The frame of the image is not known');
      frame = await find(frameUrl, 'frame');
      if (!frame) throw new Error('The frame of the image was not found');
      restore(frameUrl, 'frame', frame.saved);
    }
    const image = await find(srcUrl, 'image');
    if (!image) throw new Error('Could not access this image');
    restore(srcUrl, 'image', image.saved);
    let rect: Rect = image.rect;
    if (frame && frameUrl) {
      // the frame may have moved with the scroll that brought the image into view
      const moved = await find(frameUrl, 'frame');
      if (!moved) throw new Error('The frame of the image was not found');
      // throws when the frame found by its URL is not the frame of the click (the same address can be a nested frame of another
      // frame) and when the frame has padding
      rect = frameRect(image.rect, image.box, moved.rect, moved.box, moved.outer);
    }
    if (!validRect(rect)) throw new Error('Could not access this image');
    const shot = await shoot();
    crop = await cropToDataUrl(shot, rect, image.dpr);
  } finally {
    for (const back of restores.reverse()) restored = (await back().catch(() => false)) && restored;
  }
  // the page is not where the user left it: that is not passed over, and the ladder goes on to the whole visible area with the hint
  if (!restored) throw new Error('The scroll position of the page could not be put back');
  return crop;
}

/** The capture entry for the right-clicked image; never rejects: a failure is an entry with an error. */
export async function clickedImage(
  info: ClickedImageInfo,
  tab: Readonly<chrome.tabs.Tab> | undefined,
): Promise<CaptureEntry> {
  const decoded = await decodeDataImage(info.srcUrl);
  if (decoded !== undefined) return { dataUrl: decoded, text: '' };
  if (tab?.id === undefined) return { error: 'Could not access this image' };
  // every target of executeScript is made of these two, read as they are from the click (fontsnap/execute-script)
  const tabId = tab.id;
  const frameId = info.frameId ?? 0;
  const windowId = tab.windowId;
  const shoot = () => capture(tabId, windowId);
  const measure: Measure = async (target, kind, saved) => {
    const [first] = await within(
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [kind === 'frame' ? 0 : frameId] },
        args: [target, kind, saved],
        func: measureImage,
      }),
      MEASURE_TIMEOUT_MS,
    );
    return first?.result ?? null;
  };
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
    const click = { srcUrl: info.srcUrl, frameId, frameUrl: info.frameUrl };
    return { dataUrl: await croppedFromScreenshot(measure, shoot, click), text: '' };
  } catch {
    // not found, not scriptable, outside the screenshot: the whole visible area is next
  }
  try {
    const shot = await shoot();
    return { dataUrl: await reencodeWithinQuota(shot), text: '', note: 'whole-view' };
  } catch (e) {
    return { error: errorMessage(e) };
  }
}
