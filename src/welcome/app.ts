import { EXTENSION_PAGES } from '../shared/constants';
import { applyI18n } from '../shared/i18n';
import { pickMode, type WelcomeMode } from './mode';

/**
 * The page opened once, right after the extension is installed: pin instructions until FontSnap is
 * pinned, then usage instructions.
 */
export function initWelcome(doc: Document): void {
  applyI18n(doc);
  doc.getElementById('try')?.setAttribute('href', chrome.runtime.getURL(EXTENSION_PAGES.result));
  const win = doc.defaultView;
  if (!win) return;
  let live: WelcomeMode | null = null;
  const render = () => {
    doc.body.dataset['mode'] = pickMode({
      hash: win.location.hash,
      live,
      search: win.location.search,
    });
  };
  async function poll(): Promise<void> {
    if (doc.hidden) return;
    try {
      live = (await chrome.action.getUserSettings()).isOnToolbar ? 'usage' : 'pin';
    } catch {
      live = null;
    }
    render();
  }
  const refresh = () => {
    void poll();
  };
  render();
  refresh();
  const timer = setInterval(refresh, 1500);
  doc.addEventListener('visibilitychange', refresh);
  win.addEventListener('hashchange', render);
  if ('onUserSettingsChanged' in chrome.action) {
    chrome.action.onUserSettingsChanged.addListener(refresh);
  }
  win.addEventListener('pagehide', () => {
    clearInterval(timer);
  });
}
