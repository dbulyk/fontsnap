import { CONTENT_SCRIPT_FILE, EXTENSION_PAGES, MENU_IMAGE } from '../shared/constants';
import { errorMessage } from '../shared/errors';
import { t } from '../shared/i18n';
import { onMessage } from '../shared/messaging';
import { clickedImage } from './clicked';
import { handleRect, openResult, resultUrl } from './shot';

// Pages a content script cannot run on (and the Web Store, where scripting is forbidden): FontSnap opens
// its result page in upload mode there instead.
const RESTRICTED =
  /^(chrome|edge|about|devtools|view-source|chrome-extension|chrome-search):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/;

const MENU_SELECT = 'fontsnap-select';

async function startSelect(tabId: number | undefined, url: string | undefined): Promise<void> {
  if (!tabId || RESTRICTED.test(url ?? '')) {
    await chrome.tabs.create({ url: resultUrl() });
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_FILE],
    });
  } catch {
    void chrome.tabs.create({ url: resultUrl() }); // e.g. file:// without access or PDF viewer: fall back to upload mode
  }
}

async function openWelcome(): Promise<void> {
  let pinned = false;
  try {
    pinned = (await chrome.action.getUserSettings()).isOnToolbar;
  } catch {
    // getUserSettings needs Chrome 91+; default to the pin instructions
  }
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`${EXTENSION_PAGES.welcome}?pinned=${pinned ? '1' : '0'}`),
  });
}

function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_IMAGE,
      title: t('ctxImage'),
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_SELECT,
      title: t('ctxSelect'),
      contexts: ['page', 'selection', 'link'],
    });
  });
}

/**
 * The service worker: starts region selection, captures and crops the visible tab, hands the crop to the
 * result page, and opens the welcome page on a first install (not on updates). Every listener is registered
 * synchronously at top level so Chrome can wake the worker.
 */
export function registerBackground(): void {
  chrome.action.onClicked.addListener((tab?: chrome.tabs.Tab) => {
    void startSelect(tab?.id, tab?.url);
  });

  chrome.runtime.onInstalled.addListener(({ reason }) => {
    createMenus();
    // Welcome page (internal, no hosting): only on a fresh install. Avoid setTimeout — it does not keep the SW alive.
    if (reason === 'install') void openWelcome();
  });

  // The click and its tab are taken apart in the parameters: every value FontSnap uses is a primitive read once, here, and there is no
  // object left on the way to executeScript that anything could write into (fontsnap/execute-script).
  chrome.contextMenus.onClicked.addListener(
    (
      { menuItemId, srcUrl, frameId = 0, frameUrl }: chrome.contextMenus.OnClickData,
      { id: tabId, windowId, index, url }: Partial<chrome.tabs.Tab> = {},
    ) => {
      if (menuItemId === MENU_SELECT) void startSelect(tabId, url);
      else if (menuItemId === MENU_IMAGE && srcUrl) {
        // Keep the SW alive across the page scripts/crop/storage by chaining the whole async path.
        void clickedImage(srcUrl, frameId, frameUrl, tabId, windowId)
          .then((entry) => openResult(entry, index))
          .catch((e: unknown) => openResult({ error: errorMessage(e) }, index));
      }
    },
  );

  onMessage({
    // Only our own selection overlay (a content script in the top frame of a tab) reaches this handler.
    'fontsnap-rect': async (request, sender) => {
      if (!sender.tab) throw new Error('No tab');
      await handleRect(request, sender.tab);
      return { opened: true };
    },
  });
}
