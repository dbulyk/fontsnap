/* global chrome, OffscreenCanvas, createImageBitmap -- evaluated inside the extension page */
/**
 * Capture-handoff smoke (Playwright + Chromium).
 *
 * Exercises the real browser APIs used after a screenshot lands in the SW:
 * OffscreenCanvas crop → encodeWithinSessionQuota (PNG / JPEG ladder) →
 * chrome.storage.session → result hash handoff helpers.
 *
 * Runs inside an extension page (not the SW): ServiceWorkerGlobalScope disallows
 * dynamic import() from DevTools/Playwright evaluate. Static imports in
 * background.js still load the same capture.js module in production.
 *
 * Does NOT require a user-gesture activeTab grant (captureVisibleTab still needs
 * that in production). Documented residual: no synthetic gesture for the shot
 * API itself; everything after the shot is covered here and in unit tests.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

function resolveChrome() {
  // Prefer Playwright Chromium (supports --load-extension). Branded Chrome 137+ does not.
  try {
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {
    // playwright browser not installed
  }
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  for (const c of ['/usr/bin/chromium-browser', '/usr/bin/chromium']) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error('Playwright Chromium not found. Run: npx playwright install chromium');
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'fontsnap-cap-smoke-'));
  const executablePath = resolveChrome();
  // Extensions require a non-headless context; CI runs this under xvfb-run.
  const ctx = await chromium.launchPersistentContext(userData, {
    headless: false,
    executablePath,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-sandbox', '--disable-gpu'],
  });

  const cleanup = async () => {
    await ctx.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  };

  try {
    const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 30000 }));
    const extId = new URL(sw.url()).host;
    console.log('extension:', extId, 'chrome:', executablePath);

    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/welcome.html`, { waitUntil: 'domcontentloaded' });

    // --- 1) Crop math + PNG encode + session round-trip (happy path) ---
    const happy = await page.evaluate(async () => {
      const { clipCropRect, scaleToMaxSide, encodeWithinSessionQuota, newCaptureId, MAX_CROP_SIDE, parseResultHash } = await import(
        chrome.runtime.getURL('lib/capture.js')
      );

      const W = 400,
        H = 300;
      const src = new OffscreenCanvas(W, H);
      const sctx = src.getContext('2d');
      sctx.fillStyle = '#2244aa';
      sctx.fillRect(0, 0, W, H);
      sctx.fillStyle = '#ffffff';
      sctx.font = '48px sans-serif';
      sctx.fillText('Aa', 40, 120);
      const shotBlob = await src.convertToBlob({ type: 'image/png' });
      const shotBuf = new Uint8Array(await shotBlob.arrayBuffer());
      let b64 = '';
      for (let i = 0; i < shotBuf.length; i += 0x8000) b64 += String.fromCharCode(...shotBuf.subarray(i, i + 0x8000));
      const shotUrl = 'data:image/png;base64,' + btoa(b64);

      const bmp = await createImageBitmap(await (await fetch(shotUrl)).blob());
      const rect = { x: 20, y: 40, w: 200, h: 150 };
      const crop = clipCropRect(rect, 1, bmp.width, bmp.height);
      const sized = scaleToMaxSide(crop.w, crop.h, MAX_CROP_SIDE);
      const cv = new OffscreenCanvas(sized.width, sized.height);
      cv.getContext('2d').drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, sized.width, sized.height);
      bmp.close();

      const dataUrl = await encodeWithinSessionQuota(async ({ type, quality }) => {
        const blob = await cv.convertToBlob(type === 'image/jpeg' ? { type, quality } : { type });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return `data:${type};base64,` + btoa(s);
      });

      const id = newCaptureId();
      await chrome.storage.session.set({ [id]: { dataUrl, text: 'Aa' } });
      const back = (await chrome.storage.session.get(id))[id];
      await chrome.storage.session.remove(id);

      return {
        mime: dataUrl.slice(5, dataUrl.indexOf(';')),
        bytes: dataUrl.length,
        storedOk: Boolean(back?.dataUrl && back.text === 'Aa'),
        crop,
        sized,
        hashKind: parseResultHash(id)?.kind,
      };
    });

    if (!happy.storedOk) throw new Error(`session round-trip failed: ${JSON.stringify(happy)}`);
    if (happy.hashKind !== 'session') throw new Error(`parseResultHash kind=${happy.hashKind}`);
    if (happy.mime !== 'image/png') throw new Error(`expected PNG for small crop, got ${happy.mime}`);
    console.log('ok happy-path crop→PNG→session', { bytes: happy.bytes, crop: happy.crop, sized: happy.sized });

    // --- 2) Oversized PNG budget → JPEG ladder ---
    const jpeg = await page.evaluate(async () => {
      const { encodeWithinSessionQuota, JPEG_QUALITY_LADDER } = await import(chrome.runtime.getURL('lib/capture.js'));
      // Smooth gradient: PNG stays large; JPEG compresses well (noise would defeat JPEG too).
      const side = 800;
      const cv = new OffscreenCanvas(side, side);
      const c = cv.getContext('2d');
      const g = c.createLinearGradient(0, 0, side, side);
      g.addColorStop(0, '#c04040');
      g.addColorStop(1, '#4040c0');
      c.fillStyle = g;
      c.fillRect(0, 0, side, side);

      const tinyBudget = 100_000; // chars; gradient PNG ≫ this, JPEG ≪ this
      const calls = [];
      const dataUrl = await encodeWithinSessionQuota(async ({ type, quality }) => {
        calls.push({ type, quality });
        const blob = await cv.convertToBlob(type === 'image/jpeg' ? { type, quality } : { type });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return `data:${type};base64,` + btoa(s);
      }, tinyBudget);

      return {
        mime: dataUrl.slice(5, dataUrl.indexOf(';')),
        bytes: dataUrl.length,
        budget: tinyBudget,
        triedJpeg: calls.some((x) => x.type === 'image/jpeg'),
        firstJpegQ: calls.find((x) => x.type === 'image/jpeg')?.quality,
        ladder0: JPEG_QUALITY_LADDER[0],
        callTypes: calls.map((x) => x.type),
      };
    });

    if (jpeg.mime !== 'image/jpeg') throw new Error(`expected JPEG fallback, got ${jpeg.mime} (${JSON.stringify(jpeg)})`);
    if (!jpeg.triedJpeg || jpeg.firstJpegQ !== jpeg.ladder0) throw new Error(`JPEG ladder not used: ${JSON.stringify(jpeg)}`);
    if (jpeg.bytes > jpeg.budget) throw new Error(`JPEG still over budget: ${jpeg.bytes} > ${jpeg.budget}`);
    console.log('ok JPEG ladder under tiny budget', { bytes: jpeg.bytes, calls: jpeg.callTypes });

    // --- 3) err= hash parse (openResult storage-failure fallback) ---
    const errHash = 'err=' + encodeURIComponent('smoke storage failure');
    await page.goto(`chrome-extension://${extId}/result.html#${errHash}`, { waitUntil: 'domcontentloaded' });
    const parsed = await page.evaluate(async (hash) => {
      const { parseResultHash } = await import(chrome.runtime.getURL('lib/capture.js'));
      return parseResultHash(hash);
    }, errHash);
    if (parsed?.kind !== 'error' || parsed.message !== 'smoke storage failure') {
      throw new Error(`err= hash parse failed: ${JSON.stringify(parsed)}`);
    }
    console.log('ok result err= hash parse on extension page');

    // --- 4) fontsnap-rect message shape / validRect (select.js contract) ---
    const msgShape = await page.evaluate(async () => {
      const { validRect } = await import(chrome.runtime.getURL('lib/capture.js'));
      return {
        good: validRect({ x: 1, y: 2, w: 30, h: 40 }),
        badZero: validRect({ x: 0, y: 0, w: 0, h: 10 }),
        selectShape: { type: 'fontsnap-rect', rect: { x: 10, y: 10, w: 100, h: 40 }, dpr: 1, text: 'Hello' },
      };
    });
    if (!msgShape.good || msgShape.badZero) throw new Error(`validRect smoke failed: ${JSON.stringify(msgShape)}`);
    if (msgShape.selectShape.type !== 'fontsnap-rect') throw new Error('select message shape drift');
    console.log('ok fontsnap-rect message shape / validRect');

    // Confirm SW stayed alive / registered (background.js module loaded).
    if (!ctx.serviceWorkers().some((w) => w.url().includes(extId))) {
      throw new Error('service worker disappeared during smoke');
    }
    console.log('ok service worker still registered');

    console.log('CAPTURE_SMOKE_OK');
    await cleanup();
  } catch (e) {
    console.error('CAPTURE_SMOKE_FAIL:', e?.stack || e);
    await cleanup();
    process.exit(1);
  }
}

await main();
