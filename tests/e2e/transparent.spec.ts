import type { Page } from '@playwright/test';
import { expect, openResultPage, test } from './fixtures';

// Black text on a transparent background must be read like the same text on white. The picture is drawn
// by the browser itself (OffscreenCanvas, anti-aliased glyphs with partial alpha) and encoded as a PNG, once with
// the background left transparent and once filled white. It reaches the result page the two ways a user
// has: the file input, and the handoff of the context menu on an image (a PNG data: URL in
// chrome.storage.session, opened with #cap_<id>: Playwright cannot click a native context menu).
const READY = 'Ready. Paste, drop or choose an image.';
const NO_LINES = 'No clear text lines found — result may be unreliable. Try a tighter selection.';

interface Pictures {
  transparent: string;
  white: string;
}

/** Renders two lines of black text; `base64` PNGs of the transparent and of the white-backed picture. */
async function renderPictures(page: Page, text: string[]): Promise<Pictures> {
  return page.evaluate(async (lines) => {
    const draw = async (background: string | null): Promise<string> => {
      const cv = new OffscreenCanvas(900, 120 * lines.length + 40);
      const ctx = cv.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      if (background !== null) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, cv.width, cv.height);
      }
      ctx.fillStyle = '#000000';
      ctx.font = '700 72px Georgia, serif';
      lines.forEach((line, i) => {
        ctx.fillText(line, 30, 100 + i * 120);
      });
      const bytes = new Uint8Array(
        await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer(),
      );
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    };
    return { transparent: await draw(null), white: await draw('#ffffff') };
  }, text);
}

/** Top-1 name and the final status, once the page has analysed what it was given. */
async function outcome(page: Page): Promise<{ top1: string; status: string }> {
  await expect(page.locator('#results li').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#status')).not.toHaveText(/^(Analyzing…|Loading model…|Ready.*)$/);
  return {
    top1: (await page.locator('#results li .name').first().textContent()) ?? '',
    status: (await page.locator('#status').textContent()) ?? '',
  };
}

async function viaFile(page: Page, png: string): Promise<{ top1: string; status: string }> {
  await page.locator('#file').setInputFiles({
    name: 'text.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64'),
  });
  return outcome(page);
}

async function viaContextMenuHandoff(
  context: Parameters<typeof openResultPage>[0],
  extensionId: string,
  png: string,
): Promise<{ top1: string; status: string }> {
  const id = `cap_${crypto.randomUUID()}`;
  const setup = await openResultPage(context, extensionId);
  await setup.evaluate(
    (args) =>
      chrome.storage.session.set({
        [args.id]: { dataUrl: `data:image/png;base64,${args.png}`, text: '' },
      }),
    { id, png },
  );
  await setup.close();
  const page = await openResultPage(context, extensionId, `#${id}`);
  const result = await outcome(page);
  await page.close();
  return result;
}

const TEXT = ['Hamburgefonstiv', 'Quick brown fox'];

test('a transparent PNG chosen as a file reads like the same text on white', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const page = await openResultPage(context, extensionId);
  await expect(page.locator('#status')).toHaveText(READY, { timeout: 60_000 });
  const { transparent, white } = await renderPictures(page, TEXT);
  const onWhite = await viaFile(page, white);
  expect(onWhite.status, 'the white picture has text lines').toBe('');
  const onTransparent = await viaFile(page, transparent);
  expect(onTransparent).toEqual(onWhite);
});

test('a transparent PNG from the image context menu reads like the same text on white', async ({
  context,
  extensionId,
}) => {
  test.setTimeout(120_000);
  const page = await openResultPage(context, extensionId);
  const { transparent, white } = await renderPictures(page, TEXT);
  const onWhite = await viaContextMenuHandoff(context, extensionId, white);
  expect(onWhite.status, 'the white picture has text lines').toBe('');
  const onTransparent = await viaContextMenuHandoff(context, extensionId, transparent);
  expect(onTransparent).toEqual(onWhite);
});

test('a fully transparent PNG is a blank page: no text lines, nothing breaks', async ({
  context,
  extensionId,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await openResultPage(context, extensionId);
  await expect(page.locator('#status')).toHaveText(READY, { timeout: 60_000 });
  const { transparent } = await renderPictures(page, ['']);
  const result = await viaFile(page, transparent);
  expect(result.status).toBe(NO_LINES);
  expect(testInfo.errors).toEqual([]);
});
