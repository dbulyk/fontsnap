import type { BrowserContext, Page, Worker } from '@playwright/test';
import { EXTENSION_PAGES, MENU_IMAGE } from '../../src/shared/constants';
import {
  clickToolbarIcon,
  expect,
  isExtensionPage,
  openResultPage,
  siteTabId,
  test,
  type Route,
} from './fixtures';
import { SAMPLE_TEXT } from './site-data';

// "Identify font in this image" on the image that was right-clicked, whatever the page does around it: below the fold, between
// text, taller than the window, from another origin (with and without CORS), in an iframe (same and other origin), at a pixel
// ratio of 1 and 2. Playwright cannot click a native context menu, so the click is the undocumented `onClicked.dispatch` of Chromium
// (see transparent.spec.ts); the toolbar-icon click first gives the tab the activeTab grant a real click gives (the e2e build's
// loopback host permission is not enough for a screenshot). What is asserted is what reached the analysis: the size of the canvas
// the result page shows (`#shot`) is the image, never the window, and the top font is the one of uploading the same file.
interface Shown {
  width: number;
  height: number;
  names: (string | null)[];
  wholeNote: boolean;
}

const WIDTH = 720;
const HEIGHT = 150;
const LONG = 2200;

/** Renders SAMPLE_TEXT on white as a PNG in a real browser canvas. */
async function renderPng(
  context: BrowserContext,
  extensionId: string,
  height = HEIGHT,
): Promise<Buffer> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.welcome}`);
  const base64 = await page.evaluate(
    async ({ text, width, high }) => {
      const cv = new OffscreenCanvas(width, high);
      const ctx = cv.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, width, high);
      ctx.fillStyle = '#111';
      ctx.font = '700 72px Georgia, serif';
      ctx.fillText(text, 24, 100);
      const bytes = new Uint8Array(
        await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer(),
      );
      return btoa(String.fromCharCode(...bytes));
    },
    { text: SAMPLE_TEXT, width: WIDTH, high: height },
  );
  await page.close();
  return Buffer.from(base64, 'base64');
}

const png = (body: Buffer, headers: Record<string, string> = {}): Route => ({
  type: 'image/png',
  body,
  headers,
});
const html = (body: string): Route => ({
  type: 'text/html; charset=utf-8',
  body: `<!doctype html><html><head><meta charset="utf-8"><title>page</title></head><body style="margin:0;font:20px Verdana,sans-serif;background:#fff">${body}</body></html>`,
});
const AROUND = (text: string): string =>
  `<p style="margin:40px;font:italic 24px Courier New,monospace">${text}</p>`;
const SPACER = (px: number): string => `<div style="height:${String(px)}px"></div>`;
const CORS = { 'access-control-allow-origin': '*' };

/**
 * Opens the page, gives the tab the activeTab grant of a toolbar click and takes the overlay down again. The click only starts the
 * injection: Escape is sent once the overlay is in the page, and the content script adds its key handler in the same turn as it
 * adds the overlay, so there is no moment where the overlay is up and Escape is lost.
 */
async function openSite(
  context: BrowserContext,
  extensionId: string,
  url: string,
  scrollTo = 0,
): Promise<Page> {
  const site = await context.newPage();
  await site.goto(url);
  await clickToolbarIcon(context, extensionId, site);
  const overlay = site.locator('div[style*="crosshair"]');
  await expect(overlay).toBeVisible();
  await site.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await site.evaluate((y) => {
    window.scrollTo(0, y);
  }, scrollTo);
  return site;
}

/** The frame id Chrome gives the frame whose URL starts with `prefix`. */
async function frameIdOf(serviceWorker: Worker, tabId: number, prefix: string): Promise<number> {
  const frames = await serviceWorker.evaluate(
    async (id) =>
      (
        await chrome.scripting.executeScript({
          target: { tabId: id, allFrames: true },
          func: () => location.href,
        })
      ).map((one) => ({ frameId: one.frameId, url: one.result })),
    tabId,
  );
  const hit = frames.find((one) => one.url?.startsWith(prefix) === true);
  expect(hit, `a frame at ${prefix} among ${JSON.stringify(frames)}`).toBeDefined();
  return hit?.frameId ?? -1;
}

/** Right-click on an image: what the context menu hands to the worker (frameId and frameUrl are those of the frame of the click). */
async function clickImage(
  context: BrowserContext,
  serviceWorker: Worker,
  click: { tabId: number; srcUrl: string; frameId?: number; frameUrl?: string },
): Promise<Page> {
  const opened = context.waitForEvent('page', {
    predicate: (page) => isExtensionPage(page.url(), EXTENSION_PAGES.result),
  });
  await serviceWorker.evaluate(
    async ({ tabId, srcUrl, frameId, frameUrl, menuItemId }) => {
      const tab = await chrome.tabs.get(tabId);
      const menu = chrome.contextMenus.onClicked as unknown as {
        dispatch: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void;
      };
      menu.dispatch(
        {
          menuItemId,
          srcUrl,
          frameId: frameId ?? 0,
          ...(frameUrl === undefined ? {} : { frameUrl }),
          editable: false,
          pageUrl: tab.url ?? '',
        },
        tab,
      );
    },
    { menuItemId: MENU_IMAGE, ...click },
  );
  return opened;
}

/** Waits until the result page has analysed what it was handed and reads what it shows. */
async function shown(result: Page, expectResults = true): Promise<Shown> {
  await expect(result.locator('#shot')).toBeVisible({ timeout: 60_000 });
  if (expectResults)
    await expect(result.locator('#results li').first()).toBeVisible({ timeout: 60_000 });
  await expect(result.locator('#status')).not.toHaveText(/^(Loading model|Analyzing)…$/, {
    timeout: 60_000,
  });
  const [width, height] = await result
    .locator('#shot')
    .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
  return {
    width,
    height,
    names: await result
      .locator('#results li .name')
      .evaluateAll((items) => items.map((item) => item.textContent)),
    wholeNote: await result.locator('#wholeNote').isVisible(),
  };
}

/** The families the result page names for the same file uploaded. */
async function uploaded(
  context: BrowserContext,
  extensionId: string,
  file: Buffer,
): Promise<Shown> {
  const page = await openResultPage(context, extensionId);
  await expect(page.locator('#status')).toHaveText('Ready. Paste, drop or choose an image.', {
    timeout: 60_000,
  });
  await page
    .locator('#file')
    .setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: file });
  const result = await shown(page);
  await page.close();
  return result;
}

/** A page at `origin` with an iframe (from `frameOrigin`) far below the fold. */
const pageWithFrame = (frameUrl: string, style = 'border:0'): Route =>
  html(
    `${AROUND('Above the frame')}${SPACER(1800)}<iframe src="${frameUrl}" width="900" height="500" style="display:block;margin:0 30px;${style}"></iframe>${SPACER(1500)}`,
  );
const frameDoc = (src: string): Route =>
  html(
    `${AROUND('Text in the frame')}<img src="${src}" width="${String(WIDTH)}" height="${String(HEIGHT)}" style="display:block;margin:0 40px">${AROUND('More text in the frame')}`,
  );

/** A page with an iframe far below the fold: the frame is served by the same server as the page, or by another one. */
async function frameSetup(
  serve: (routes: ReadonlyMap<string, Route>) => Promise<string>,
  sameOrigin: boolean,
  frame: Route,
  frameStyle?: string,
): Promise<{ origin: string; frames: string }> {
  if (sameOrigin) {
    const origin = await serve(
      new Map([
        ['/frame.html', frame],
        ['/page.html', pageWithFrame('/frame.html', frameStyle)],
      ]),
    );
    return { origin, frames: origin };
  }
  const frames = await serve(new Map([['/frame.html', frame]]));
  const origin = await serve(
    new Map([['/page.html', pageWithFrame(`${frames}/frame.html`, frameStyle)]]),
  );
  return { origin, frames };
}

const scrollY = (page: Page): Promise<number> => page.evaluate(() => window.scrollY);

test.describe('the image is read where the click happened (step 1)', () => {
  test('an image of the same site far below the fold, between other text: only the image is analysed', async ({
    context,
    extensionId,
    serviceWorker,
    serve,
  }) => {
    test.setTimeout(120_000);
    const file = await renderPng(context, extensionId);
    const origin = await serve(
      new Map([
        ['/img.png', png(file)],
        [
          '/page.html',
          html(
            `${AROUND('Text above the image')}${SPACER(2400)}${AROUND('Text right above')}<img id="target" src="/img.png" width="${String(WIDTH)}" height="${String(HEIGHT)}" style="display:block;margin:0 40px">${AROUND('Text right below')}${SPACER(1500)}`,
          ),
        ],
      ]),
    );
    const site = await openSite(context, extensionId, `${origin}/page.html`, 120);
    const tabId = await siteTabId(serviceWorker);
    const result = await clickImage(context, serviceWorker, {
      tabId,
      srcUrl: `${origin}/img.png`,
      frameUrl: `${origin}/page.html`,
    });
    const got = await shown(result);
    expect([got.width, got.height], 'the canvas is the image, not the window').toEqual([
      WIDTH,
      HEIGHT,
    ]);
    expect(got.wholeNote).toBe(false);
    expect(await scrollY(site), 'nothing was scrolled').toBe(120);
    const same = await uploaded(context, extensionId, file);
    expect(got.names[0]).toBe(same.names[0]);
    expect(got.names[0]).not.toBeNull();
  });

  test('an image taller than the window is read whole', async ({
    context,
    extensionId,
    serviceWorker,
    serve,
  }) => {
    test.setTimeout(120_000);
    const file = await renderPng(context, extensionId, LONG);
    const origin = await serve(
      new Map([
        ['/img.png', png(file)],
        [
          '/page.html',
          html(
            `${AROUND('Above')}${SPACER(900)}<img src="/img.png" style="display:block">${AROUND('Below')}`,
          ),
        ],
      ]),
    );
    await openSite(context, extensionId, `${origin}/page.html`);
    const tabId = await siteTabId(serviceWorker);
    const got = await shown(
      await clickImage(context, serviceWorker, { tabId, srcUrl: `${origin}/img.png` }),
    );
    expect([got.width, got.height]).toEqual([WIDTH, LONG]);
    expect(got.wholeNote).toBe(false);
    expect(got.names[0]).toBe((await uploaded(context, extensionId, file)).names[0]);
  });

  test('an image of another origin that allows CORS is read at its natural size', async ({
    context,
    extensionId,
    serviceWorker,
    serve,
  }) => {
    test.setTimeout(120_000);
    const file = await renderPng(context, extensionId);
    const other = await serve(new Map([['/img.png', png(file, CORS)]]));
    const origin = await serve(
      new Map([
        [
          '/page.html',
          html(
            `${AROUND('Above')}${SPACER(2000)}<img src="${other}/img.png" width="360" height="75" style="display:block">${SPACER(1200)}`,
          ),
        ],
      ]),
    );
    await openSite(context, extensionId, `${origin}/page.html`);
    const tabId = await siteTabId(serviceWorker);
    const got = await shown(
      await clickImage(context, serviceWorker, { tabId, srcUrl: `${other}/img.png` }),
    );
    // the page shows it at half size: only the pixels of the file (not a screenshot of the box) are 720 x 150
    expect([got.width, got.height]).toEqual([WIDTH, HEIGHT]);
    expect(got.wholeNote).toBe(false);
    expect(got.names[0]).toBe((await uploaded(context, extensionId, file)).names[0]);
  });
});

for (const ratio of [1, 2]) {
  test.describe(`a screenshot crop when the page cannot hand the pixels over (step 2), pixel ratio ${String(ratio)}`, () => {
    test.use({ deviceScaleFactor: ratio });

    test('an image of another origin without CORS: the box of the image, the scroll position put back', async ({
      context,
      extensionId,
      serviceWorker,
      serve,
    }) => {
      test.setTimeout(120_000);
      const file = await renderPng(context, extensionId);
      const other = await serve(new Map([['/img.png', png(file)]]));
      const origin = await serve(
        new Map([
          [
            '/page.html',
            html(
              `${AROUND('Above')}${SPACER(2400)}${AROUND('Text right above')}<img src="${other}/img.png" width="${String(WIDTH)}" height="${String(HEIGHT)}" style="display:block;margin:0 40px">${AROUND('Text right below')}${SPACER(1500)}`,
            ),
          ],
        ]),
      );
      const site = await openSite(context, extensionId, `${origin}/page.html`, 200);
      const tabId = await siteTabId(serviceWorker);
      const result = await clickImage(context, serviceWorker, {
        tabId,
        srcUrl: `${other}/img.png`,
        frameUrl: `${origin}/page.html`,
      });
      const got = await shown(result);
      expect([got.width, got.height], 'the box of the image times the pixel ratio').toEqual([
        WIDTH * ratio,
        HEIGHT * ratio,
      ]);
      expect(got.wholeNote).toBe(false);
      expect(await scrollY(site), 'the page is where it was').toBe(200);
      expect(await site.evaluate(() => window.devicePixelRatio)).toBe(ratio);
      expect(got.names[0]).toBe((await uploaded(context, extensionId, file)).names[0]);
    });

    test('an image taller than the window and without CORS: its visible part', async ({
      context,
      extensionId,
      serviceWorker,
      serve,
    }) => {
      test.setTimeout(120_000);
      const file = await renderPng(context, extensionId, LONG);
      const other = await serve(new Map([['/img.png', png(file)]]));
      const origin = await serve(
        new Map([
          [
            '/page.html',
            html(
              `${AROUND('Above')}${SPACER(1500)}<img src="${other}/img.png" style="display:block">${SPACER(800)}`,
            ),
          ],
        ]),
      );
      const site = await openSite(context, extensionId, `${origin}/page.html`, 50);
      const tabId = await siteTabId(serviceWorker);
      const got = await shown(
        await clickImage(context, serviceWorker, { tabId, srcUrl: `${other}/img.png` }),
      );
      const viewport = await site.evaluate(() => [innerWidth, innerHeight]);
      expect(got.width).toBe(WIDTH * ratio);
      expect(got.height, 'at most what the window shows').toBeLessThanOrEqual(
        (viewport[1] ?? 0) * ratio,
      );
      expect(got.height).toBeGreaterThan(HEIGHT * ratio);
      expect(got.wholeNote).toBe(false);
      expect(await scrollY(site)).toBe(50);
    });

    test('a page with smooth scrolling: the image is where the crop is taken, and the page comes back at once', async ({
      context,
      extensionId,
      serviceWorker,
      serve,
    }) => {
      test.setTimeout(120_000);
      const file = await renderPng(context, extensionId);
      const other = await serve(new Map([['/img.png', png(file)]]));
      const origin = await serve(
        new Map([
          [
            '/page.html',
            html(
              `<style>html{scroll-behavior:smooth}</style>${AROUND('Above')}${SPACER(3000)}<img src="${other}/img.png" width="${String(WIDTH)}" height="${String(HEIGHT)}" style="display:block;margin:0 40px">${SPACER(1500)}`,
            ),
          ],
        ]),
      );
      const site = await openSite(context, extensionId, `${origin}/page.html`);
      const tabId = await siteTabId(serviceWorker);
      const got = await shown(
        await clickImage(context, serviceWorker, { tabId, srcUrl: `${other}/img.png` }),
      );
      expect([got.width, got.height]).toEqual([WIDTH * ratio, HEIGHT * ratio]);
      expect(got.wholeNote).toBe(false);
      expect(got.names[0]).toBe((await uploaded(context, extensionId, file)).names[0]);
      expect(await scrollY(site), 'back where it was, not on its way').toBe(0);
    });

    test('the scroll position of a scrolling box around the image is put back as well', async ({
      context,
      extensionId,
      serviceWorker,
      serve,
    }) => {
      test.setTimeout(120_000);
      const file = await renderPng(context, extensionId);
      const other = await serve(new Map([['/img.png', png(file)]]));
      const origin = await serve(
        new Map([
          [
            '/page.html',
            html(
              `${AROUND('Above')}<div id="box" style="height:300px;width:900px;overflow:auto;margin:0 40px;border:1px solid #888">${SPACER(1200)}<img src="${other}/img.png" width="${String(WIDTH)}" height="${String(HEIGHT)}" style="display:block">${SPACER(600)}</div>${SPACER(1500)}`,
            ),
          ],
        ]),
      );
      const site = await openSite(context, extensionId, `${origin}/page.html`, 30);
      await site.evaluate(() => {
        const box = document.getElementById('box');
        if (box) box.scrollTop = 250;
      });
      const tabId = await siteTabId(serviceWorker);
      const got = await shown(
        await clickImage(context, serviceWorker, { tabId, srcUrl: `${other}/img.png` }),
      );
      expect([got.width, got.height]).toEqual([WIDTH * ratio, HEIGHT * ratio]);
      expect(await site.evaluate(() => document.getElementById('box')?.scrollTop)).toBe(250);
      expect(await scrollY(site)).toBe(30);
    });
  });
}

test.describe('an image inside an iframe', () => {
  test('an iframe of the same origin: its own image is read in the frame', async ({
    context,
    extensionId,
    serviceWorker,
    serve,
  }) => {
    test.setTimeout(120_000);
    const file = await renderPng(context, extensionId);
    const origin = await serve(
      new Map([
        ['/img.png', png(file)],
        ['/page.html', pageWithFrame('/frame.html')],
        ['/frame.html', frameDoc('/img.png')],
      ]),
    );
    await openSite(context, extensionId, `${origin}/page.html`);
    const tabId = await siteTabId(serviceWorker);
    const frameId = await frameIdOf(serviceWorker, tabId, `${origin}/frame.html`);
    const got = await shown(
      await clickImage(context, serviceWorker, {
        tabId,
        srcUrl: `${origin}/img.png`,
        frameId,
        frameUrl: `${origin}/frame.html`,
      }),
    );
    expect(frameId).toBeGreaterThan(0);
    expect([got.width, got.height]).toEqual([WIDTH, HEIGHT]);
    expect(got.wholeNote).toBe(false);
    expect(got.names[0]).toBe((await uploaded(context, extensionId, file)).names[0]);
  });

  test('an iframe of another origin: its own image is read in the frame', async ({
    context,
    extensionId,
    serviceWorker,
    serve,
  }) => {
    test.setTimeout(120_000);
    const file = await renderPng(context, extensionId);
    const frames = await serve(
      new Map([
        ['/img.png', png(file)],
        ['/frame.html', frameDoc('/img.png')],
      ]),
    );
    const origin = await serve(new Map([['/page.html', pageWithFrame(`${frames}/frame.html`)]]));
    await openSite(context, extensionId, `${origin}/page.html`);
    const tabId = await siteTabId(serviceWorker);
    const frameId = await frameIdOf(serviceWorker, tabId, `${frames}/frame.html`);
    const got = await shown(
      await clickImage(context, serviceWorker, {
        tabId,
        srcUrl: `${frames}/img.png`,
        frameId,
        frameUrl: `${frames}/frame.html`,
      }),
    );
    expect([got.width, got.height]).toEqual([WIDTH, HEIGHT]);
    expect(got.wholeNote).toBe(false);
    expect(got.names[0]).toBe((await uploaded(context, extensionId, file)).names[0]);
  });

  for (const ratio of [1, 2]) {
    test.describe(`without CORS, pixel ratio ${String(ratio)}`, () => {
      test.use({ deviceScaleFactor: ratio });

      for (const sameOrigin of [true, false]) {
        test(`an image of a third origin in an iframe of ${sameOrigin ? 'the same' : 'another'} origin: a crop at the position of the frame, both scroll positions put back`, async ({
          context,
          extensionId,
          serviceWorker,
          serve,
        }) => {
          test.setTimeout(120_000);
          const file = await renderPng(context, extensionId);
          const third = await serve(new Map([['/img.png', png(file)]]));
          const { origin, frames } = await frameSetup(
            serve,
            sameOrigin,
            frameDoc(`${third}/img.png`),
          );
          const site = await openSite(context, extensionId, `${origin}/page.html`, 100);
          const tabId = await siteTabId(serviceWorker);
          const frameId = await frameIdOf(serviceWorker, tabId, `${frames}/frame.html`);
          const got = await shown(
            await clickImage(context, serviceWorker, {
              tabId,
              srcUrl: `${third}/img.png`,
              frameId,
              frameUrl: `${frames}/frame.html`,
            }),
          );
          expect([got.width, got.height], 'the image, not the frame and not the window').toEqual([
            WIDTH * ratio,
            HEIGHT * ratio,
          ]);
          expect(got.wholeNote).toBe(false);
          expect(await scrollY(site), 'the page is where it was').toBe(100);
          expect(got.names[0]).toBe((await uploaded(context, extensionId, file)).names[0]);
        });
      }

      test('an iframe with a border of a different width on every side: the crop is still the image', async ({
        context,
        extensionId,
        serviceWorker,
        serve,
      }) => {
        test.setTimeout(120_000);
        const file = await renderPng(context, extensionId);
        const third = await serve(new Map([['/img.png', png(file)]]));
        const { origin, frames } = await frameSetup(
          serve,
          false,
          frameDoc(`${third}/img.png`),
          'border:solid #888;border-width:3px 2px 11px 7px',
        );
        const site = await openSite(context, extensionId, `${origin}/page.html`, 100);
        const tabId = await siteTabId(serviceWorker);
        const frameId = await frameIdOf(serviceWorker, tabId, `${frames}/frame.html`);
        const got = await shown(
          await clickImage(context, serviceWorker, {
            tabId,
            srcUrl: `${third}/img.png`,
            frameId,
            frameUrl: `${frames}/frame.html`,
          }),
        );
        expect([got.width, got.height]).toEqual([WIDTH * ratio, HEIGHT * ratio]);
        expect(got.wholeNote).toBe(false);
        expect(await scrollY(site)).toBe(100);
        // a crop shifted by a few pixels would read the neighbouring text as well: the same family as the file itself
        expect(got.names[0]).toBe((await uploaded(context, extensionId, file)).names[0]);
      });
    });
  }
});

test.describe('the whole visible area, with a hint (step 3)', () => {
  test('an image that is not on the page and cannot be loaded', async ({
    context,
    extensionId,
    serviceWorker,
    serve,
  }) => {
    test.setTimeout(120_000);
    const origin = await serve(
      new Map([['/page.html', html(`${AROUND(SAMPLE_TEXT)}${SPACER(300)}`)]]),
    );
    const site = await openSite(context, extensionId, `${origin}/page.html`);
    const tabId = await siteTabId(serviceWorker);
    const viewport = await site.evaluate(() => [innerWidth, innerHeight]);
    const result = await clickImage(context, serviceWorker, {
      tabId,
      srcUrl: `${origin}/gone.png`,
      frameUrl: `${origin}/page.html`,
    });
    const got = await shown(result, false);
    expect(got.wholeNote).toBe(true);
    expect([got.width, got.height]).toEqual(viewport);
    await expect(result.locator('#wholeNote')).toContainText('could not be isolated');
    await expect(result.locator('#status')).not.toHaveClass(/err/);
    await expect(
      result.getByRole('status').filter({ has: result.locator('#wholeNote') }),
      'the hint is told to a screen reader',
    ).toContainText('could not be isolated');
    const contrast = await result.locator('#wholeNote').evaluate((note) => {
      const channels = (css: string) => (css.match(/\d+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (css: string) => {
        const [r = 0, g = 0, b = 0] = channels(css).map((v) => {
          const c = v / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const text = luminance(getComputedStyle(note).color);
      const back = luminance(getComputedStyle(document.body).backgroundColor);
      return (Math.max(text, back) + 0.05) / (Math.min(text, back) + 0.05);
    });
    expect(contrast, 'WCAG AA for 13px text').toBeGreaterThanOrEqual(4.5);
  });

  test('an iframe the worker cannot place falls back too (no frame URL in the click)', async ({
    context,
    extensionId,
    serviceWorker,
    serve,
  }) => {
    test.setTimeout(120_000);
    const file = await renderPng(context, extensionId);
    const third = await serve(new Map([['/img.png', png(file)]]));
    const frames = await serve(
      new Map([
        [
          '/frame.html',
          html(`<img src="${third}/img.png" width="${String(WIDTH)}" height="${String(HEIGHT)}">`),
        ],
      ]),
    );
    const origin = await serve(
      new Map([
        [
          '/page.html',
          html(
            `<iframe src="${frames}/frame.html" width="900" height="300" style="border:0"></iframe>`,
          ),
        ],
      ]),
    );
    const site = await openSite(context, extensionId, `${origin}/page.html`);
    const tabId = await siteTabId(serviceWorker);
    const frameId = await frameIdOf(serviceWorker, tabId, `${frames}/frame.html`);
    const viewport = await site.evaluate(() => [innerWidth, innerHeight]);
    const got = await shown(
      await clickImage(context, serviceWorker, { tabId, srcUrl: `${third}/img.png`, frameId }),
      false,
    );
    expect(got.wholeNote).toBe(true);
    expect([got.width, got.height]).toEqual(viewport);
  });

  test('an iframe with padding falls back too: which side the padding is on cannot be read', async ({
    context,
    extensionId,
    serviceWorker,
    serve,
  }) => {
    test.setTimeout(120_000);
    const file = await renderPng(context, extensionId);
    const third = await serve(new Map([['/img.png', png(file)]]));
    const { origin, frames } = await frameSetup(
      serve,
      false,
      frameDoc(`${third}/img.png`),
      'border:solid #888;border-width:3px 2px 11px 7px;padding:10px 4px 6px 12px',
    );
    const site = await openSite(context, extensionId, `${origin}/page.html`, 100);
    const tabId = await siteTabId(serviceWorker);
    const frameId = await frameIdOf(serviceWorker, tabId, `${frames}/frame.html`);
    const viewport = await site.evaluate(() => [innerWidth, innerHeight]);
    const got = await shown(
      await clickImage(context, serviceWorker, {
        tabId,
        srcUrl: `${third}/img.png`,
        frameId,
        frameUrl: `${frames}/frame.html`,
      }),
      false,
    );
    expect(got.wholeNote).toBe(true);
    expect([got.width, got.height]).toEqual(viewport);
    expect(await scrollY(site), 'the page is where it was').toBe(100);
  });
});
