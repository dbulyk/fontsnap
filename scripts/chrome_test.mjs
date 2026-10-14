import { chromium } from 'playwright-core'; import fs from 'fs';
const ext = '/workspace/fontsnap-extension';
const ctx = await chromium.launchPersistentContext('/tmp/fs-prof-' + Date.now(), { headless: true, executablePath: chromium.executablePath(), args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = sw.url().split('/')[2]; const page = await ctx.newPage(); const errs = [];
page.on('console', m => m.type() === 'error' && errs.push(m.text())); page.on('pageerror', e => errs.push(e.message));
await page.goto(`chrome-extension://${id}/result.html`);
await page.waitForFunction(() => /Ready|failed/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
console.log('status:', await page.textContent('#status'), 'COI:', await page.evaluate(() => crossOriginIsolated));
const rows = JSON.parse(fs.readFileSync('labels.json')).slice(0, +process.argv[2] || 30); let ok1 = 0, ok5 = 0, n = 0; const out = {};
const nz = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
for (const [im, lab] of rows) {
  await page.evaluate(() => { document.getElementById('status').textContent = '...'; });
  await page.setInputFiles('#file', `/workspace/fontsnap-eval/realset3/images/${im}`);
  await page.waitForFunction(() => /Done|No clear|Error/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
  const names = await page.$$eval('#results .name', e => e.map(x => x.textContent.replace(/^\d+\.\s*/, '')));
  out[im] = names; n++; const l = nz(lab); ok1 += nz(names[0]) === l; ok5 += names.some(x => nz(x) === l);
}
console.log('status last:', await page.textContent('#status'));
await page.screenshot({ path: '/workspace/fontsnap-ext-work/result_screenshot.png', fullPage: true });
fs.writeFileSync('chrome_top5.json', JSON.stringify(out)); console.log(`chrome n=${n} raw-name top1 ${ok1} top5 ${ok5}`, 'errors:', errs.slice(0, 5));
await ctx.close();
