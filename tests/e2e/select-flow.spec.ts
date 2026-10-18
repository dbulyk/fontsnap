import { EXTENSION_PAGES } from '../../src/shared/constants';
import { clickToolbarIcon, expect, isExtensionPage, test } from './fixtures';
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
