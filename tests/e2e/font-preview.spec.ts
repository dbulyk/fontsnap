import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { EXTENSION_PAGES } from '../../src/shared/constants';

// The font previews of the result page: a <link rel=stylesheet> to fonts.googleapis.com whose CSS names the font files on
// fonts.gstatic.com (@font-face). Neither is a fetch, so the CSP `connect-src 'self'` must not touch them (a <link> is
// style-src, @font-face is font-src, and the CSP sets neither). There is no network in e2e: both hosts are answered by
// context.route, the font by a 312-byte WOFF2 (tests/fixtures/font-preview.woff2, made with fontTools' FontBuilder).
const WOFF2 = readFileSync('tests/fixtures/font-preview.woff2');
const GSTATIC = 'https://fonts.gstatic.com/s/test/preview.woff2';
const IMAGE = join('data', 'realset3', 'images', 'w0_0010_1.png');

interface Violation {
  directive: string;
  blocked: string;
}

/** Records every securitypolicyviolation of the page, from before its own scripts run. */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: { directive: string; blocked: string }[] = [];
    (window as unknown as { __violations: typeof seen }).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ directive: event.violatedDirective, blocked: event.blockedURI });
    });
  });
}
const violationsOf = (page: Page): Promise<Violation[]> =>
  page.evaluate(() => (window as unknown as { __violations: Violation[] }).__violations);

test('the font previews load through <link> and @font-face, outside connect-src: no CSP violation', async ({
  context,
  extensionId,
}) => {
  const css: string[] = [];
  const fonts: string[] = [];
  await context.route('https://fonts.googleapis.com/css2*', async (route) => {
    const url = new URL(route.request().url());
    css.push(url.href);
    const family = (url.searchParams.get('family') ?? '').replace(/\+/g, ' ');
    await route.fulfill({
      contentType: 'text/css; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: `@font-face { font-family: '${family}'; font-style: normal; font-weight: 400; src: url(${GSTATIC}); }`,
    });
  });
  await context.route('https://fonts.gstatic.com/**', async (route) => {
    fonts.push(route.request().url());
    await route.fulfill({
      contentType: 'font/woff2',
      headers: { 'access-control-allow-origin': '*' },
      body: WOFF2,
    });
  });

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await recordViolations(page);
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}`);
  await expect(page.locator('#status')).toHaveText('Ready. Paste, drop or choose an image.', {
    timeout: 60_000,
  });
  await page.locator('#file').setInputFiles(IMAGE);
  await expect(page.locator('#results li').first()).toBeVisible();

  // the first result that is on Google Fonts (it has the specimen link) is previewed with its own family
  const card = page
    .locator('#results li', { has: page.locator('a[href^="https://fonts.google.com/specimen/"]') })
    .first();
  const family = ((await card.locator('.name').textContent()) ?? '').replace(/^\d+\.\s*/, '');
  expect(family, 'a result on Google Fonts').not.toBe('');

  await expect
    .poll(() => css.length, { message: 'the stylesheet is requested' })
    .toBeGreaterThan(0);
  const plus = encodeURIComponent(family).replace(/%20/g, '+');
  expect(css).toContain(`https://fonts.googleapis.com/css2?family=${plus}&display=swap`);
  for (const url of css)
    expect(url).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=[^&]+&display=swap$/);
  await expect
    .poll(() => fonts.length, { message: 'the font file is requested' })
    .toBeGreaterThan(0);
  expect(new Set(fonts)).toEqual(new Set([GSTATIC]));

  // the stylesheet is in the document and the family is really loaded
  const state = await page.evaluate(async (name) => {
    await document.fonts.load(`16px '${name}'`);
    return {
      sheets: [...document.styleSheets].map((sheet) => sheet.href ?? ''),
      faces: [...document.fonts]
        .filter((face) => face.family.replace(/['"]/g, '') === name)
        .map((face) => face.status),
    };
  }, family);
  expect(state.sheets).toContain(`https://fonts.googleapis.com/css2?family=${plus}&display=swap`);
  expect(state.faces).toEqual(['loaded']);

  expect(await violationsOf(page), 'no securitypolicyviolation').toEqual([]);
  expect(consoleErrors.filter((text) => /content security policy|refused to/i.test(text))).toEqual(
    [],
  );
});

test('the listener sees a violation: a fetch of the font host from the page is refused by connect-src', async ({
  context,
  extensionId,
}) => {
  await context.route('https://fonts.gstatic.com/**', (route) =>
    route.fulfill({ contentType: 'font/woff2', body: WOFF2 }),
  );
  const page = await context.newPage();
  await recordViolations(page);
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}`);
  const outcome = await page.evaluate(async (url) => {
    try {
      await fetch(url);
      return 'fetched';
    } catch (error) {
      return error instanceof TypeError ? 'refused' : 'other';
    }
  }, GSTATIC);
  expect(outcome).toBe('refused');
  await expect
    .poll(() => violationsOf(page))
    .toEqual([{ directive: 'connect-src', blocked: GSTATIC }]);
});
