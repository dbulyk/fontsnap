import { chromium } from '@playwright/test';
import { HERE } from './paths';

const samples = [
  ['lobster', 'Lobster', 'Summer Sale', '#fff7ed', '#c2410c', 96, 400],
  ['playfair', 'Playfair Display', 'The Art of Typography', '#f8fafc', '#0f172a', 64, 400],
  ['bebas', 'Bebas Neue', 'BIG CITY NIGHTS', '#111827', '#facc15', 110, 400],
] as const;
const b = await chromium.launch({ channel: 'chromium' });
const p = await b.newPage({ viewport: { width: 900, height: 260 } });
for (const [id, fam, txt, bg, fg, sz, w] of samples) {
  await p.setContent(
    `<link href="https://fonts.googleapis.com/css2?family=${fam.replace(/ /g, '+')}&display=block" rel="stylesheet"><body style="margin:0;display:grid;place-items:center;height:260px;background:${bg}"><div style="font-family:'${fam}';font-size:${String(sz)}px;color:${fg};font-weight:${String(w)}">${txt}</div></body>`,
  );
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${HERE}sample_${id}.png` });
}
// Abril Fatface is two lines on a page-like crop.
await p.setViewportSize({ width: 720, height: 275 });
await p.setContent(
  `<link href="https://fonts.googleapis.com/css2?family=Abril+Fatface&display=block" rel="stylesheet"><body style="margin:0;background:#fafaf9"><h1 style="font-family:'Abril Fatface';font-size:96px;margin:0;padding:8px 20px;line-height:1.15;color:#1c1917">Bold ideas,<br>beautiful type.</h1></body>`,
);
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(400);
await p.screenshot({ path: `${HERE}sample_abril.png` });
await b.close();
