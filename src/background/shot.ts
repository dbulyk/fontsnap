// The screenshot path of the service worker: capture → crop → hand the crop to the result page.
// The screenshot never leaves the browser: it is cropped here and passed via chrome.storage.session
// (trusted contexts only), so the full-tab PNG never has to fit the session quota.
import {
  MAX_CROP_SIDE,
  MAX_IMAGE_BYTES,
  assertFitsSessionQuota,
  clipCropRect,
  encodeWithinSessionQuota,
  errorResultHash,
  newCaptureId,
  planOpenResult,
  scaleToMaxSide,
  validRect,
  type CaptureEntry,
  type Rect,
} from '../shared/capture';
import { dataUrlToBlob } from '../shared/data-url';
import { errorMessage } from '../shared/errors';
import { EXTENSION_PAGES } from '../shared/constants';
import type { RequestOf } from '../shared/messages';
import { measureImage } from './measure';

export const resultUrl = (hash = ''): string =>
  chrome.runtime.getURL(EXTENSION_PAGES.result) + hash;

export function bytesToDataUrl(buf: Uint8Array, type: string): string {
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000)
    s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${type};base64,` + btoa(s);
}

export async function cropToDataUrl(dataUrl: string, rect: Rect, dpr: number): Promise<string> {
  const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
  const { x, y, w, h } = clipCropRect(rect, dpr, bmp.width, bmp.height);
  const sized = scaleToMaxSide(w, h, MAX_CROP_SIDE);
  const cv = new OffscreenCanvas(sized.width, sized.height);
  cv.getContext('2d')?.drawImage(bmp, x, y, w, h, 0, 0, sized.width, sized.height);
  bmp.close();
  // Prefer PNG; if it still exceeds session quota after the 2400px side cap, re-encode as JPEG.
  return encodeWithinSessionQuota(async ({ type, quality }) => {
    const blob = await cv.convertToBlob(
      type === 'image/jpeg' && quality !== undefined ? { type, quality } : { type },
    );
    return bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), type);
  });
}

// Right-click on an image: analyse that image. A data: URL is decoded here, without a request. Any other image is read from a
// screenshot of the tab, cropped to the image's on-screen box (activeTab): the CSP of the extension (connect-src 'self',
// src/manifest.ts) applies to this worker too, so the image can not be downloaded from another origin any more.
export async function imageToDataUrl(
  srcUrl: string,
  tab: chrome.tabs.Tab | undefined,
): Promise<string> {
  if (/^data:/i.test(srcUrl)) {
    try {
      const blob = dataUrlToBlob(srcUrl);
      if (
        blob.type.startsWith('image/') &&
        blob.type !== 'image/svg+xml' &&
        blob.size < MAX_IMAGE_BYTES
      ) {
        await createImageBitmap(blob).then((b) => {
          b.close();
        }); // decodable?
        const dataUrl = bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type);
        assertFitsSessionQuota(dataUrl);
        return dataUrl;
      }
    } catch {
      // malformed, not decodable or too big for the session quota: fall back to a screenshot of the image
    }
  }
  if (tab?.id === undefined) throw new Error('Could not access this image');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [srcUrl],
    func: measureImage,
  });
  const result = results[0]?.result;
  if (!result || !validRect(result.rect)) throw new Error('Could not access this image');
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return cropToDataUrl(shot, result.rect, result.dpr);
}

/** Store the capture (or error) and always open a result tab — never fail silently on quota/storage errors. */
export async function openResult(
  entry: CaptureEntry,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  const id = newCaptureId();
  let storeOk = false;
  let storeError: unknown;
  try {
    if (entry.dataUrl) assertFitsSessionQuota(entry.dataUrl);
    await chrome.storage.session.set({ [id]: entry });
    storeOk = true;
  } catch (e) {
    storeError = e;
  }
  const planned = planOpenResult({ entry, storeOk, storeError, id });
  // If storage failed, still try to persist a tiny error entry; otherwise fall back to err= hash (no storage).
  let hash = planned.hash;
  if (!storeOk) {
    try {
      const errId = newCaptureId();
      await chrome.storage.session.set({ [errId]: { error: planned.entry.error } });
      hash = errId;
    } catch {
      hash = errorResultHash(planned.entry.error ?? '');
    }
  }
  await chrome.tabs.create({
    url: resultUrl('#' + hash),
    ...(tab ? { index: tab.index + 1 } : {}),
  });
}

export async function handleRect(
  msg: Pick<RequestOf<'fontsnap-rect'>, 'rect' | 'dpr' | 'text'>,
  tab: chrome.tabs.Tab,
): Promise<void> {
  let entry: CaptureEntry;
  try {
    const dpr = Number.isFinite(msg.dpr) && msg.dpr > 0 ? msg.dpr : 1;
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    entry = { dataUrl: await cropToDataUrl(shot, msg.rect, dpr), text: msg.text.slice(0, 80) };
  } catch (e) {
    entry = { error: errorMessage(e) };
  }
  await openResult(entry, tab);
}
