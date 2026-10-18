import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as playwright from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { renderSitePage } from './site-data';

export const expect = playwright.expect;

export type UiLocale = 'en' | 'ru' | 'ar' | 'he' | 'fa';

interface TestFixtures {
  /** The unpacked extension the browser loads: dist-e2e itself, or a private copy (see `updatable`). */
  extensionDir: string;
  context: BrowserContext;
  /** The welcome tab that installing the extension opens (it stays open in the background). */
  welcomePage: Page;
  serviceWorker: Worker;
  extensionId: string;
}

interface WorkerFixtures {
  /** Origin of this worker's own static server (free port, so parallel workers never collide). */
  siteUrl: string;
}

interface Options {
  /** Browser UI language; drives chrome.i18n and therefore the extension's locale. */
  uiLocale: UiLocale;
  /**
   * Load a private copy of dist-e2e and allow `Extensions.loadUnpacked` over CDP, so a test can change
   * the copy's manifest and reload it as an update. dist-e2e itself is never modified.
   */
  updatable: boolean;
}

const EXTENSION_DIR = resolve(import.meta.dirname, '../../dist-e2e');
const headless = process.env['PW_HEADLESS'] === '1';

/** True for the page of the welcome tab, whichever extension id it was loaded under (the query is ignored). */
export function isWelcomePage(page: Page): boolean {
  return isExtensionPage(page.url(), EXTENSION_PAGES.welcome);
}

/** True when `url` is the page `path` (relative to the extension root) of some extension. */
export function isExtensionPage(url: string, path: string): boolean {
  return url.startsWith('chrome-extension://') && new URL(url).pathname === `/${path}`;
}

/** The welcome tab of each browser context, as found right after installation. */
const welcomeTabs = new WeakMap<BrowserContext, Page>();

export const test = playwright.test.extend<TestFixtures & Options, WorkerFixtures>({
  uiLocale: ['en', { option: true }],
  updatable: [false, { option: true }],

  siteUrl: [
    // Playwright requires an object pattern as the first parameter, even when empty.
    async ({}, use) => {
      const server = createServer((_request, response) => {
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(renderSitePage());
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      await use(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`);
      server.closeAllConnections();
      await new Promise<void>((done) =>
        server.close(() => {
          done();
        }),
      );
    },
    { scope: 'worker' },
  ],

  extensionDir: async ({ updatable }, use) => {
    if (!updatable) {
      await use(EXTENSION_DIR);
      return;
    }
    const copy = await mkdtemp(join(tmpdir(), 'pw-extension-'));
    await cp(EXTENSION_DIR, copy, { recursive: true });
    await use(copy);
    await rm(copy, { recursive: true, force: true });
  },

  context: async ({ uiLocale, extensionDir }, use) => {
    const profile = await mkdtemp(join(tmpdir(), 'pw-profile-'));
    const context = await playwright.chromium.launchPersistentContext(profile, {
      // Headed (under xvfb in CI) is what real users run; new headless is opt-in for quick local runs.
      ...(headless ? { channel: 'chromium', headless: true } : { headless: false }),
      locale: uiLocale,
      env: { ...process.env, LANGUAGE: uiLocale },
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        // Lets CDP's Extensions.loadUnpacked reload the extension (how a test updates it) and
        // Extensions.triggerAction click its toolbar icon, with the activeTab grant a real click gives.
        '--enable-unsafe-extension-debugging',
      ],
    });
    // Installing the extension opens the welcome tab. Wait for it, so that it never appears in the
    // middle of a test. It is left open: closing it made an extension page opened right afterwards
    // fail to run its module script about once in a hundred runs.
    let welcome: Page | undefined;
    await expect
      .poll(
        () => {
          welcome = context.pages().find(isWelcomePage);
          return welcome !== undefined;
        },
        { message: 'the welcome tab opens on install' },
      )
      .toBe(true);
    if (welcome !== undefined) {
      welcomeTabs.set(context, welcome);
    }
    await use(context);
    await context.close();
    await rm(profile, { recursive: true, force: true });
  },

  welcomePage: async ({ context }, use) => {
    const page = welcomeTabs.get(context);
    if (page === undefined || page.isClosed()) throw new Error('The welcome tab is closed.');
    await use(page);
  },

  serviceWorker: async ({ context }, use) => {
    const started = context.waitForEvent('serviceworker');
    started.catch(() => undefined); // not awaited when the worker is already running
    await use(context.serviceWorkers()[0] ?? (await started));
  },

  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

/** Opens the result page (upload mode, or a handoff when `hash` is given) of the extension in a new tab. */
export async function openResultPage(
  context: BrowserContext,
  extensionId: string,
  hash = '',
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}${hash}`);
  return page;
}

/**
 * Clicks the toolbar icon of the extension on the tab that shows `page`, the way a user does: Chrome grants
 * activeTab for that tab, so the injected overlay can be used and captureVisibleTab is allowed (the e2e build's
 * loopback host permission is not enough for a screenshot).
 */
export async function clickToolbarIcon(
  context: BrowserContext,
  extensionId: string,
  page: Page,
): Promise<void> {
  const browser = context.browser();
  if (browser === null) throw new Error('The persistent context has no browser.');
  await page.bringToFront();
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tab = targetInfos.find((target) => target.url === page.url());
    if (tab === undefined) throw new Error(`No browser tab shows ${page.url()}`);
    await cdp.send(
      'Extensions.triggerAction' as never,
      { id: extensionId, targetId: tab.targetId } as never,
    );
  } finally {
    await cdp.detach();
  }
}

/** The id of the tab that shows the test site (the e2e build has a host permission for 127.0.0.1). */
export async function siteTabId(serviceWorker: Worker): Promise<number> {
  const tabs = await serviceWorker.evaluate(() => chrome.tabs.query({ url: 'http://127.0.0.1/*' }));
  expect(tabs, 'exactly one tab shows the test site').toHaveLength(1);
  return tabs[0]?.id ?? -1;
}
