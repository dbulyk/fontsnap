import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { MAX_PREVIEW_GRAPHEMES } from '../../src/shared/graphemes';
import { DIGITS, sampleOf } from '../../src/shared/samples';
import { expect, test } from './fixtures';

const ARABIC = join('tests', 'fixtures', 'w14_0071_1.png');
const JAPANESE = join('tests', 'fixtures', 'w35_0003_0.png');
const LATIN = join('data', 'realset3', 'images', 'w0_0010_1.png');

const ruSample = sampleOf('ru')?.text ?? '';
const arSample = sampleOf('ar')?.text ?? '';
const jaSample = sampleOf('ja')?.text ?? '';

async function identifyFile(page: Page, extensionId: string, file: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}`);
  await expect(page.locator('#status')).toHaveText(/Ready|Готово|Identifying|Определяем/, {
    timeout: 60_000,
  });
  await page.locator('#file').setInputFiles(file);
  await expect(page.locator('#results li').first()).toBeVisible({ timeout: 120_000 });
}

test.describe('ru UI automatic sample', () => {
  test.use({ uiLocale: 'ru' });

  test('upload without page hints shows the Russian pangram and digits', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await identifyFile(page, extensionId, LATIN);
    await expect(page.locator('#pvText')).toHaveValue('');
    const ph = await page.locator('#pvText').getAttribute('placeholder');
    expect(ph ?? '').not.toContain('The quick brown fox');
    // Rule B is silent on a Latin fixture; UI ru picks the Cyrillic sample. Latin-only
    // faces fall back to English (glyph check), so assert a Cyrillic-capable card, not #1.
    const cyrillic = page.locator('.sample').filter({ hasText: ruSample });
    await expect(cyrillic.first()).toBeVisible();
    await expect(cyrillic.first()).toContainText(DIGITS);
    await expect(cyrillic.first()).toHaveAttribute('lang', 'ru');
  });
});

test('Arabic fixture shows Arabic pangram with dir=auto', async ({ context, extensionId }) => {
  const page = await context.newPage();
  const css: string[] = [];
  await context.route('https://fonts.googleapis.com/css2*', async (route) => {
    css.push(route.request().url());
    await route.fulfill({
      contentType: 'text/css',
      body: '@font-face { font-family: Test; src: local(Arial); }',
    });
  });
  await identifyFile(page, extensionId, ARABIC);
  const sample = page.locator('.sample').first();
  await expect(sample).toContainText(arSample);
  await expect(sample).toHaveAttribute('dir', 'auto');
  await expect(sample).toHaveAttribute('lang', 'ar');
  expect(css.every((u) => !u.includes('text='))).toBe(true);
});

test('Japanese fixture shows the Japanese sample', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await context.route('https://fonts.googleapis.com/css2*', async (route) => {
    await route.fulfill({
      contentType: 'text/css',
      body: '@font-face { font-family: Test; src: local(Arial); }',
    });
  });
  await identifyFile(page, extensionId, JAPANESE);
  const sample = page.locator('.sample').first();
  await expect(sample).toContainText(jaSample);
  await expect(sample).toHaveAttribute('lang', 'ja');
});

test('typed text replaces the sample; clearing restores it', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await identifyFile(page, extensionId, LATIN);
  await page.locator('#pvText').fill('Custom preview');
  await expect(page.locator('.sample').first()).toHaveText('Custom preview');
  await page.locator('#pvText').fill('');
  await expect(page.locator('.sample').first()).toContainText(DIGITS);
});

test('loader is visible while identifying and clears aria-busy after', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}`);
  await expect(page.locator('#status')).toHaveText(/Ready/, { timeout: 60_000 });
  await page.locator('#file').setInputFiles(LATIN);
  await expect(page.locator('#resultsPanel')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#loader')).toBeVisible();
  await expect(page.locator('#loaderLabel')).toContainText(/Identifying|Определяем/);
  await expect(page.locator('#results li').first()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#resultsPanel')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#loader')).toBeHidden();
});

test('preview field fills to exactly 100 graphemes and refuses the 101st', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await identifyFile(page, extensionId, LATIN);
  const hundred = 'a'.repeat(MAX_PREVIEW_GRAPHEMES);
  await page.locator('#pvText').fill(hundred);
  await expect(page.locator('#pvLimit')).toHaveText('100/100');
  await expect(page.locator('#pvLimit')).toHaveClass(/limit/);
  await page.locator('#pvText').pressSequentially('x');
  await expect(page.locator('#pvText')).toHaveValue(hundred);
  await page.locator('#pvText').fill('');
  await page.locator('#pvText').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.focus();
  });
  await page.locator('#pvText').pressSequentially('z'.repeat(MAX_PREVIEW_GRAPHEMES + 20));
  await expect(page.locator('#pvText')).toHaveValue('z'.repeat(MAX_PREVIEW_GRAPHEMES));
  await expect(page.locator('#pvLimit')).toHaveText('100/100');
});

test('mid-string typing at 100/100 is refused without eating the tail', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await identifyFile(page, extensionId, LATIN);
  const hundred = 'abcdefghij'.repeat(10);
  await page.locator('#pvText').fill(hundred);
  await page.locator('#pvText').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.focus();
    input.setSelectionRange(10, 10);
  });
  await page.locator('#pvText').press('X');
  await expect(page.locator('#pvText')).toHaveValue(hundred);
  const pos = await page
    .locator('#pvText')
    .evaluate((el) => (el as HTMLInputElement).selectionStart);
  expect(pos).toBe(10);
  await expect(page.locator('#pvLimit')).toHaveText('100/100');
});

test('image paste works while the preview field is focused', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await identifyFile(page, extensionId, LATIN);
  await page.locator('#pvText').click();
  await page.locator('#pvText').fill('typed');
  await expect(page.locator('.sample').first()).toHaveText('typed');
  // Document paste handler must still accept an image when #pvText is focused (regression vs main).
  // Do not fetch(data:…): result page CSP is connect-src 'self' (see src/shared/data-url.ts).
  // ClipboardEventInit.clipboardData must be a real DataTransfer (a plain object is refused).
  const pngBase64 = readFileSync(ARABIC).toString('base64');
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const file = new File([bytes], 'paste.png', { type: 'image/png' });
    const data = new DataTransfer();
    data.items.add(file);
    document.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, pngBase64);
  await expect(page.locator('#resultsPanel')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#results li').first()).toBeVisible({ timeout: 120_000 });
  await expect(page.locator('#resultsPanel')).toHaveAttribute('aria-busy', 'false');
});

test('IME commit at 100/100 mid-string restores the snapshot instead of eating the tail', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await identifyFile(page, extensionId, LATIN);
  const hundred = 'abcdefghij'.repeat(10);
  await page.locator('#pvText').fill(hundred);
  await page.locator('#pvText').evaluate((el) => {
    const input = el as HTMLInputElement;
    input.focus();
    input.setSelectionRange(10, 10);
  });
  const cdp = await page.context().newCDPSession(page);
  // Real Chromium IME: composition then commit at the caret.
  await cdp.send('Input.imeSetComposition', {
    text: 'か',
    selectionStart: 1,
    selectionEnd: 1,
  });
  await cdp.send('Input.insertText', { text: 'か' });
  await expect(page.locator('#pvText')).toHaveValue(hundred);
  const pos = await page
    .locator('#pvText')
    .evaluate((el) => (el as HTMLInputElement).selectionStart);
  expect(pos).toBe(10);
  await expect(page.locator('#pvLimit')).toHaveText('100/100');
});

test('text+image clipboard with preview focused pastes text only', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await identifyFile(page, extensionId, LATIN);
  const topName = await page.locator('#results .name').first().textContent();
  await page.locator('#pvText').click();
  const pngBase64 = readFileSync(ARABIC).toString('base64');
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const file = new File([bytes], 'paste.png', { type: 'image/png' });
    const data = new DataTransfer();
    data.setData('text/plain', 'TXT');
    data.items.add(file);
    const input = document.getElementById('pvText');
    if (!(input instanceof HTMLInputElement)) throw new Error('#pvText');
    input.focus();
    input.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data,
      }),
    );
  }, pngBase64);
  await expect(page.locator('#pvText')).toHaveValue('TXT');
  await expect(page.locator('.sample').first()).toHaveText('TXT');
  await expect(page.locator('#resultsPanel')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#results .name').first()).toHaveText(topName ?? '');
});
