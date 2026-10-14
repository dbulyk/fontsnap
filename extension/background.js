// FontSnap service worker: start region selection, capture the visible tab, crop it, hand the crop to result.html.
// The screenshot never leaves the browser: it is cropped here and passed via chrome.storage.session (trusted contexts only).
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
  const x = Math.max(0, Math.round(rect.x * dpr));
  const y = Math.max(0, Math.round(rect.y * dpr));
  const w = Math.min(Math.round((rect.w + Math.min(0, rect.x)) * dpr), bmp.width - x);
  const h = Math.min(Math.round((rect.h + Math.min(0, rect.y)) * dpr), bmp.height - y);
  if (w < 4 || h < 4) throw new Error('Selection is outside the visible area');
  const cv = new OffscreenCanvas(w, h);
  cv.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  bmp.close();
  return bytesToDataUrl(new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer()), 'image/png');
}

// Right-click on an image: analyse that image. First try to download it (works for data: URLs and
// CORS-enabled images); otherwise screenshot the tab and crop to the image's on-screen box (activeTab).
const MAX_IMAGE_BYTES = 25e6;
async function imageToDataUrl(srcUrl, tab) {
  try {
    const r = await fetch(srcUrl, { credentials: 'omit' });
    const blob = r.ok ? await r.blob() : null;
    if (blob && blob.type.startsWith('image/') && blob.type !== 'image/svg+xml' && blob.size < MAX_IMAGE_BYTES) {
      await createImageBitmap(blob).then((b) => b.close()); // decodable?
      return bytesToDataUrl(new Uint8Array(await blob.arrayBuffer()), blob.type);
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

async function openResult(entry, tab) {
  const id = 'cap_' + Date.now();
  await chrome.storage.session.set({ [id]: entry });
  chrome.tabs.create({ url: resultUrl('#' + id), ...(tab ? { index: tab.index + 1 } : {}) });
}

function validRect(r) {
  return r && [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) && r.w > 0 && r.h > 0;
}

chrome.action.onClicked.addListener(startSelect);
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
  // Welcome page (internal, no hosting): only on a fresh install. Pinned state is re-checked live by welcome.js.
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    setTimeout(async () => {
      let pinned = false;
      try {
        pinned = !!(await chrome.action.getUserSettings()).isOnToolbar;
      } catch {
        // getUserSettings needs Chrome 91+; default to the pin instructions
      }
      chrome.tabs.create({ url: chrome.runtime.getURL(`welcome.html?pinned=${pinned ? 1 : 0}`) });
    }, 1000);
  }
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'fontsnap-select') startSelect(tab);
  else if (info.menuItemId === 'fontsnap-image' && info.srcUrl) {
    imageToDataUrl(info.srcUrl, tab)
      .then((dataUrl) => openResult({ dataUrl, text: '' }, tab))
      .catch((e) => openResult({ error: String(e?.message || e) }, tab));
  }
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  // only accept messages from our own content script running in a tab
  if (sender.id !== chrome.runtime.id || !sender.tab || msg?.type !== 'fontsnap-rect' || !validRect(msg.rect)) return;
  (async () => {
    let entry;
    try {
      const dpr = Number.isFinite(msg.dpr) && msg.dpr > 0 ? msg.dpr : 1;
      const shot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      entry = { dataUrl: await cropToDataUrl(shot, msg.rect, dpr), text: String(msg.text || '').slice(0, 80) };
    } catch (e) {
      entry = { error: String(e?.message || e) };
    }
    await openResult(entry, sender.tab);
  })();
});
