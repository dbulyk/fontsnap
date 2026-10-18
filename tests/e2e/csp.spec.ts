import { expect, openResultPage, test } from './fixtures';

// The CSP of the extension pages has `connect-src 'self'` (src/manifest.ts). It applies to the pages, to the worker of the
// onnxruntime runtime and to the service worker, so no request of this extension reaches another origin - and a `data:` URL
// cannot be fetched either, which is why src/shared/data-url.ts decodes them. The e2e build even has host permission for
// the loopback test site, which would let the service worker fetch it; the CSP is what refuses.
interface Probe {
  own: string;
  site: string;
  data: string;
  blob: string;
}

/** What `fetch` does with each kind of URL, in the context this runs in. */
async function probe(urls: string[]): Promise<Probe> {
  const [own = '', site = ''] = urls;
  const outcome = async (url: string): Promise<string> => {
    try {
      const response = await fetch(url);
      return `ok ${String(response.status)}`;
    } catch (error) {
      return error instanceof TypeError ? 'refused' : 'other error';
    }
  };
  return {
    own: await outcome(own),
    site: await outcome(site),
    data: await outcome('data:image/png;base64,AQID'),
    // a blob: URL of the page itself is 'self' (the service worker has no URL.createObjectURL)
    blob:
      typeof URL.createObjectURL === 'function'
        ? await outcome(URL.createObjectURL(new Blob(['x'])))
        : 'unavailable',
  };
}

test('the service worker can read its own files and nothing else: no other origin, no data: URL', async ({
  extensionId,
  serviceWorker,
  siteUrl,
}) => {
  const own = `chrome-extension://${extensionId}/model/meta.json`;
  const result = await serviceWorker.evaluate(probe, [own, siteUrl]);
  expect(result).toEqual({
    own: 'ok 200',
    site: 'refused',
    data: 'refused',
    blob: 'unavailable',
  });
});

test('a page of the extension can read its own files and nothing else', async ({
  context,
  extensionId,
  siteUrl,
}) => {
  const page = await openResultPage(context, extensionId);
  const own = `chrome-extension://${extensionId}/model/meta.json`;
  const result = await page.evaluate(probe, [own, siteUrl]);
  expect(result).toEqual({ own: 'ok 200', site: 'refused', data: 'refused', blob: 'ok 200' });
});

// (that stylesheets and fonts of other origins - the Google Fonts previews - are not touched is font-preview.spec.ts)

test('the manifest carries exactly the CSP that is pinned', async ({ serviceWorker }) => {
  const csp = await serviceWorker.evaluate(
    () => chrome.runtime.getManifest().content_security_policy,
  );
  expect(csp).toEqual({
    extension_pages:
      "script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; object-src 'none'; base-uri 'none'",
  });
});
