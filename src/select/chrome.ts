import type { MessageKey } from '../shared/i18n';
import type { RequestOf } from '../shared/messages';

// The two things the overlay needs from the extension, written here so that this folder imports nothing but types from the rest
// of src/: the overlay runs in the web page's process (outside the CSP of the extension), and everything that is bundled into
// select.js is held to the rules of src/select (eslint.config.js, PAGE_PROCESS_GLOBS; a test reads the real bundle).

/**
 * The localized text a lookup returned, or an error when there is none, so that mistakes are loud, not blank (as `t` of
 * src/shared/i18n.ts does). The lookup stays at the call site (`chrome.i18n.getMessage('key')`), where check:locales finds the key.
 */
export function nonEmpty(text: string, key: MessageKey): string {
  if (text === '') throw new Error(`Missing i18n message: ${key}`);
  return text;
}

/**
 * Sends the selection to the service worker. The answer is not needed and nothing is raised when there is none (the extension
 * was reloaded, the worker refused the sender): the overlay has already gone.
 */
export async function sendRect(request: RequestOf<'fontsnap-rect'>): Promise<void> {
  try {
    await chrome.runtime.sendMessage(request);
  } catch {
    // no answer needed
  }
}
