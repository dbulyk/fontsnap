import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { extensionDir, HERE, messages, RAW, useListingFonts } from './paths';

const ext = extensionDir();
const loc = process.env['LOC'] ?? 'en'; // folder name, e.g. pt_BR
const cl = loc.replace('_', '-');
const OUT = `${RAW}/${loc}`;
mkdirSync(OUT, { recursive: true });
const M = messages(ext, loc);
useListingFonts();
const ctx = await chromium.launchPersistentContext(
  mkdtempSync(join(tmpdir(), `fs-shots-${loc}-`)),
  {
    headless: true,
    channel: 'chromium',
    viewport: { width: 1280, height: 800 },
    locale: cl,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, `--lang=${cl}`],
  },
);
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 30000 }));
const id = sw.url().split('/')[2] ?? '';
const ui = await sw.evaluate(() => chrome.i18n.getUILanguage());
await new Promise((r) => setTimeout(r, 2000));
const page = await ctx.newPage();
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
const out: Record<string, unknown> = { loc, ui };
const got: Record<string, string | undefined> = {};
async function recog(sample: string, name: string, panel: boolean) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`chrome-extension://${id}/${EXTENSION_PAGES.result}`);
  await page.waitForFunction(
    () => {
      const t = document.getElementById('status')?.textContent ?? '';
      return t !== '' && !/…$|\.\.\.$/.test(t.trim());
    },
    null,
    { timeout: 180000 },
  );
  await page.setInputFiles('#file', `${HERE}${sample}`);
  await page.waitForSelector('#results li', { timeout: 120000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1800);
  const names = await page.$$eval('#results li', (e) =>
    e.map((x) => (x as HTMLElement).innerText.split('\n')[0]),
  );
  got[name] = names[0];
  out[name] = { got: names, status: await page.textContent('#status') };
  await page.screenshot({ path: `${OUT}/result_${name}.png` });
  if (panel) {
    await page.evaluate(() => {
      const r = document.querySelector<HTMLElement>('section.right');
      if (r === null) throw new Error('no results panel');
      r.style.padding = '14px';
      r.style.background = '#f4f4f5';
    });
    await page.locator('section.right').screenshot({ path: `${OUT}/panel_${name}.png` });
  }
}
await recog('sample_abril.png', 'abril', true);
const taglineShown = (await page.textContent('header .sub')) ?? '';
out['taglineShown'] = taglineShown;
out['taglineExpected'] = M('tagline');
out['localized'] = taglineShown.trim() === M('tagline').trim();
await recog('sample_lobster.png', 'lobster', true);
await recog('sample_bebas.png', 'bebas', false);
await recog('sample_playfair.png', 'playfair', false);
await page.goto(`chrome-extension://${id}/${EXTENSION_PAGES.welcome}?pinned=1#usage`);
await page.waitForTimeout(1200);
out['dir'] = await page.evaluate(() => document.documentElement.dir);
await page.screenshot({ path: `${OUT}/welcome_usage.png` });
// The real select.js with the localized hint, on a demo page.
const demo = await ctx.newPage();
await demo.setViewportSize({ width: 1280, height: 800 });
await demo.setContent(
  `<link href="https://fonts.googleapis.com/css2?family=Abril+Fatface&family=Lato&display=block" rel="stylesheet"><body style="margin:0;font-family:Lato;background:#fafaf9"><nav style="padding:22px 60px;font-weight:bold;border-bottom:1px solid #e7e5e4">STUDIO&nbsp;NORTH</nav><div style="padding:80px 60px"><h1 style="font-family:'Abril Fatface';font-size:96px;margin:0;color:#1c1917">Bold ideas,<br>beautiful type.</h1><p style="font-size:22px;color:#57534e;max-width:640px">A creative studio for brands that care about details.</p></div></body>`,
);
await demo.evaluate(() => document.fonts.ready);
// A string, not a function: tsx would wrap the stub's arrow functions in a __name helper the page lacks.
await demo.evaluate(
  `window.chrome = window.chrome || {}; chrome.i18n = { getMessage: () => ${JSON.stringify(M('selectHint'))}, getUILanguage: () => 'en' }; chrome.runtime = { sendMessage() {}, id: 'x' };`,
);
await demo.addScriptTag({ path: `${ext}/select.js` });
await demo.waitForTimeout(300);
await demo.mouse.move(40, 135);
await demo.mouse.down();
await demo.mouse.move(760, 410, { steps: 6 });
await demo.waitForTimeout(300);
await demo.screenshot({ path: `${OUT}/select.png` });
writeFileSync(`${OUT}/results.json`, JSON.stringify({ ...out, errs }, null, 1));
console.log(
  JSON.stringify({
    loc,
    ui,
    localized: out['localized'],
    ...got,
    dir: out['dir'],
    errs: errs.slice(0, 3),
  }),
);
await ctx.close();
