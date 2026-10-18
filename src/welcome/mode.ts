export type WelcomeMode = 'pin' | 'usage';

/**
 * Which part of the welcome page to show. Priority: manual choice (#pin / #usage) > live
 * chrome.action.getUserSettings() > ?pinned= from the service worker > pin.
 */
export function pickMode(input: {
  hash: string;
  live: WelcomeMode | null;
  search: string;
}): WelcomeMode {
  const manual = input.hash === '#pin' || input.hash === '#usage' ? input.hash.slice(1) : null;
  const fromQuery = new URLSearchParams(input.search).get('pinned') === '1' ? 'usage' : 'pin';
  return (manual as WelcomeMode | null) ?? input.live ?? fromQuery;
}
