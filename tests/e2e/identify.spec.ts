import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, openResultPage, test } from './fixtures';

// The real, minified extension on real screenshots: the first 24 images of realset3 are fed to the result page
// (upload mode) and the visible top-5 (name and percent of every card) and the final status must equal the
// ones the same images gave before the move to TypeScript and terser (tests/fixtures/chrome-top5.json, a slice
// of the full 263-image run). A change in the minifier, the runtime, the model or any pipeline step shows here.
type Card = [name: string, percent: string];
const EXPECTED = JSON.parse(readFileSync('tests/fixtures/chrome-top5.json', 'utf8')) as Record<
  string,
  string[][]
>;
const IMAGES = Object.keys(EXPECTED);
const CHUNK = 8; // three tests, so that the images run on parallel workers

for (let start = 0; start < IMAGES.length; start += CHUNK) {
  const names = IMAGES.slice(start, start + CHUNK);

  test(`identifies realset3 images ${String(start + 1)}-${String(start + names.length)} as before`, async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(120_000);
    const page = await openResultPage(context, extensionId);
    const status = page.locator('#status');
    await expect(status).toHaveText('Ready. Paste, drop or choose an image.', { timeout: 60_000 });
    for (const image of names) {
      await page.evaluate(() => {
        const results = document.getElementById('results');
        const note = document.getElementById('status');
        if (results) results.replaceChildren();
        if (note) note.textContent = '...';
      });
      await page.locator('#file').setInputFiles(join('data', 'realset3', 'images', image));
      await page.waitForFunction(() => {
        const note = document.getElementById('status');
        const shown = document.querySelectorAll('#results li').length > 0;
        return (
          Boolean(note) &&
          shown &&
          note?.textContent !== '...' &&
          note?.textContent !== 'Analyzing…'
        );
      });
      const cards = await page
        .locator('#results li')
        .evaluateAll((items) =>
          items.map((li): Card => [
            li.querySelector('.name')?.textContent ?? '',
            li.querySelector('.meta')?.textContent ?? '',
          ]),
        );
      const shown = [...cards, ['status', (await status.textContent()) ?? ''] as Card];
      expect(shown, image).toEqual(EXPECTED[image]);
    }
  });
}

test('shows nothing but the result: no recognition time anywhere on the page', async ({
  context,
  extensionId,
}) => {
  const page = await openResultPage(context, extensionId);
  await expect(page.locator('#status')).toHaveText('Ready. Paste, drop or choose an image.', {
    timeout: 60_000,
  });
  await page.locator('#file').setInputFiles(join('data', 'realset3', 'images', IMAGES[0] ?? ''));
  await expect(page.locator('#results li').first()).toBeVisible();
  await expect(page.locator('#status')).toHaveText('');
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\b\d+(\.\d+)?\s?(ms|sec|seconds?)\b/i);
  // results below 1% are hidden: no card shows "0%"
  expect(text).not.toMatch(/(^|\D)0%/);
});

test('upload mode on its own: an unreadable file and a page without text are reported, not guessed', async ({
  context,
  extensionId,
}, testInfo) => {
  const page = await openResultPage(context, extensionId);
  await expect(page.locator('#status')).toHaveText('Ready. Paste, drop or choose an image.', {
    timeout: 60_000,
  });
  await page.locator('#file').setInputFiles({
    name: 'not-an-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from('this is not a PNG'),
  });
  await expect(page.locator('#status')).toHaveText('Could not read this image.');
  await expect(page.locator('#status')).toHaveClass(/err/);
  expect(testInfo.errors).toEqual([]);
});
