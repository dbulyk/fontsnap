import { readFileSync } from 'node:fs';
import { expect, openResultPage, test } from './fixtures';

// What Chrome actually loaded, asked of the running extension: the permissions, the CSP and the cross-origin
// isolation that onnxruntime-web needs are in force, not only written in a file. (The e2e build differs from the
// release build by its loopback host permission; verify-dist and the unit tests hold the release manifest.)
const VERSION = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;

test('the loaded extension has the permissions, CSP and policies FontSnap promises', async ({
  serviceWorker,
}) => {
  const manifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.version).toBe(VERSION);
  expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'storage', 'contextMenus']);
  expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*']);
  expect(manifest.optional_permissions).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
  expect(manifest.content_security_policy).toEqual({
    extension_pages:
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; object-src 'none'; base-uri 'none'",
  });
  expect(manifest.cross_origin_embedder_policy).toEqual({ value: 'credentialless' });
  expect(manifest.cross_origin_opener_policy).toEqual({ value: 'same-origin' });
});

test('the toolbar action has the Alt+Shift+F shortcut', async ({ serviceWorker }) => {
  const commands = await serviceWorker.evaluate(() => chrome.commands.getAll());
  expect(commands.find((command) => command.name === '_execute_action')?.shortcut).toBe(
    'Alt+Shift+F',
  );
});

test('the result page is cross-origin isolated, which gives onnxruntime its threads', async ({
  context,
  extensionId,
}) => {
  const page = await openResultPage(context, extensionId);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');
});
