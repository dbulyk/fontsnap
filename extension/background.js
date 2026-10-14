// FontSnap service worker: start region selection, capture the visible tab, hand the crop to result.html.
async function startSelect(tab) {
  if (!tab?.id || /^(chrome|edge|about|chrome-extension):/.test(tab.url || '') || (tab.url || '').startsWith('https://chrome.google.com/webstore')) {
    return chrome.tabs.create({ url: chrome.runtime.getURL('result.html') }); // restricted page: open upload mode
  }
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['select.js'] }); }
  catch (e) { chrome.tabs.create({ url: chrome.runtime.getURL('result.html') }); }
}
chrome.action.onClicked.addListener(startSelect);
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'fontsnap-select', title: 'FontSnap: identify font in a region', contexts: ['page', 'image', 'selection', 'link'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'fontsnap-select') startSelect(tab); });
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'fontsnap-rect' || !sender.tab) return;
  (async () => {
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    const id = 'cap_' + Date.now();
    await chrome.storage.session.set({ [id]: { dataUrl, rect: msg.rect, dpr: msg.dpr, text: msg.text || '', pageUrl: sender.tab.url } });
    chrome.tabs.create({ url: chrome.runtime.getURL('result.html#' + id), index: sender.tab.index + 1 });
  })();
});
