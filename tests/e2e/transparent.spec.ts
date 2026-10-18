import type { BrowserContext, Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { EXTENSION_PAGES, MENU_IMAGE } from '../../src/shared/constants';
import { fromRGBA, type Backdrop } from '../../src/shared/core/image';
import { expect, isExtensionPage, openResultPage, test } from './fixtures';
import { SAMPLE_TEXT } from './site-data';

// Text on a transparent background (a logo, a PNG exported from a design tool) must be read like the same text on
// the ground it was made for: black text like black on white, white text like white on black. The pipeline used to
// drop the alpha channel, so a transparent pixel was black and black text vanished; compositing everything over
// white would have lost white text instead (src/shared/core/image.ts `chooseBackdrop`).
interface Outcome {
  names: (string | null)[];
  status: string;
}

interface Sample {
  /** The text on a transparent background. */
  clear: Buffer;
  /** The same text on the ground it is meant for: white under black text, black under white text. */
  ground: Buffer;
  cornerAlpha: number;
}

const INKS = [
  { name: 'black', ink: '#000', ground: '#fff' },
  { name: 'white', ink: '#fff', ground: '#000' },
] as const;

/** Renders the sample as PNGs in a real browser canvas: transparent, and on its ground. */
async function renderSample(
  context: BrowserContext,
  extensionId: string,
  colors: { ink: string; ground: string },
): Promise<Sample> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.welcome}`);
  const png = await page.evaluate(
    async ({ text, ink, ground }) => {
      const draw = async (background: string | null) => {
        const cv = new OffscreenCanvas(720, 150);
        const ctx = cv.getContext('2d');
        if (ctx === null) throw new Error('no 2d context');
        if (background !== null) {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, cv.width, cv.height);
        }
        ctx.fillStyle = ink;
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
      return { clear: await draw(null), ground: await draw(ground) };
    },
    { text: SAMPLE_TEXT, ...colors },
  );
  await page.close();
  return {
    clear: Buffer.from(png.clear.base64, 'base64'),
    ground: Buffer.from(png.ground.base64, 'base64'),
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

for (const colors of INKS) {
  test(`a PNG with ${colors.name} text on a transparent background reads like the same PNG on ${colors.name === 'black' ? 'white' : 'black'} (file upload)`, async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(120_000);
    const sample = await renderSample(context, extensionId, colors);
    expect(sample.cornerAlpha, 'the sample really is transparent').toBe(0);
    const ground = await uploaded(context, extensionId, sample.ground);
    expect(ground.status, 'lines are found on its ground').toBe('');
    const clear = await uploaded(context, extensionId, sample.clear);
    expect(clear.status, 'lines are found on transparent').toBe('');
    expect(clear.names.length).toBeGreaterThan(0);
    expect(clear.names[0]).toBe(ground.names[0]);
  });

  test(`the same holds for the context menu on a data: image, ${colors.name} text on transparent`, async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    test.setTimeout(120_000);
    const sample = await renderSample(context, extensionId, colors);
    expect(sample.cornerAlpha, 'the sample really is transparent').toBe(0);
    const ground = await uploaded(context, extensionId, sample.ground);
    expect(ground.status, 'lines are found on its ground').toBe('');

    const opened = context.waitForEvent('page', {
      predicate: (page) => isExtensionPage(page.url(), EXTENSION_PAGES.result),
    });
    // Playwright cannot click a native context menu. `onClicked.dispatch` is an undocumented method of Chromium's
    // extension events: it calls the listener the service worker registered, as the menu click would, but skips the
    // menu itself and its `contexts: ['image']`. If Chromium removes the method, this throws a TypeError and the test
    // fails loudly. A data: srcUrl is decoded without a request, so what is covered is the click handler, the
    // handoff through chrome.storage.session and the result page; the pixels then follow the same path as an upload.
    await serviceWorker.evaluate(
      async ({ base64, menuItemId }) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const menu = chrome.contextMenus.onClicked as unknown as {
          dispatch: (info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) => void;
        };
        menu.dispatch(
          {
            menuItemId,
            srcUrl: `data:image/png;base64,${base64}`,
            editable: false,
            pageUrl: '',
          },
          tab,
        );
      },
      { base64: sample.clear.toString('base64'), menuItemId: MENU_IMAGE },
    );
    const result = await opened;
    expect(result.url()).toMatch(/#cap_[0-9a-f-]{36}$/);
    const clear = await outcome(result);
    expect(clear.status, 'lines are found on transparent').toBe('');
    expect(clear.names[0]).toBe(ground.names[0]);
  });
}

test('getImageData of a drawn transparent image composites to the same bytes as the source pixels, for both backdrops', async ({
  context,
  extensionId,
}) => {
  // All 65 536 (colour, alpha) pairs as a PNG. Chromium keeps canvas pixels premultiplied, so getImageData hands back
  // rounded colours for a < 255; the result page does not paint the canvas, so it is these bytes fromRGBA gets.
  const source = new PNG({ width: 256, height: 256 });
  for (let a = 0; a < 256; a++)
    for (let c = 0; c < 256; c++) source.data.set([c, 255 - c, c ^ 0x55, a], (a * 256 + c) * 4);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.welcome}`);
  const read = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const cv = new OffscreenCanvas(256, 256);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (ctx === null) throw new Error('no 2d context');
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(0, 0, 256, 256).data);
  }, PNG.sync.write(source).toString('base64'));
  expect(read).toHaveLength(256 * 256 * 4);
  for (const backdrop of [0, 255] as const satisfies Backdrop[]) {
    const want = fromRGBA(source.data, 256, 256, backdrop).data;
    const got = fromRGBA(Uint8Array.from(read), 256, 256, backdrop).data;
    const differing = [...want].flatMap((byte, i) => (byte === got[i] ? [] : [i]));
    expect(differing, `backdrop ${String(backdrop)}: bytes that differ`).toEqual([]);
  }
});
