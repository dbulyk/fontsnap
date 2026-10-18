import ts from 'typescript';
import { readFileSync } from 'node:fs';
import type { BrowserContext, Page } from '@playwright/test';
import type * as Capture from '../../src/shared/capture';

type Lib = typeof Capture;
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { expect, test } from './fixtures';

/**
 * Capture-handoff smoke (the port of scripts/capture-smoke.mjs).
 *
 * Exercises the real browser APIs used after a screenshot lands in the service worker: OffscreenCanvas crop →
 * encodeWithinSessionQuota (PNG / JPEG ladder) → chrome.storage.session → result hash handoff helpers.
 *
 * The helpers are the shipped source, src/shared/capture.ts, transpiled and loaded into an extension page:
 * the page's CSP forbids scripts of its own making, but a DevTools-protocol evaluation (what Playwright does)
 * is not subject to it. They run in an extension page, not in the worker, because the page has the same
 * OffscreenCanvas and chrome.storage.session. It does not need the activeTab grant of a toolbar click
 * (captureVisibleTab needs it in production; select-flow.spec.ts covers that with the e2e build).
 */
const SOURCE = ts
  .transpileModule(readFileSync('src/shared/capture.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  .outputText.replace(/^export /gm, '');

/** Opens an extension page and loads the capture helpers into it as `globalThis.__capture`. */
async function pageWithHelpers(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.welcome}`);
  await page.evaluate(
    `(() => { ${SOURCE}
      globalThis.__capture = { clipCropRect, scaleToMaxSide, encodeWithinSessionQuota, newCaptureId,
        parseResultHash, validRect, errorResultHash, MAX_CROP_SIDE, JPEG_QUALITY_LADDER };
    })()`,
  );
  return page;
}

test('1) crop math + PNG encode + session round-trip (happy path)', async ({
  context,
  extensionId,
}) => {
  const page = await pageWithHelpers(context, extensionId);
  const happy = await page.evaluate(async () => {
    const lib = (globalThis as unknown as { __capture: Lib }).__capture;
    const W = 400;
    const H = 300;
    const src = new OffscreenCanvas(W, H);
    const sctx = src.getContext('2d');
    if (sctx === null) throw new Error('no 2d context');
    sctx.fillStyle = '#2244aa';
    sctx.fillRect(0, 0, W, H);
    sctx.fillStyle = '#ffffff';
    sctx.font = '48px sans-serif';
    sctx.fillText('Aa', 40, 120);
    const shotBuf = new Uint8Array(
      await (await src.convertToBlob({ type: 'image/png' })).arrayBuffer(),
    );
    let b64 = '';
    for (let i = 0; i < shotBuf.length; i += 0x8000)
      b64 += String.fromCharCode(...shotBuf.subarray(i, i + 0x8000));
    const shotUrl = 'data:image/png;base64,' + btoa(b64);

    const bmp = await createImageBitmap(await (await fetch(shotUrl)).blob());
    const crop = lib.clipCropRect({ x: 20, y: 40, w: 200, h: 150 }, 1, bmp.width, bmp.height);
    const sized = lib.scaleToMaxSide(crop.w, crop.h, lib.MAX_CROP_SIDE);
    const cv = new OffscreenCanvas(sized.width, sized.height);
    cv.getContext('2d')?.drawImage(
      bmp,
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      0,
      0,
      sized.width,
      sized.height,
    );
    bmp.close();

    const dataUrl = await lib.encodeWithinSessionQuota(async ({ type, quality }) => {
      const blob = await cv.convertToBlob(
        type === 'image/jpeg' && quality !== undefined ? { type, quality } : { type },
      );
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000)
        s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return `data:${type};base64,` + btoa(s);
    });

    const id = lib.newCaptureId();
    await chrome.storage.session.set({ [id]: { dataUrl, text: 'Aa' } });
    const stored = (await chrome.storage.session.get(id))[id] as
      { dataUrl?: string; text?: string } | undefined;
    await chrome.storage.session.remove(id);
    return {
      mime: dataUrl.slice(5, dataUrl.indexOf(';')),
      storedOk: Boolean(stored?.dataUrl) && stored?.text === 'Aa',
      uuidKey: /^cap_[0-9a-f-]{36}$/.test(id),
      crop,
      sized,
      hashKind: lib.parseResultHash(id)?.kind,
    };
  });
  expect(happy.storedOk, 'session round-trip').toBe(true);
  expect(happy.uuidKey, 'the key is a UUID').toBe(true);
  expect(happy.hashKind).toBe('session');
  expect(happy.mime, 'a small crop stays PNG').toBe('image/png');
  expect(happy.crop).toEqual({ x: 20, y: 40, w: 200, h: 150 });
  expect(happy.sized).toEqual({ width: 200, height: 150, scale: 1 });
});

test('2) an oversized PNG budget falls back to the JPEG ladder', async ({
  context,
  extensionId,
}) => {
  const page = await pageWithHelpers(context, extensionId);
  const jpeg = await page.evaluate(async () => {
    const lib = (globalThis as unknown as { __capture: Lib }).__capture;
    // Smooth gradient: PNG stays large; JPEG compresses well (noise would defeat JPEG too).
    const side = 800;
    const cv = new OffscreenCanvas(side, side);
    const c = cv.getContext('2d');
    if (c === null) throw new Error('no 2d context');
    const g = c.createLinearGradient(0, 0, side, side);
    g.addColorStop(0, '#c04040');
    g.addColorStop(1, '#4040c0');
    c.fillStyle = g;
    c.fillRect(0, 0, side, side);

    const tinyBudget = 100_000; // chars; gradient PNG ≫ this, JPEG ≪ this
    const calls: { type: string; quality: number | undefined }[] = [];
    const dataUrl = await lib.encodeWithinSessionQuota(async ({ type, quality }) => {
      calls.push({ type, quality });
      const blob = await cv.convertToBlob(
        type === 'image/jpeg' && quality !== undefined ? { type, quality } : { type },
      );
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000)
        s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return `data:${type};base64,` + btoa(s);
    }, tinyBudget);
    return {
      mime: dataUrl.slice(5, dataUrl.indexOf(';')),
      bytes: dataUrl.length,
      budget: tinyBudget,
      firstJpegQuality: calls.find((x) => x.type === 'image/jpeg')?.quality,
      ladder0: lib.JPEG_QUALITY_LADDER[0],
      callTypes: calls.map((x) => x.type),
    };
  });
  expect(jpeg.mime).toBe('image/jpeg');
  expect(jpeg.callTypes[0], 'PNG is tried first').toBe('image/png');
  expect(jpeg.firstJpegQuality, 'the ladder starts at its highest quality').toBe(jpeg.ladder0);
  expect(jpeg.bytes, 'the JPEG fits the budget').toBeLessThanOrEqual(jpeg.budget);
});

test('3) an err= hash is understood by the helpers and shown on the result page', async ({
  context,
  extensionId,
}) => {
  const page = await pageWithHelpers(context, extensionId);
  const hash = await page.evaluate(() => {
    const lib = (globalThis as unknown as { __capture: Lib }).__capture;
    return lib.errorResultHash('smoke storage failure');
  });
  expect(hash).toBe('err=' + encodeURIComponent('smoke storage failure'));
  expect(
    await page.evaluate((h) => {
      const lib = (globalThis as unknown as { __capture: Lib }).__capture;
      return lib.parseResultHash(h);
    }, hash),
  ).toEqual({ kind: 'error', message: 'smoke storage failure' });

  const result = await context.newPage();
  await result.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}#${hash}`);
  await expect(result.locator('#status')).toHaveText(
    'Capture failed: smoke storage failure — try again or paste a screenshot.',
  );
  await expect(result.locator('#status')).toHaveClass(/err/);
});

test('4) the selection message: validRect and the shape of what the overlay sends', async ({
  context,
  extensionId,
}) => {
  const page = await pageWithHelpers(context, extensionId);
  const shape = await page.evaluate(() => {
    const lib = (globalThis as unknown as { __capture: Lib }).__capture;
    return {
      good: lib.validRect({ x: 1, y: 2, w: 30, h: 40 }),
      badZero: lib.validRect({ x: 0, y: 0, w: 0, h: 10 }),
      badNaN: lib.validRect({ x: NaN, y: 0, w: 10, h: 10 }),
    };
  });
  expect(shape).toEqual({ good: true, badZero: false, badNaN: false });
  expect(readFileSync('src/select/overlay.ts', 'utf8')).toContain("type: 'fontsnap-rect'");
});

test('the service worker stays registered through all of the above', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  const page = await pageWithHelpers(context, extensionId);
  await page.evaluate(() => chrome.storage.session.get(null));
  expect(context.serviceWorkers().some((worker) => worker.url().includes(extensionId))).toBe(true);
  expect(await serviceWorker.evaluate(() => chrome.runtime.id)).toBe(extensionId);
});
