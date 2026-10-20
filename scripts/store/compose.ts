import { chromium } from '@playwright/test';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { extensionDir, HERE, messages, RAW, ROOT, useListingFonts } from './paths';

interface Captions {
  c1: string;
  c2: string;
  c3: string;
  c4: string;
  c5: string;
  sub: string;
}

const ext = extensionDir();
const OUTR = `${ROOT}store/graphics`;
const cap = JSON.parse(readFileSync(`${HERE}captions.json`, 'utf8')) as Record<
  string,
  Captions | undefined
>;
const only = process.argv.slice(2);
const F = (p: string) => 'data:image/png;base64,' + readFileSync(p).toString('base64');
const logo = F(`${OUTR}/logo512.png`);
const BG = 'linear-gradient(135deg,#4F46E5 0%,#7C3AED 55%,#A21CAF 100%)';
const cjk = new Map([
  ['ja', 'Noto Sans CJK JP'],
  ['ko', 'Noto Sans CJK KR'],
  ['zh_CN', 'Noto Sans CJK SC'],
  ['zh_TW', 'Noto Sans CJK TC'],
]);
const fontsFor = (loc: string) => {
  const local = cjk.get(loc);
  return `Inter,${local !== undefined ? `'${local}',` : ''}'Noto Sans','Noto Sans Arabic',Heebo,'Noto Sans Devanagari','Noto Sans Bengali','Noto Sans Gujarati','Noto Sans Tamil','Noto Sans Telugu','Noto Sans Kannada','Noto Sans Malayalam','Noto Sans Thai','Noto Sans Ethiopic','Noto Sans CJK SC',sans-serif`;
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const chrome = () =>
  `<div style="height:36px;background:#e8eaed;display:flex;align-items:center;gap:8px;padding:0 14px;direction:ltr"><i style="width:12px;height:12px;border-radius:50%;background:#ff5f57"></i><i style="width:12px;height:12px;border-radius:50%;background:#febc2e"></i><i style="width:12px;height:12px;border-radius:50%;background:#28c840"></i></div>`;
const win = (inner: string, w = 1088, h = 680) =>
  `<div style="width:${String(w)}px;height:${String(h)}px;border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);background:#fff;flex:none">${chrome()}<div style="position:relative;height:${String(h - 36)}px;overflow:hidden">${inner}</div></div>`;
useListingFonts();
const b = await chromium.launch({ channel: 'chromium' });
const p = await b.newPage();
async function render(file: string, w: number, h: number, loc: string, rtl: boolean, html: string) {
  await p.setViewportSize({ width: w, height: h });
  await p.setContent(`<html lang="${loc.replace('_', '-')}" dir="${rtl ? 'rtl' : 'ltr'}"><head><style>*{box-sizing:border-box}body{margin:0;font-family:${fontsFor(loc)};color:#fff;background:${BG};overflow:hidden;width:${String(w)}px;height:${String(h)}px}
.badge{display:inline-flex;align-items:center;background:rgba(255,255,255,.18);border:1.5px solid rgba(255,255,255,.55);border-radius:999px;font-weight:800;letter-spacing:.04em;line-height:1}</style></head><body>${html}</body></html>`);
  await p.evaluate(() => document.fonts.ready);
  // Shrink each [data-fit] text until it fits its box: translations differ a lot in length.
  await p.evaluate(() => {
    for (const c of document.querySelectorAll<HTMLElement>('[data-fit]')) {
      const max = Number(c.dataset['fit']);
      let s = parseFloat(getComputedStyle(c).fontSize);
      while ((c.scrollWidth > max || c.scrollHeight > c.clientHeight + 2) && s > 16) {
        s -= 1;
        c.style.fontSize = `${String(s)}px`;
      }
    }
  });
  await p.waitForTimeout(150);
  await p.screenshot({ path: file, type: 'png' });
}
const headline = (t: string) =>
  `<div data-fit="1200" style="font-size:38px;font-weight:800;letter-spacing:-0.5px;text-align:center;line-height:52px;height:52px;white-space:nowrap;max-width:1220px">${esc(t)}</div>`;
const shot = (t: string, body: string) =>
  `<div style="height:100%;display:flex;flex-direction:column;align-items:center;padding-top:30px;gap:26px">${headline(t)}${body}</div>`;
const locs = readdirSync(RAW)
  .filter((l) => only.length === 0 || only.includes(l))
  .sort();
for (const loc of locs) {
  const c = cap[loc];
  if (c === undefined) {
    console.log('no captions', loc);
    continue;
  }
  const R = (n: string) => F(`${RAW}/${loc}/${n}.png`);
  const M = messages(ext, loc);
  const rtl = ['ar', 'he', 'fa'].includes(loc);
  const side = 'right'; // demo pages are LTR, the panel always sits on the right
  const out = `${OUTR}/${loc}`;
  mkdirSync(out, { recursive: true });
  const panel = (img: string, top = 70, pw = 540) =>
    `<div style="position:absolute;${side}:22px;top:${String(top)}px;width:${String(pw)}px;border-radius:14px;overflow:hidden;box-shadow:0 18px 50px rgba(15,23,42,.48);border:1px solid rgba(255,255,255,.85);background:#f4f4f5"><img src="${img}" style="width:${String(pw)}px;display:block"></div>`;
  // 1: selection overlay on a page + result panel
  await render(
    `${out}/screenshot_1_1280x800.png`,
    1280,
    800,
    loc,
    rtl,
    shot(
      c.c1,
      win(
        `<img src="${R('select')}" style="width:1088px;display:block;direction:ltr">${panel(R('panel_abril'))}`,
      ),
    ),
  );
  // 2: right-click an image + result panel. Headless Chrome cannot capture a native menu, so it is
  // drawn: the item is the real localized ctxImage, the other items are grey placeholders.
  const menuItem = M('ctxImage');
  const bar = (wd: number) =>
    `<div style="height:28px;display:flex;align-items:center;padding:0 14px"><i style="display:block;height:9px;width:${String(wd)}px;border-radius:5px;background:#d4d4d8"></i></div>`;
  const page2 = `<div style="position:absolute;inset:0;background:#fafaf9;font-family:Lato,'Noto Sans',sans-serif;direction:ltr"><div style="padding:20px 48px;font-weight:700;color:#1c1917;border-bottom:1px solid #e7e5e4;font-size:15px">SUNNY&nbsp;MARKET</div>
   <img src="${F(`${HERE}sample_lobster.png`)}" style="position:absolute;left:48px;top:90px;width:560px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.08)">
   <div style="position:absolute;left:48px;top:270px;width:560px;color:#57534e;font-size:17px;line-height:1.5">Fresh fruit, local bread and flowers every weekend.</div></div>
   <div style="position:absolute;left:250px;top:190px;min-width:300px;max-width:370px;background:#fff;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.28);padding:6px 0;color:#1f1f1f;font-size:14px">
    ${bar(150)}${bar(120)}${bar(170)}<div style="height:1px;background:#e5e7eb;margin:5px 0"></div>
    <div style="height:34px;display:flex;align-items:center;gap:10px;padding:0 12px;background:#e8f0fe"><img src="${logo}" style="width:16px;height:16px"><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(menuItem)}</span></div>
    <div style="height:1px;background:#e5e7eb;margin:5px 0"></div>${bar(90)}</div>
   <svg style="position:absolute;left:242px;top:178px;width:22px" viewBox="0 0 24 24"><path d="M4 2l16 10-7 1.5 4 7.5-3 1.5-4-7.5L4 20z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>`;
  await render(
    `${out}/screenshot_2_1280x800.png`,
    1280,
    800,
    loc,
    rtl,
    shot(c.c2, win(`${page2}<div style="">${panel(R('panel_lobster'), 150, 430)}</div>`)),
  );
  // 3-5: full pages of the extension
  for (const [n, caption, raw] of [
    [3, c.c3, 'result_bebas'],
    [4, c.c4, 'result_playfair'],
    [5, c.c5, 'welcome_usage'],
  ] as const) {
    await render(
      `${out}/screenshot_${String(n)}_1280x800.png`,
      1280,
      800,
      loc,
      rtl,
      shot(caption, win(`<img src="${R(raw)}" style="width:1088px;display:block">`)),
    );
  }
  const sub = M('appName').replace(/^FontSnap\s*[:：]\s*/, '');
  await render(
    `${out}/promo_small_440x280.png`,
    440,
    280,
    loc,
    rtl,
    `<div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:16px 22px;text-align:center">
   <div style="display:flex;align-items:center;gap:12px;direction:ltr"><img src="${logo}" style="width:72px;filter:drop-shadow(0 8px 18px rgba(0,0,0,.25))"><div class="badge" style="font-size:18px;padding:7px 16px">AI</div></div>
   <div style="font-size:36px;font-weight:800;letter-spacing:-1px;line-height:1">FontSnap</div>
   <div data-fit="396" style="font-size:19px;font-weight:700;line-height:1.25;max-width:396px;max-height:52px;overflow:hidden">${esc(sub)}</div></div>`,
  );
  await render(
    `${out}/marquee_1400x560.png`,
    1400,
    560,
    loc,
    rtl,
    `<div style="display:flex;height:100%;align-items:center;padding:0 48px 0 64px;gap:44px">
   <div style="width:470px;flex:none">
    <div style="display:flex;align-items:center;gap:14px;direction:ltr"><img src="${logo}" style="width:84px;filter:drop-shadow(0 8px 18px rgba(0,0,0,.25))"><div class="badge" style="font-size:20px;padding:8px 18px">AI</div></div>
    <div style="font-size:60px;font-weight:800;letter-spacing:-2px;margin-top:14px;line-height:1.05">FontSnap</div>
    <div data-fit="470" style="font-size:30px;font-weight:700;line-height:1.2;margin-top:10px;max-height:80px;overflow:hidden">${esc(sub)}</div>
    <div data-fit="470" style="font-size:20px;font-weight:500;opacity:.92;margin-top:16px;line-height:1.35;max-height:58px;overflow:hidden">${esc(c.sub)}</div>
   </div>
   <div style="flex:1;height:480px;border-radius:14px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35);background:#f4f4f5">${chrome()}<img src="${R('result_lobster')}" style="width:100%;display:block"></div>
  </div>`,
  );
  console.log('ok', loc);
}
await b.close();
