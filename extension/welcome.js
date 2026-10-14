// Welcome page: show pin instructions until FontSnap is pinned, then usage. Priority:
// manual choice (#pin / #usage) > live chrome.action.getUserSettings() > ?pinned= from the service worker > pin.
import { applyI18n } from './lib/i18n.js';
applyI18n();
const body = document.body;
const manual = () => (['#pin', '#usage'].includes(location.hash) ? location.hash.slice(1) : null);
const fromQuery = new URLSearchParams(location.search).get('pinned') === '1' ? 'usage' : 'pin';
let live = null;
const render = () => (body.dataset.mode = manual() || live || fromQuery);
async function poll() {
  if (document.hidden) return;
  try {
    live = (await chrome.action.getUserSettings()).isOnToolbar ? 'usage' : 'pin';
  } catch {
    live = null;
  }
  render();
}
render();
poll();
const timer = setInterval(poll, 1500);
document.addEventListener('visibilitychange', poll);
window.addEventListener('hashchange', render);
chrome.action.onUserSettingsChanged?.addListener(poll);
window.addEventListener('pagehide', () => clearInterval(timer));
