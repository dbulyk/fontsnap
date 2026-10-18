/** Built file names referenced from several places (manifest, injection, Vite, build checks). */
export const CONTENT_SCRIPT_FILE = 'select.js';
export const BACKGROUND_FILE = 'background.js';

/**
 * The pages of the extension, name → HTML file relative to src/. The ONE declared list: the manifest,
 * the build inputs, verify-dist and the page tests all read it. To add a page (side panel, offscreen
 * document, ...): add it here, create src/<area>/<page>.html + index.ts, run
 * `npm run guards:update` (see "Add a page" in README.md).
 */
export const EXTENSION_PAGES = {
  result: 'result/result.html',
  welcome: 'welcome/welcome.html',
} as const;
