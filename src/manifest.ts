import { BACKGROUND_FILE } from './shared/constants';

export interface ManifestOptions {
  /** Single source of truth is package.json; callers pass it in. */
  version: string;
  /** Test build: adds a loopback host permission that stands in for a toolbar click (activeTab). */
  e2e?: boolean;
}

/**
 * The extension-page CSP, character for character (compared as a string everywhere, never "contains").
 * `'wasm-unsafe-eval'` is the one deliberate exception to the template's no-WebAssembly rule: onnxruntime-web
 * compiles its WASM runtime on the result page. It allows WebAssembly only, not eval()/new Function(), and
 * there is no remote source. Loosening this needs a reason (see "Exceptions" in README.md).
 *
 * Everything not named falls back to `default-src 'self'`: no image, frame, media, prefetch or worker from anywhere else. Outside
 * the extension only the Google Fonts previews of the result page are let in: the stylesheet (`style-src`, a <link> to
 * fonts.googleapis.com) and the font files it names (`font-src`, fonts.gstatic.com); no 'unsafe-inline', so no <style> and no
 * style="" attribute (the code sets styles through CSSOM, which is not blocked). `connect-src 'self'` keeps every request inside
 * the extension. No `img-src` and no `worker-src`: nothing loads an image from a data: or blob: URL (the crop is decoded into a
 * canvas by src/shared/data-url.ts) and the runtime's workers are files of the extension, so the fallbacks are exactly right.
 * `form-action` and `frame-ancestors` are not set: no page has a form, and no page of the extension can be framed (nothing is
 * web_accessible).
 */
export const EXTENSION_PAGES_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; object-src 'none'; base-uri 'none'";

export function buildManifest({
  version,
  e2e = false,
}: ManifestOptions): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: '__MSG_appName__',
    short_name: 'FontSnap',
    version,
    description: '__MSG_appDesc__',
    default_locale: 'en',
    // activeTab + scripting: the selection overlay (select.js) is injected on demand, only into the tab the
    // user invoked FontSnap on, and captureVisibleTab works on that tab. storage: chrome.storage.session
    // hands the cropped image from the service worker to the result page. contextMenus: "identify font in
    // this image" and "in a region". No host permissions, no install-time "read all your data" warning.
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus'],
    ...(e2e ? { host_permissions: ['http://127.0.0.1/*'] } : {}),
    background: { service_worker: BACKGROUND_FILE, type: 'module' },
    action: {
      default_title: '__MSG_actionTitle__',
      default_icon: {
        '16': 'icons/icon-16.png',
        '32': 'icons/icon-32.png',
        '48': 'icons/icon-48.png',
      },
    },
    icons: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '64': 'icons/icon-64.png',
      '96': 'icons/icon-96.png',
      '128': 'icons/icon-128.png',
    },
    commands: {
      _execute_action: { suggested_key: { default: 'Alt+Shift+F' } },
    },
    content_security_policy: { extension_pages: EXTENSION_PAGES_CSP },
    // Cross-origin isolation (SharedArrayBuffer → multithreaded WASM) while Google Fonts previews still load.
    cross_origin_embedder_policy: { value: 'credentialless' },
    cross_origin_opener_policy: { value: 'same-origin' },
  };
}
