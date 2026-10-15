// FontSnap service worker: start region selection, capture the visible tab, crop it, hand the crop to result.html.
// The screenshot never leaves the browser: it is cropped here and passed via chrome.storage.session (trusted contexts only).
import {
  MAX_CROP_SIDE,
  MAX_IMAGE_BYTES,
  assertFitsSessionQuota,
  clipCropRect,
  errorResultHash,
  newCaptureId,
  planOpenResult,
  scaleToMaxSide,
  validRect,
} from './lib/capture.js';

const RESTRICTED =
  /^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-search):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;
const resultUrl = (hash = '') => chrome.runtime.getURL('result.html') + hash;

async function startSelect(tab) {
  if (!tab?.id || RESTRICTED.test(tab.url || '')) return chrome.tabs.create({ url: resultUrl() });
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['select.js'] });
  } catch {
    chrome.tabs.create({ url: resultUrl() }); // e.g. file:// without access or PDF viewer: fall back to upload mode
  }
}

function bytesToDataUrl(buf, type) {
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${type};base64,` + btoa(s);
}

async function cropToDataUrl(dataUrl, rect, dpr) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const { x, y, w, h } = clipCropRect(rect, dpr, bmp.width, bmp.height);
  const sized = scaleToMaxSide(w, h, MAX_CROP_SIDE);
  const cv = new OffscreenCanvas(sized.width, sized.height);
  cv.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, sized.width, sized.height);
  bmp.close();
  const out = bytesToDataUrl(new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer()), 'image/png');
  assertFitsSessionQuota(out);
  return out;
}

// Right-click on an image: analyse that image. First try to download it (works for data: URLs and
// CORS-enabled images); otherwise screenshot the tab and crop to the image's on-screen box (activeTab).
async function imageToDataUrl(srcUrl, tab) {
  try {
    const r = await fetch(srcUrl, { credentials: 'omit' });
    const blob = r.ok ? await r.blob() : null;
    if (blob && blob.type.startsWith('image/') && blob.type !== 'image/svg+xml' && blob.size < MAX_IMAGE_BYTES) {
      await createImageBitmap(blob).then((b) => b.close()); // decodable?
      const dataUrl = bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type);
      assertFitsSessionQuota(dataUrl);
      return dataUrl;
    }
  } catch {
    // CORS / network: fall back to a screenshot of the image
  }
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [srcUrl],
    func: async (src) => {
      const img = [...document.images].find((i) => i.currentSrc === src || i.src === src);
      if (!img) return null;
      img.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      const b = img.getBoundingClientRect();
      return { rect: { x: b.left, y: b.top, w: b.width, h: b.height }, dpr: window.devicePixelRatio || 1 };
    },
  });
  if (!result || !validRect(result.rect)) throw new Error('Could not access this image');
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  return cropToDataUrl(shot, result.rect, result.dpr);
}

/** Store the capture (or error) and always open a result tab — never fail silently on quota/storage errors. */
async function openResult(entry, tab) {
  const id = newCaptureId();
  let storeOk = false;
  let storeError;
  try {
    if (entry?.dataUrl) assertFitsSessionQuota(entry.dataUrl);
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
      hash = errorResultHash(planned.entry.error);
    }
  }
  await chrome.tabs.create({ url: resultUrl('#' + hash), ...(tab ? { index: tab.index + 1 } : {}) });
}

async function handleRectMessage(msg, tab) {
  let entry;
  try {
    const dpr = Number.isFinite(msg.dpr) && msg.dpr > 0 ? msg.dpr : 1;
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    entry = { dataUrl: await cropToDataUrl(shot, msg.rect, dpr), text: String(msg.text || '').slice(0, 80) };
  } catch (e) {
    entry = { error: String(e?.message || e) };
  }
  await openResult(entry, tab);
}

async function openWelcome() {
  let pinned = false;
  try {
    pinned = !!(await chrome.action.getUserSettings()).isOnToolbar;
  } catch {
    // getUserSettings needs Chrome 91+; default to the pin instructions
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(`welcome.html?pinned=${pinned ? 1 : 0}`) });
}

chrome.action.onClicked.addListener((tab) => {
  void startSelect(tab);
});
chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'fontsnap-image',
      title: chrome.i18n.getMessage('ctxImage'),
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: 'fontsnap-select',
      title: chrome.i18n.getMessage('ctxSelect'),
      contexts: ['page', 'selection', 'link'],
    });
  });
  // Welcome page (internal, no hosting): only on a fresh install. Avoid setTimeout — it does not keep the SW alive.
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) void openWelcome();
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'fontsnap-select') void startSelect(tab);
  else if (info.menuItemId === 'fontsnap-image' && info.srcUrl) {
    // Keep the SW alive across fetch/crop/storage by chaining the whole async path.
    void imageToDataUrl(info.srcUrl, tab)
      .then((dataUrl) => openResult({ dataUrl, text: '' }, tab))
      .catch((e) => openResult({ error: String(e?.message || e) }, tab));
  }
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // only accept messages from our own content script running in a tab
  if (sender.id !== chrome.runtime.id || !sender.tab || msg?.type !== 'fontsnap-rect' || !validRect(msg.rect)) return;
  // return true so Chrome keeps the SW alive until sendResponse runs (covers the gap after captureVisibleTab).
  handleRectMessage(msg, sender.tab)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
