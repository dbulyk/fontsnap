// "Identify font in this image": the image that was right-clicked, as pixels. A ladder, each step entered only when the one above it
// produced no pixels (or failed):
//   1. the pixels are loaded in the frame of the click (loadImagePixels, load-image.ts): the element that is drawn, or the srcUrl
//      loaded again with CORS;
//   2. a crop of a screenshot, by the box of the image × devicePixelRatio, with the scroll position put back (measureImage);
//   3. the whole visible area, with a hint on the result page.
// The pixels reach nobody but this worker (the result of executeScript); every address handed to a page is the srcUrl of the click.
import {
  frameRect,
  parseHint,
  parseLangTag,
  validRect,
  type CaptureEntry,
  type Rect,
} from '../shared/capture';
import { errorMessage } from '../shared/errors';
import { t } from '../shared/i18n';
import { loadImagePixels } from './load-image';
import { measureImage, type MeasuredImage } from './measure';
import { base64ToDataUrl, cropToDataUrl, decodeDataImage, reencodeWithinQuota } from './shot';

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
  // earlier click may have come to the front, or the tab may have been closed (tabs.get rejects with "No tab with id: N")
  const active = await chrome.tabs.get(tabId).then(
    (tab) => tab.active,
    () => undefined,
  );
  if (active === undefined) throw new Error(t('tabClosed'));
  if (!active) throw new Error(t('tabNotInFront'));
  return chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
}

/** measureImage in one frame, for one kind of element: it measures (`saved` null) or puts the scroll back (`saved` a list). */
type Measure = (
  target: string,
  saved: readonly number[] | null,
) => Promise<MeasuredImage | true | null>;

/**
 * Step 2. The positions of every scroller are recorded before the image is scrolled into view and written back in `finally`, also
 * when the screenshot or the crop fails. An image in an iframe is measured in the viewport of its frame and moved by the position of
 * the `<iframe>` in the top frame (found by the frame URL, which has to name exactly one); anything that cannot be known throws.
 * @throws {Error} when the image cannot be measured, or is outside the screenshot
 */
async function croppedFromScreenshot(
  measureInClickFrame: Measure,
  measureFrameInTop: Measure,
  shoot: () => Promise<string>,
  { srcUrl, frameId, frameUrl }: { srcUrl: string; frameId: number; frameUrl: string | undefined },
): Promise<CaptureEntry> {
  const find = async (measure: Measure, target: string) => {
    const found = await measure(target, null);
    return found === true ? null : found;
  };
  const restores: (() => Promise<boolean>)[] = [];
  const restore = (measure: Measure, target: string, saved: readonly number[]) => {
    restores.push(async () => (await measure(target, saved)) === true);
  };
  let restored = true;
  let entry: CaptureEntry;
  try {
    let frame: MeasuredImage | null = null;
    if (frameId !== 0) {
      if (!frameUrl) throw new Error('The frame of the image is not known');
      frame = await find(measureFrameInTop, frameUrl);
      if (!frame) throw new Error('The frame of the image was not found');
      restore(measureFrameInTop, frameUrl, frame.saved);
    }
    const image = await find(measureInClickFrame, srcUrl);
    if (!image) throw new Error('Could not access this image');
    restore(measureInClickFrame, srcUrl, image.saved);
    let rect: Rect = image.rect;
    if (frame && frameUrl) {
      // the frame may have moved with the scroll that brought the image into view
      const moved = await find(measureFrameInTop, frameUrl);
      if (!moved) throw new Error('The frame of the image was not found');
      // throws when the frame found by its URL is not the frame of the click (the same address can be a nested frame of another
      // frame) and when the frame has padding
      rect = frameRect(image.rect, image.box, moved.rect, moved.box, moved.outer);
    }
    if (!validRect(rect)) throw new Error('Could not access this image');
    const shot = await shoot();
    const lang = parseLangTag(image.lang);
    const hint = parseHint(image.hint);
    entry = {
      dataUrl: await cropToDataUrl(shot, rect, image.dpr),
      text: '',
      ...(lang ? { lang } : {}),
      ...(hint ? { hint } : {}),
    };
  } finally {
    for (const back of restores.reverse()) restored = (await back().catch(() => false)) && restored;
  }
  // the page is not where the user left it: that is not passed over, and the ladder goes on to the whole visible area with the hint
  if (!restored) throw new Error('The scroll position of the page could not be put back');
  return entry;
}

/**
 * The capture entry for the right-clicked image; never rejects: a failure is an entry with an error. Every argument is a primitive
 * that the listener of the context menu read from the click (the tab is undefined when the click has none); the targets and the
 * arguments of executeScript are made of these parameters and nothing else (fontsnap/execute-script).
 */
function withHints(
  entry: CaptureEntry,
  lang: string | undefined,
  hint: string | undefined,
): CaptureEntry {
  return {
    ...entry,
    ...(lang && !entry.lang ? { lang } : {}),
    ...(hint && !entry.hint ? { hint } : {}),
  };
}

export async function clickedImage(
  srcUrl: string,
  frameId: number,
  frameUrl: string | undefined,
  tabId: number | undefined,
  windowId: number | undefined,
): Promise<CaptureEntry> {
  let pageLang: string | undefined;
  let pageHint: string | undefined;

  if (tabId !== undefined && windowId !== undefined) {
    const shoot = () => capture(tabId, windowId);
    const measureInClickFrame: Measure = async (target, saved) => {
      const [first] = await within(
        chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          args: [target, 'image', saved],
          func: measureImage,
        }),
        MEASURE_TIMEOUT_MS,
      );
      return first?.result ?? null;
    };
    // the offset of an <iframe>: the one thing measured in the top frame (Q1)
    const measureFrameInTop: Measure = async (target, saved) => {
      const [first] = await within(
        chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          args: [target, 'frame', saved],
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
          args: [srcUrl],
          func: loadImagePixels,
        }),
        LOAD_TIMEOUT_MS,
      );
      const loaded = first?.result;
      if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
        pageLang = parseLangTag(loaded.lang);
        pageHint = parseHint(loaded.hint);
        const png = loaded.png;
        if (typeof png === 'string' && BASE64.test(png)) {
          return {
            dataUrl: await reencodeWithinQuota(base64ToDataUrl(png, 'image/png')),
            text: '',
            ...(pageLang ? { lang: pageLang } : {}),
            ...(pageHint ? { hint: pageHint } : {}),
          };
        }
      }
    } catch {
      // the page refused the script, the image is not readable, or it did not decode: data:/screenshot next
    }
    const decoded = await decodeDataImage(srcUrl);
    if (decoded !== undefined) {
      return withHints({ dataUrl: decoded, text: '' }, pageLang, pageHint);
    }
    try {
      const click = { srcUrl, frameId, frameUrl };
      return await croppedFromScreenshot(measureInClickFrame, measureFrameInTop, shoot, click);
    } catch {
      // not found, not scriptable, outside the screenshot: the whole visible area is next
    }
    try {
      const shot = await shoot();
      return withHints(
        { dataUrl: await reencodeWithinQuota(shot), text: '', note: 'whole-view' },
        pageLang,
        pageHint,
      );
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  const decoded = await decodeDataImage(srcUrl);
  if (decoded !== undefined) return { dataUrl: decoded, text: '' };
  return { error: 'Could not access this image' };
}
