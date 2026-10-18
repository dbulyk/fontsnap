import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Worker } from '@playwright/test';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { expect, isExtensionPage, isWelcomePage, test } from './fixtures';

/** URLs of all tabs that show the welcome page, as the extension's service worker sees them. */
async function welcomeTabUrls(serviceWorker: Worker): Promise<string[]> {
  // Asked of the browser itself: an extension sees the URL of its own tabs without the "tabs" permission.
  const urls = await serviceWorker.evaluate(async () =>
    (await chrome.tabs.query({})).flatMap((tab) => (tab.url === undefined ? [] : [tab.url])),
  );
  return urls.filter((url) => isExtensionPage(url, EXTENSION_PAGES.welcome));
}

/** The running service worker of the given extension version, or undefined if it has not started. */
async function workerOfVersion(
  context: BrowserContext,
  version: string,
): Promise<Worker | undefined> {
  for (const worker of context.serviceWorkers()) {
    // A worker of the replaced version may already be gone; it is simply not the one we look for.
    const running = await worker
      .evaluate(() => chrome.runtime.getManifest().version)
      .catch(() => undefined);
    if (running === version) return worker;
  }
  return undefined;
}

/** Waits for the service worker of the given extension version to run, and returns it. */
async function waitForWorkerOfVersion(context: BrowserContext, version: string): Promise<Worker> {
  let found: Worker | undefined;
  await expect
    .poll(
      async () => {
        found = await workerOfVersion(context, version);
        return found !== undefined;
      },
      { message: `the service worker of version ${version} starts` },
    )
    .toBe(true);
  if (found === undefined) throw new Error(`No service worker of version ${version}.`);
  return found;
}

/** Reloads the unpacked extension from `dir`, as Chrome does for an update; returns its id. */
async function reloadUnpacked(context: BrowserContext, dir: string): Promise<string> {
  // Extensions.* is a browser-level domain: a page's CDP session answers "Method not available".
  const browser = context.browser();
  if (browser === null) throw new Error('The persistent context has no browser.');
  const cdp = await browser.newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: dir });
  await cdp.detach();
  return id;
}

test.describe('English UI', () => {
  test.use({ uiLocale: 'en' });

  test('a fresh install opens the welcome page, in English, with the pin instructions', async ({
    welcomePage,
  }) => {
    expect(isWelcomePage(welcomePage)).toBe(true);
    await expect(welcomePage.locator('h1')).toHaveText('FontSnap is installed');
    await expect(welcomePage).toHaveTitle('FontSnap is installed');
    await expect(welcomePage.locator('html')).toHaveAttribute('lang', /^en/);
    await expect(welcomePage.locator('html')).not.toHaveAttribute('dir', 'rtl');
    await expect(welcomePage.locator('body')).toHaveAttribute('data-mode', 'pin');
    await expect(
      welcomePage.getByRole('heading', { name: 'Pin FontSnap to the toolbar' }),
    ).toBeVisible();
  });

  test('is opened with ?pinned=0: FontSnap is not on the toolbar yet', ({ welcomePage }) => {
    expect(new URL(welcomePage.url()).search).toBe('?pinned=0');
  });

  test('switches between the pin and the usage instructions with its links', async ({
    welcomePage,
  }) => {
    await welcomePage.getByRole('link', { name: 'Already pinned? Show how to use it' }).click();
    await expect(welcomePage.locator('body')).toHaveAttribute('data-mode', 'usage');
    await expect(
      welcomePage.getByRole('heading', { name: 'How to identify a font' }),
    ).toBeVisible();
    await welcomePage.getByRole('link', { name: 'How to pin FontSnap' }).click();
    await expect(welcomePage.locator('body')).toHaveAttribute('data-mode', 'pin');
  });

  test('its "Try it now" link leads to the result page in upload mode', async ({
    welcomePage,
    extensionId,
  }) => {
    await welcomePage.getByRole('link', { name: 'Already pinned? Show how to use it' }).click();
    await welcomePage.locator('#try').click();
    await expect(welcomePage).toHaveURL(
      `chrome-extension://${extensionId}/${EXTENSION_PAGES.result}`,
    );
    await expect(welcomePage.locator('#status')).toHaveText(
      'Ready. Paste, drop or choose an image.',
      {
        timeout: 60_000,
      },
    );
  });
});

test.describe('Russian UI', () => {
  test.use({ uiLocale: 'ru' });

  test('the welcome page is in Russian', async ({ welcomePage }) => {
    await expect(welcomePage.locator('h1')).toHaveText('FontSnap установлен');
    await expect(welcomePage.locator('html')).toHaveAttribute('lang', /^ru/);
    await expect(
      welcomePage.getByRole('heading', { name: 'Закрепите FontSnap на панели' }),
    ).toBeVisible();
  });
});

test('a fresh install opens exactly one welcome tab', async ({ serviceWorker }) => {
  expect(await welcomeTabUrls(serviceWorker)).toHaveLength(1);
});

test.describe('an update of the extension', () => {
  test.use({ updatable: true });

  test('does not open the welcome tab again', async ({
    context,
    extensionDir,
    extensionId,
    serviceWorker,
    welcomePage,
  }) => {
    await welcomePage.close();
    expect(await welcomeTabUrls(serviceWorker)).toHaveLength(0);

    const manifestPath = join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string };
    // A higher version, so Chrome reports the reload as an update (e.g. 0.1.0 -> 0.1.1).
    const version = manifest.version.replace(/\d+$/, (patch) => String(Number(patch) + 1));
    expect(version).not.toBe(manifest.version);
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version }));
    expect(await reloadUnpacked(context, extensionDir)).toBe(extensionId);

    const worker = await waitForWorkerOfVersion(context, version);
    // The context menus are recreated for every reason: that shows onInstalled ran for the update.
    await expect
      .poll(() => worker.evaluate(() => chrome.runtime.getManifest().version))
      .toBe(version);
    expect(await welcomeTabUrls(worker)).toHaveLength(0);
    expect(context.pages().filter(isWelcomePage)).toHaveLength(0);
  });
});
