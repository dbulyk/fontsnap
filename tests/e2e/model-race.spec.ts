import { expect, test } from './fixtures';
import { EXTENSION_PAGES } from '../../src/shared/constants';

// Found by the tester: an unreadable file chosen BEFORE the model was ready showed "Could not read this image." for about half a
// second, then the model became ready and "Ready. Paste, drop or choose an image." replaced the error. Nothing is slept on here: the
// page is opened with a capture handed over under an id that does not exist, so that the moment the page has finished with the
// model ("ready" is set, then the handoff is read) is visible: chrome.storage.session.get is called right after it.
const MISSING_HANDOFF = '#cap_00000000-0000-0000-0000-000000000000';

test('an unreadable file chosen while the model loads keeps its error when the model is ready', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    const session = chrome.storage.session;
    const original = session.get.bind(session) as unknown as (...args: unknown[]) => unknown;
    (window as unknown as { __handoffRead: boolean }).__handoffRead = false;
    session.get = ((...args: unknown[]): unknown => {
      (window as unknown as { __handoffRead: boolean }).__handoffRead = true;
      return original(...args);
    }) as unknown as typeof session.get;
  });
  const handoffRead = (): Promise<boolean> =>
    page.evaluate(() => (window as unknown as { __handoffRead: boolean }).__handoffRead);
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}${MISSING_HANDOFF}`);
  const status = page.locator('#status');
  await expect(status).toHaveText('Loading model…');

  await page.locator('#file').setInputFiles({
    name: 'not-an-image.png',
    mimeType: 'image/png',
    buffer: Buffer.from('this is not a PNG'),
  });
  await expect(status).toHaveText('Could not read this image.');
  expect(await handoffRead(), 'the model was still loading when the file was chosen').toBe(false);

  // the model gets ready: the page reads the handoff right after it has decided about the status
  await page.waitForFunction(() => (window as unknown as { __handoffRead: boolean }).__handoffRead);
  await expect(status).toHaveText('Could not read this image.');
  await expect(status).toHaveClass(/err/);
});

test('without a file the same page says it is ready', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}`);
  await expect(page.locator('#status')).toHaveText('Ready. Paste, drop or choose an image.', {
    timeout: 60_000,
  });
});
