import { EXTENSION_PAGES } from '../../src/shared/constants';
import { expect, isExtensionPage, openResultPage, siteTabId, test } from './fixtures';

// The unit tests use hand-written `sender` objects. This checks, in real Chromium, that Chrome fills the fields
// the way the sender policy expects: only the selection overlay (a content script injected into a tab) may send
// `fontsnap-rect`; an extension page and a web page may not.
test.describe('the selection message', () => {
  const rectMessage = {
    type: 'fontsnap-rect',
    rect: { x: 20, y: 20, w: 200, h: 60 },
    dpr: 1,
    text: '',
  };

  test('is ignored when an extension page sends it, and a web page cannot send anything at all', async ({
    context,
    extensionId,
    serviceWorker,
    siteUrl,
  }) => {
    const site = await context.newPage();
    await site.goto(siteUrl);
    // No externally_connectable: the page's own JavaScript has no way to message the extension.
    const reach = await site.evaluate(
      () =>
        typeof (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime
          ?.sendMessage,
    );
    expect(reach).toBe('undefined');

    const result = await openResultPage(context, extensionId);
    const countTabs = () =>
      serviceWorker.evaluate(async () => (await chrome.tabs.query({})).length);
    const before = await countTabs();
    const answer = await result.evaluate(async (message) => {
      try {
        return { response: (await chrome.runtime.sendMessage(message)) as unknown };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    }, rectMessage);
    // Nobody answered, and nothing was captured or opened.
    expect(answer).toEqual({});
    expect(await countTabs()).toBe(before);
  });

  test('is accepted from the content script the extension injects (the control case)', async ({
    context,
    serviceWorker,
    siteUrl,
  }) => {
    const site = await context.newPage();
    await site.goto(siteUrl);
    await site.bringToFront();
    const tabId = await siteTabId(serviceWorker);
    const [injection] = await serviceWorker.evaluate(
      ({ id, message }) =>
        chrome.scripting.executeScript({
          target: { tabId: id },
          world: 'ISOLATED',
          func: async (request: unknown) => ({
            response: (await chrome.runtime.sendMessage(request)) as unknown,
          }),
          args: [message],
        }),
      { id: tabId, message: rectMessage },
    );
    expect(injection?.result).toEqual({ response: { ok: true, data: { opened: true } } });
    await expect
      .poll(() =>
        serviceWorker.evaluate(
          async (page) =>
            (await chrome.tabs.query({})).filter((tab) => tab.url?.includes(page)).length,
          EXTENSION_PAGES.result,
        ),
      )
      .toBeGreaterThan(0);
    expect(
      context.pages().some((page) => isExtensionPage(page.url(), EXTENSION_PAGES.result)),
    ).toBe(true);
  });
});
