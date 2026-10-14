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

async function cropToDataUrl(dataUrl, rect, dpr) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const x = Math.max(0, Math.round(rect.x * dpr));
  const y = Math.max(0, Math.round(rect.y * dpr));
  const w = Math.min(Math.round(rect.w * dpr), bmp.width - x);
  const h = Math.min(Math.round(rect.h * dpr), bmp.height - y);
  if (w < 4 || h < 4) throw new Error('Selection is outside the visible area');
  const cv = new OffscreenCanvas(w, h);
  cv.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  bmp.close();
  const buf = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return 'data:image/png;base64,' + btoa(s);
}

function validRect(r) {
  return r && [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) && r.w > 0 && r.h > 0;
}

chrome.action.onClicked.addListener(startSelect);
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'fontsnap-select',
    title: 'FontSnap: identify font in a region',
    contexts: ['page', 'image', 'selection', 'link'],
  });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'fontsnap-select') startSelect(tab);
});
chrome.runtime.onMessage.addListener((msg, sender) => {
  // only accept messages from our own content script running in a tab
  if (sender.id !== chrome.runtime.id || !sender.tab || msg?.type !== 'fontsnap-rect' || !validRect(msg.rect)) return;
  (async () => {
    const id = 'cap_' + Date.now();
    let entry;
    try {
      const dpr = Number.isFinite(msg.dpr) && msg.dpr > 0 ? msg.dpr : 1;
      const shot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
      entry = { dataUrl: await cropToDataUrl(shot, msg.rect, dpr), text: String(msg.text || '').slice(0, 80) };
    } catch (e) {
      entry = { error: String(e?.message || e) };
    }
    await chrome.storage.session.set({ [id]: entry });
    chrome.tabs.create({ url: resultUrl('#' + id), index: sender.tab.index + 1 });
  })();
});
