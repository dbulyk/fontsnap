import type { BrowserContext, Page } from '@playwright/test';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { clickToolbarIcon, expect, isExtensionPage, test } from './fixtures';
import type { Route } from './fixtures';
import { SAMPLE_TEXT } from './site-data';

// The whole path of a region selection in real Chromium: the toolbar icon is clicked (Extensions.triggerAction, so
// Chrome grants activeTab as for a user), the overlay appears, the user drags over the text, the service worker
// takes the screenshot, crops it, hands it over through chrome.storage.session and opens the result page,
// which analyses it.
test('selecting text on a page ends in the result tab with the crop analysed', async ({
  context,
  extensionId,
  serviceWorker,
  siteUrl,
}) => {
  const site = await context.newPage();
  await site.goto(siteUrl);
  const box = await site.locator('#sample').boundingBox();
  expect(box, 'the sample text has a box').not.toBeNull();
  const { x = 0, y = 0 } = box ?? {};

  await clickToolbarIcon(context, extensionId, site);
  const overlay = site.locator('div[style*="crosshair"]');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('FontSnap');

  const opened = context.waitForEvent('page', {
    predicate: (page) => isExtensionPage(page.url(), EXTENSION_PAGES.result),
  });
  const width = 360;
  const height = 80;
  await site.mouse.move(x - 10, y - 5);
  await site.mouse.down();
  await site.mouse.move(x - 10 + width, y - 5 + height, { steps: 4 });
  await site.mouse.up();
  const result = await opened;

  expect(result.url()).toMatch(/#cap_[0-9a-f-]{36}$/);
  await expect(overlay).toHaveCount(0);
  // the text under the selection becomes the preview sample; the crop is analysed
  await expect(result.locator('#pvText')).toHaveValue(SAMPLE_TEXT);
  await expect(result.locator('#results li').first()).toBeVisible();
  await expect(result.locator('#status')).toHaveText('');
  await expect(result.locator('#shot')).toHaveJSProperty('width', width);
  await expect(result.locator('#shot')).toHaveJSProperty('height', height);
  await expect(result.locator('.sample').first()).toHaveText(SAMPLE_TEXT);
  // the handoff entry is removed once read
  expect(await serviceWorker.evaluate(() => chrome.storage.session.get(null))).toEqual({});
});

test('Escape cancels the selection and leaves the page as it was', async ({
  context,
  extensionId,
  siteUrl,
}) => {
  const site = await context.newPage();
  await site.goto(siteUrl);
  await clickToolbarIcon(context, extensionId, site);
  const overlay = site.locator('div[style*="crosshair"]');
  await expect(overlay).toBeVisible();
  await site.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(site.locator('#sample')).toBeVisible();
});

test('a second click on the icon does not stack a second overlay', async ({
  context,
  extensionId,
  siteUrl,
}) => {
  const site = await context.newPage();
  await site.goto(siteUrl);
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toHaveCount(1);
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toHaveCount(1);
});

test('on a page where scripts cannot run, the icon opens the result page in upload mode', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('chrome://version/');
  const opened = context.waitForEvent('page', {
    predicate: (candidate) => isExtensionPage(candidate.url(), EXTENSION_PAGES.result),
  });
  await clickToolbarIcon(context, extensionId, page);
  const result = await opened;
  await expect(result.locator('#status')).toHaveText('Ready. Paste, drop or choose an image.', {
    timeout: 60_000,
  });
  expect(result.url()).toBe(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}`);
});

// The case from a user report: the frame was over "TT Polihaus…", but the preview showed text from elsewhere
// on the page (a selection, hidden text, transparent text, covered text). The textarea sticks out of the
// frame and has no selection, so its value is not the framed text either.
test('the preview takes only the visible text inside the frame, not a selection or hidden text', async ({
  context,
  extensionId,
  serve,
}) => {
  const visible = 'TT Polihaus — экспериментальный гротеск';
  const trap = 'БУКВОПЕЧАТАЮЩЕЙ СВЯЗИ';
  const at = 'position:absolute;left:0;top:0;margin:0;font:32px/40px sans-serif';
  const origin = await serve(
    new Map([
      [
        '/',
        {
          type: 'text/html; charset=utf-8',
          body: `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#fff">
  <p id="elsewhere" style="margin:20px 40px;font:20px sans-serif">${trap} selected</p>
  <div id="frame" style="position:absolute;left:40px;top:200px;width:700px;height:200px">
    <p style="${at};visibility:hidden">${trap} hidden</p>
    <p style="${at};opacity:0">${trap} transparent</p>
    <textarea style="position:absolute;left:0;top:160px;width:300px;height:80px;opacity:0.01">${trap} textarea</textarea>
    <p style="${at};top:120px">${trap} covered</p>
    <div style="position:absolute;left:0;top:110px;width:700px;height:60px;background:#fff"></div>
    <p id="visible" style="${at};color:#111">${visible}</p>
  </div>
</body></html>`,
        },
      ],
    ]),
  );
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  await site.evaluate(() => {
    const range = document.createRange();
    const elsewhere = document.getElementById('elsewhere');
    if (elsewhere === null) throw new Error('no #elsewhere');
    range.selectNodeContents(elsewhere);
    document.getSelection()?.addRange(range);
  });
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toBeVisible();
  const opened = context.waitForEvent('page', {
    predicate: (page) => isExtensionPage(page.url(), EXTENSION_PAGES.result),
  });
  await site.mouse.move(30, 190);
  await site.mouse.down();
  await site.mouse.move(760, 390, { steps: 4 });
  await site.mouse.up();
  const result = await opened;
  await expect(result.locator('#pvText')).toHaveValue(visible);
});

function pageOf(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#fff">${body}</body></html>`;
}

async function framedPreview(
  context: BrowserContext,
  extensionId: string,
  serve: (routes: ReadonlyMap<string, Route>) => Promise<string>,
  body: string,
  prepare?: (site: Page) => Promise<void>,
): Promise<string> {
  const origin = await serve(
    new Map([['/', { type: 'text/html; charset=utf-8', body: pageOf(body) }]]),
  );
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  if (prepare !== undefined) await prepare(site);
  const box = await site.locator('#t').boundingBox();
  expect(box, '#t has a box').not.toBeNull();
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toBeVisible();
  const opened = context.waitForEvent('page', {
    predicate: (candidate) => isExtensionPage(candidate.url(), EXTENSION_PAGES.result),
  });
  const x = Math.max(0, (box?.x ?? 0) - 8);
  const y = Math.max(0, (box?.y ?? 0) - 8);
  await site.mouse.move(x, y);
  await site.mouse.down();
  await site.mouse.move(
    (box?.x ?? 0) + (box?.width ?? 0) + 8,
    (box?.y ?? 0) + (box?.height ?? 0) + 8,
    {
      steps: 4,
    },
  );
  await site.mouse.up();
  const result = await opened;
  await expect(result.locator('#results li').first()).toBeVisible();
  return result.locator('#pvText').inputValue();
}

const textStyle = 'margin:80px 40px;font:32px/40px sans-serif;color:#111';

test('the preview takes text that does not receive pointer events', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    `<p id="t" style="pointer-events:none;${textStyle}">Pointer Free Text</p>`,
  );
  expect(text).toBe('Pointer Free Text');
});

test('the preview takes text under a transparent click catcher', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    `<p id="t" style="${textStyle}">Under Clear Layer</p><div style="position:fixed;inset:0;background:rgba(0,0,0,0)"></div>`,
  );
  expect(text).toBe('Under Clear Layer');
});

test('the preview takes a heading under a stretched link', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    `<style>.card{position:relative;width:520px;margin:80px 40px}.stretched-link::after{content:"";position:absolute;inset:0}</style>
<div class="card"><h2 id="t" style="margin:0 0 24px;font:32px/40px sans-serif;color:#111">Card Title Here</h2><a class="stretched-link" href="#read">Read</a></div>`,
  );
  expect(text).toBe('Card Title Here');
});

test('the preview skips text covered by an opaque descendant', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    `<p id="t" style="position:relative;${textStyle};width:420px">Covered Words<span style="position:absolute;inset:0;background:#fff"></span></p>`,
  );
  expect(text).toBe('');
});

test('the preview takes text in an element with no box', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    `<p id="t" style="${textStyle}"><span style="display:contents">Contents Text</span></p>`,
  );
  expect(text).toBe('Contents Text');
});

test('the preview takes visible letters marked aria-hidden', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    `<p id="t" aria-hidden="true" style="${textStyle}">Aria Visible Letters</p>`,
  );
  expect(text).toBe('Aria Visible Letters');
});

test('the preview takes the selected part of a textarea that meets the frame', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    '<textarea id="t" style="margin:80px 40px;width:480px;height:90px;font:24px sans-serif">selected part and the rest</textarea>',
    async (site) => {
      await site.locator('#t').evaluate((node) => {
        if (!(node instanceof HTMLTextAreaElement)) throw new Error('textarea');
        node.setSelectionRange(0, 13);
      });
    },
  );
  expect(text).toBe('selected part');
});

test('the preview takes a textarea value when the field sits inside the frame', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    '<textarea id="t" style="margin:80px 40px;width:480px;height:90px;font:24px sans-serif">full field value</textarea>',
  );
  expect(text).toBe('full field value');
});

test('the preview never reads a password field', async ({ context, extensionId, serve }) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    '<input id="t" type="password" value="SecretPass" style="margin:80px 40px;width:320px;height:44px;font:24px sans-serif">',
  );
  expect(text).toBe('');
});

test('the preview takes a text field value when the field sits inside the frame', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await framedPreview(
    context,
    extensionId,
    serve,
    '<input id="t" type="text" value="typed words" style="margin:80px 40px;width:320px;height:44px;font:24px sans-serif">',
  );
  expect(text).toBe('typed words');
});
