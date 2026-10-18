import type { Page } from '@playwright/test';
import { expect, openResultPage, test } from './fixtures';
import { EXTENSION_PAGES } from '../../src/shared/constants';

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
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; object-src 'none'; base-uri 'none'",
  });
});

// The CSP also says `default-src 'self'` with exactly two outside hosts (style-src and font-src, the Google Fonts previews), no
// 'unsafe-inline': what the scan of the build cannot see - HTML, CSS, an image URL built at run time - is refused by the browser.
// The page of the extension below is made to do each of those things (this is test code, not src/); a route on the test host
// counts the requests that get past the CSP (none may), and the page reports a securitypolicyviolation. Every wait is an event
// of the browser (a load, an error, the violation itself).
const HOST = 'https://example.invalid';

type Action =
  | 'img'
  | 'dataImg'
  | 'blobImg'
  | 'cssUrl'
  | 'adopted'
  | 'styleLink'
  | 'inlineStyleElement'
  | 'styleAttribute'
  | 'prefetch'
  | 'iframeSrc'
  | 'iframeSrcdoc'
  | 'fontFace'
  | 'audio'
  | 'webSocket';

/** Does `action` in `page` and returns the effective directive of every securitypolicyviolation it caused. */
function attempt(page: Page, action: Action): Promise<string[]> {
  return page.evaluate(async (what) => {
    const seen: string[] = [];
    const violated = new Promise<void>((done) => {
      document.addEventListener(
        'securitypolicyviolation',
        (event) => {
          seen.push(event.effectiveDirective);
          done();
        },
        { once: false },
      );
    });
    const settled = (element: HTMLElement | HTMLMediaElement): Promise<void> =>
      new Promise((done) => {
        element.addEventListener('load', () => {
          done();
        });
        element.addEventListener('error', () => {
          done();
        });
      });
    const image = (src: string): Promise<void> => {
      const element = new Image();
      const finished = settled(element);
      element.src = src;
      return finished;
    };
    switch (what) {
      case 'img':
        // an address assembled at run time, as the tester did
        await image(['https:', '', ['example', 'invalid'].join('.'), 'p.png'].join('/'));
        break;
      case 'dataImg':
        await image('data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==');
        break;
      case 'blobImg':
        await image(URL.createObjectURL(new Blob(['x'], { type: 'image/png' })));
        break;
      case 'cssUrl':
        document.body.style.backgroundImage = 'url(https://example.invalid/b.png)';
        await violated;
        break;
      case 'adopted': {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync('body { background: url(https://example.invalid/a.png) }');
        document.adoptedStyleSheets = [sheet];
        await violated;
        break;
      }
      case 'styleLink': {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://example.invalid/s.css';
        const finished = settled(link);
        document.head.append(link);
        await finished;
        break;
      }
      case 'inlineStyleElement': {
        const style = document.createElement('style');
        style.textContent = 'body { background: url(https://example.invalid/i.png) }';
        document.head.append(style);
        await violated;
        break;
      }
      case 'styleAttribute':
        document.body.setAttribute('style', 'background: url(https://example.invalid/t.png)');
        await violated;
        break;
      case 'prefetch': {
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.href = 'https://example.invalid/prefetch';
        const finished = settled(link);
        document.head.append(link);
        await Promise.race([finished, violated]);
        break;
      }
      case 'iframeSrc': {
        const frame = document.createElement('iframe');
        frame.src = 'https://example.invalid/frame';
        document.body.append(frame);
        await violated;
        break;
      }
      case 'iframeSrcdoc': {
        // the document of the frame inherits the CSP: its image is refused (it reports to the frame, not to this page)
        const frame = document.createElement('iframe');
        frame.srcdoc = '<img src="https://example.invalid/srcdoc.png">';
        const finished = settled(frame);
        document.body.append(frame);
        await finished;
        break;
      }
      case 'fontFace':
        await new FontFace('x', 'url(https://example.invalid/f.woff2)')
          .load()
          .catch(() => undefined);
        await violated;
        break;
      case 'audio': {
        const audio = new Audio('https://example.invalid/a.mp3');
        const finished = settled(audio);
        audio.load();
        await Promise.race([finished, violated]);
        break;
      }
      case 'webSocket':
        try {
          new WebSocket('wss://example.invalid/').addEventListener('error', () => undefined);
        } catch {
          // refused at once
        }
        await violated;
        break;
    }
    return seen;
  }, action);
}

test.describe('the browser refuses what the scan of the build could not see', () => {
  const CASES: [string, Action, string[]][] = [
    ['an image address built at run time (the tester)', 'img', ['img-src']],
    ['an image from a data: URL', 'dataImg', ['img-src']],
    // a blob: URL made by the page is of its own origin, so 'self' covers it: there is no network in it (and no img-src with blob:)
    ['an image from a blob: URL of the page itself (allowed, local)', 'blobImg', []],
    ['a css url() set through CSSOM', 'cssUrl', ['img-src']],
    ['a css url() in an adopted style sheet', 'adopted', ['img-src']],
    ['a style sheet from another host', 'styleLink', ['style-src-elem']],
    ['an inline <style>', 'inlineStyleElement', ['style-src-elem']],
    ['a style attribute with url()', 'styleAttribute', ['style-src-attr']],
    ['<link rel=prefetch>', 'prefetch', []],
    ['an <iframe src>', 'iframeSrc', ['frame-src']],
    ['an <iframe srcdoc> with an image', 'iframeSrcdoc', []],
    ['a FontFace from another host', 'fontFace', ['font-src']],
    ['an <audio> from another host', 'audio', []],
    ['a WebSocket', 'webSocket', ['connect-src']],
  ];

  for (const pageName of ['result', 'welcome'] as const) {
    for (const [what, action, directives] of CASES) {
      test(`${what}: ${pageName} page, no request leaves`, async ({ context, extensionId }) => {
        const requests: string[] = [];
        await context.route(`${HOST}/**`, async (route) => {
          requests.push(route.request().url());
          await route.fulfill({ status: 200, contentType: 'image/png', body: '' });
        });
        const page = await context.newPage();
        await page.goto(`chrome-extension://${extensionId}/${EXTENSION_PAGES[pageName]}`);
        const violations = await attempt(page, action);
        expect(requests, 'requests that passed the CSP').toEqual([]);
        expect(violations).toEqual(expect.arrayContaining(directives));
      });
    }
  }
});
