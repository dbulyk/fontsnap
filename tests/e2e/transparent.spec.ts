import type { BrowserContext, Page } from '@playwright/test';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { expect, isExtensionPage, openResultPage, test } from './fixtures';
import { SAMPLE_TEXT } from './site-data';

// Black text on a transparent background (a PNG from a design tool, a logo on a web page) must be read like the same
// text on white. The canvas used to hand (0, 0, 0, 0) to the pipeline, which is black: the text vanished into a solid block.
interface Outcome {
  names: (string | null)[];
  status: string;
}

/** Renders the sample as a PNG in a real browser canvas, once on a transparent background and once on white. */
async function renderSample(
  context: BrowserContext,
  extensionId: string,
): Promise<Record<'clear' | 'white', Buffer> & { cornerAlpha: number }> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.welcome}`);
  const png = await page.evaluate(async (text) => {
    const draw = async (background: string | null) => {
      const cv = new OffscreenCanvas(720, 150);
      const ctx = cv.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      if (background !== null) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, cv.width, cv.height);
      }
      ctx.fillStyle = '#000';
      ctx.font = '700 72px Georgia, serif';
      ctx.fillText(text, 24, 100);
      const bytes = new Uint8Array(
        await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer(),
      );
      return {
        base64: btoa(String.fromCharCode(...bytes)),
        cornerAlpha: ctx.getImageData(0, 0, 1, 1).data[3] ?? -1,
      };
    };
    return { clear: await draw(null), white: await draw('#fff') };
  }, SAMPLE_TEXT);
  await page.close();
  return {
    clear: Buffer.from(png.clear.base64, 'base64'),
    white: Buffer.from(png.white.base64, 'base64'),
    cornerAlpha: png.clear.cornerAlpha,
  };
}

/** Waits until the result page finished analysing and reads the family names it shows. */
async function outcome(page: Page): Promise<Outcome> {
  await expect(page.locator('#results li').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#status')).not.toHaveText('Analyzing…');
  return {
    names: await page
      .locator('#results li .name')
      .evaluateAll((items) => items.map((i) => i.textContent)),
    status: (await page.locator('#status').textContent()) ?? '',
  };
}

async function uploaded(
  context: BrowserContext,
  extensionId: string,
  png: Buffer,
): Promise<Outcome> {
  const page = await openResultPage(context, extensionId);
  await expect(page.locator('#status')).toHaveText('Ready. Paste, drop or choose an image.', {
    timeout: 60_000,
  });
  await page
    .locator('#file')
    .setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: png });
  return outcome(page);
}

test('a PNG with black text on a transparent background reads like the same PNG on white (file upload)', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const sample = await renderSample(context, extensionId);
  expect(sample.cornerAlpha, 'the sample really is transparent').toBe(0);
  const white = await uploaded(context, extensionId, sample.white);
  expect(white.status, 'lines are found on white').toBe('');
  const clear = await uploaded(context, extensionId, sample.clear);
  expect(clear.status, 'lines are found on transparent').toBe('');
  expect(clear.names.length).toBeGreaterThan(0);
  expect(clear.names[0]).toBe(white.names[0]);
});

test('the same holds for "Identify font in this image" on a transparent PNG (context menu)', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  test.setTimeout(120_000);
  const sample = await renderSample(context, extensionId);
  const white = await uploaded(context, extensionId, sample.white);
  expect(white.status, 'lines are found on white').toBe('');

  const opened = context.waitForEvent('page', {
    predicate: (page) => isExtensionPage(page.url(), EXTENSION_PAGES.result),
  });
  await serviceWorker.evaluate(async (base64) => {
    const [tab] = await chrome.tabs.query({ active: true });
    const menu = chrome.contextMenus.onClicked as unknown as {
      dispatch: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void;
    };
    menu.dispatch(
      {
        menuItemId: 'fontsnap-image',
        srcUrl: `data:image/png;base64,${base64}`,
        editable: false,
        pageUrl: '',
      },
      tab,
    );
  }, sample.clear.toString('base64'));
  const result = await opened;
  expect(result.url()).toMatch(/#cap_[0-9a-f-]{36}$/);
  const clear = await outcome(result);
  expect(clear.status, 'lines are found on transparent').toBe('');
  expect(clear.names[0]).toBe(white.names[0]);
});
