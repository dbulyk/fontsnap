import type { BrowserContext, Page } from '@playwright/test';
import { EXTENSION_PAGES } from '../../src/shared/constants';
import { clickToolbarIcon, expect, isExtensionPage, test } from './fixtures';
import type { Route } from './fixtures';
import { SAMPLE_TEXT } from './site-data';

// The whole path of a region selection in real Chromium: the toolbar icon is clicked (Extensions.triggerAction, so
// Chrome grants activeTab as for a user), the overlay appears, the user drags over the text, the service worker
// takes the screenshot, crops it, hands it over through chrome.storage.session and opens the result page,
// which analyses it.
test('selecting text on a page ends in the result tab with the crop analysed', async ({
  context,
  extensionId,
  serviceWorker,
  siteUrl,
}) => {
  const site = await context.newPage();
  await site.goto(siteUrl);
  const box = await site.locator('#sample').boundingBox();
  expect(box, 'the sample text has a box').not.toBeNull();
  const { x = 0, y = 0 } = box ?? {};

  await clickToolbarIcon(context, extensionId, site);
  const overlay = site.locator('div[style*="crosshair"]');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('FontSnap');

  const opened = context.waitForEvent('page', {
    predicate: (page) => isExtensionPage(page.url(), EXTENSION_PAGES.result),
  });
  const width = 360;
  const height = 80;
  await site.mouse.move(x - 10, y - 5);
  await site.mouse.down();
  await site.mouse.move(x - 10 + width, y - 5 + height, { steps: 4 });
  await site.mouse.up();
  const result = await opened;

  expect(result.url()).toMatch(/#cap_[0-9a-f-]{36}$/);
  await expect(overlay).toHaveCount(0);
  // the text under the selection becomes the preview sample; the crop is analysed
  await expect(result.locator('#pvText')).toHaveValue(SAMPLE_TEXT);
  await expect(result.locator('#results li').first()).toBeVisible();
  await expect(result.locator('#status')).toHaveText('');
  await expect(result.locator('#shot')).toHaveJSProperty('width', width);
  await expect(result.locator('#shot')).toHaveJSProperty('height', height);
  await expect(result.locator('.sample').first()).toHaveText(SAMPLE_TEXT);
  // the handoff entry is removed once read
  expect(await serviceWorker.evaluate(() => chrome.storage.session.get(null))).toEqual({});
});

test('Escape cancels the selection and leaves the page as it was', async ({
  context,
  extensionId,
  siteUrl,
}) => {
  const site = await context.newPage();
  await site.goto(siteUrl);
  await clickToolbarIcon(context, extensionId, site);
  const overlay = site.locator('div[style*="crosshair"]');
  await expect(overlay).toBeVisible();
  await site.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
  await expect(site.locator('#sample')).toBeVisible();
});

test('a second click on the icon does not stack a second overlay', async ({
  context,
  extensionId,
  siteUrl,
}) => {
  const site = await context.newPage();
  await site.goto(siteUrl);
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toHaveCount(1);
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toHaveCount(1);
});

test('on a page where scripts cannot run, the icon opens the result page in upload mode', async ({
  context,
  extensionId,
}) => {
  const page = await context.newPage();
  await page.goto('chrome://version/');
  const opened = context.waitForEvent('page', {
    predicate: (candidate) => isExtensionPage(candidate.url(), EXTENSION_PAGES.result),
  });
  await clickToolbarIcon(context, extensionId, page);
  const result = await opened;
  await expect(result.locator('#status')).toHaveText('Ready. Paste, drop or choose an image.', {
    timeout: 60_000,
  });
  expect(result.url()).toBe(`chrome-extension://${extensionId}/${EXTENSION_PAGES.result}`);
});

// The case from a user report: the frame was over "TT Polihaus…", but the preview showed text from elsewhere
// on the page (a selection, hidden text, transparent text, covered text). The textarea sticks out of the
// frame and has no selection, so its value is not the framed text either.
test('the preview takes only the visible text inside the frame, not a selection or hidden text', async ({
  context,
  extensionId,
  serve,
}) => {
  const visible = 'TT Polihaus — экспериментальный гротеск';
  const trap = 'БУКВОПЕЧАТАЮЩЕЙ СВЯЗИ';
  const at = 'position:absolute;left:0;top:0;margin:0;font:32px/40px sans-serif';
  const origin = await serve(
    new Map([
      [
        '/',
        {
          type: 'text/html; charset=utf-8',
          body: `<!doctype html><html lang="ru"><head><meta charset="utf-8"></head>
<body style="margin:0;background:#fff">
  <p id="elsewhere" style="margin:20px 40px;font:20px sans-serif">${trap} selected</p>
  <div id="frame" style="position:absolute;left:40px;top:200px;width:700px;height:200px">
    <p style="${at};visibility:hidden">${trap} hidden</p>
    <p style="${at};opacity:0">${trap} transparent</p>
    <textarea style="position:absolute;left:0;top:160px;width:300px;height:80px;opacity:0.01">${trap} textarea</textarea>
    <p style="${at};top:120px">${trap} covered</p>
    <div style="position:absolute;left:0;top:110px;width:700px;height:60px;background:#fff"></div>
    <p id="visible" style="${at};color:#111">${visible}</p>
  </div>
</body></html>`,
        },
      ],
    ]),
  );
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  await site.evaluate(() => {
    const range = document.createRange();
    const elsewhere = document.getElementById('elsewhere');
    if (elsewhere === null) throw new Error('no #elsewhere');
    range.selectNodeContents(elsewhere);
    document.getSelection()?.addRange(range);
  });
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toBeVisible();
  const opened = context.waitForEvent('page', {
    predicate: (page) => isExtensionPage(page.url(), EXTENSION_PAGES.result),
  });
  await site.mouse.move(30, 190);
  await site.mouse.down();
  await site.mouse.move(760, 390, { steps: 4 });
  await site.mouse.up();
  const result = await opened;
  await expect(result.locator('#pvText')).toHaveValue(visible);
});

const MARKER = 'Shown Marker';
const LINE = 'margin:0;font:32px/40px sans-serif;white-space:nowrap;color:#111';
const SR_ONLY =
  '.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);clip-path:inset(50%);white-space:nowrap;border:0}';
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function markerAt(top: number): string {
  return `<p style="position:absolute;left:16px;top:${String(top)}px;${LINE}">${MARKER}</p>`;
}

function framedPage(inner: string, css = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:#fff;color:#111}
    #frame{position:absolute;left:40px;top:160px;width:640px;height:200px}
    ${css}
  </style></head><body><div id="frame">${inner}</div></body></html>`;
}

async function previewInFrame(
  context: BrowserContext,
  extensionId: string,
  serve: (routes: ReadonlyMap<string, Route>) => Promise<string>,
  inner: string,
  options?: { css?: string; prepare?: (site: Page) => Promise<void> },
): Promise<string> {
  const origin = await serve(
    new Map([
      ['/', { type: 'text/html; charset=utf-8', body: framedPage(inner, options?.css ?? '') }],
    ]),
  );
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  if (options?.prepare !== undefined) await options.prepare(site);
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toBeVisible();
  const opened = context.waitForEvent('page', {
    predicate: (candidate) => isExtensionPage(candidate.url(), EXTENSION_PAGES.result),
  });
  await site.mouse.move(32, 152);
  await site.mouse.down();
  await site.mouse.move(688, 368, { steps: 4 });
  await site.mouse.up();
  const result = await opened;
  await expect(result.locator('#shot')).toBeVisible();
  await expect(result.locator('#results li').first()).toBeVisible();
  return result.locator('#pvText').inputValue();
}

interface PreviewCase {
  name: string;
  inner: string;
  expected: string;
  css?: string;
  prepare?: (site: Page) => Promise<void>;
}

const field = 'font:24px sans-serif;color:#111';

function selectField(start: number, end: number): (site: Page) => Promise<void> {
  return async (site) => {
    await site.locator('#f').evaluate(
      (node, range) => {
        if (!(node instanceof HTMLTextAreaElement) && !(node instanceof HTMLInputElement)) {
          throw new Error('field');
        }
        node.setSelectionRange(range.start, range.end);
      },
      { start, end },
    );
  };
}

const previewCases: PreviewCase[] = [
  {
    name: 'visible text',
    inner: `<p style="position:absolute;left:16px;top:28px;${LINE}">Visible Frame Text</p>`,
    expected: 'Visible Frame Text',
  },
  {
    name: 'a selection outside the frame',
    inner: `<p id="out" style="position:fixed;left:40px;top:24px;margin:0;font:20px sans-serif">TRAP selected</p>
      <p style="position:absolute;left:16px;top:28px;${LINE}">Visible Frame Text</p>`,
    expected: 'Visible Frame Text',
    prepare: async (site) => {
      await site.locator('#out').evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
    },
  },
  {
    name: 'visibility:hidden',
    inner: `<p style="visibility:hidden;position:absolute;left:16px;top:16px;${LINE}">TRAP hidden</p>${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'opacity:0',
    inner: `<p style="opacity:0;position:absolute;left:16px;top:16px;${LINE}">TRAP clear</p>${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'display:none',
    inner: `<p style="display:none">TRAP none</p>${markerAt(28)}`,
    expected: MARKER,
  },
  {
    name: 'an opaque sibling',
    inner: `<p style="position:absolute;left:16px;top:8px;${LINE}">TRAP covered</p>
      <div style="position:absolute;left:0;top:0;width:640px;height:56px;background:#fff"></div>${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'text that does not receive pointer events',
    inner: `<p style="pointer-events:none;position:absolute;left:16px;top:28px;${LINE}">Pointer Free Text</p>`,
    expected: 'Pointer Free Text',
  },
  {
    name: 'a transparent click catcher',
    inner: `<p style="position:absolute;left:16px;top:28px;${LINE}">Under Clear Layer</p>
      <div style="position:absolute;inset:0;background:rgba(0,0,0,0)"></div>`,
    expected: 'Under Clear Layer',
  },
  {
    name: 'a heading under a stretched link',
    css: '.card{position:relative;width:520px;margin:24px 16px}.stretched-link::after{content:"";position:absolute;top:0;right:0;bottom:0;left:0}',
    inner: `<div class="card"><h2 style="${LINE}">Card Title Here</h2><a class="stretched-link" href="#read" style="position:absolute;left:-2000px">Read</a></div>`,
    expected: 'Card Title Here',
  },
  {
    name: 'an opaque descendant',
    inner: `<p style="position:relative;margin:16px;width:420px;${LINE}">TRAP child<span style="position:absolute;inset:0;background:#fff"></span></p>${markerAt(100)}`,
    expected: MARKER,
  },
  {
    name: 'display:contents',
    inner: `<p style="position:absolute;left:16px;top:28px;${LINE}"><span style="display:contents">Contents Text</span></p>`,
    expected: 'Contents Text',
  },
  {
    name: 'display:contents and visibility:hidden',
    inner: `<p style="position:absolute;left:16px;top:16px;${LINE}"><span style="display:contents;visibility:hidden">TRAP secret</span></p>${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'visible aria-hidden text',
    inner: `<p aria-hidden="true" style="position:absolute;left:16px;top:28px;${LINE}">Aria Visible Letters</p>`,
    expected: 'Aria Visible Letters',
  },
  {
    name: 'aria-hidden stars beside an sr-only duplicate',
    css: SR_ONLY,
    inner: `<p style="position:absolute;left:16px;top:28px;${LINE}"><span aria-hidden="true">4.5 STARS</span><span class="sr-only">TRAP rated</span></p>`,
    expected: '4.5 STARS',
  },
  {
    name: 'sr-only text alone',
    css: SR_ONLY,
    inner: `<p class="sr-only">TRAP sr only</p>${markerAt(28)}`,
    expected: MARKER,
  },
  {
    name: 'a collapsed accordion',
    inner: `<div style="height:0;overflow:hidden"><p style="${LINE}">TRAP accordion</p></div>${markerAt(28)}`,
    expected: MARKER,
  },
  {
    name: 'text clipped by overflow',
    inner: `<div style="height:36px;overflow:hidden"><p style="padding-top:80px;${LINE}">TRAP clipped</p></div>${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'an empty clip rect',
    inner: `<p style="position:absolute;left:16px;top:16px;width:300px;height:40px;clip:rect(0,0,0,0);${LINE}">TRAP cliprect</p>${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'clip-path inset(100%)',
    inner: `<p style="position:absolute;left:16px;top:16px;width:300px;clip-path:inset(100%);${LINE}">TRAP inset</p>${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'text under an image',
    inner: `<p style="position:absolute;left:16px;top:8px;${LINE}">TRAP image</p>
      <img alt="" src="${PIXEL}" style="position:absolute;left:0;top:0;width:640px;height:56px">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'text under a filled canvas',
    inner: `<p style="position:absolute;left:16px;top:8px;${LINE}">TRAP canvas</p>
      <canvas id="c" width="640" height="56" style="position:absolute;left:0;top:0;width:640px;height:56px"></canvas>${markerAt(80)}`,
    expected: MARKER,
    prepare: async (site) => {
      await site.locator('#c').evaluate((node) => {
        if (!(node instanceof HTMLCanvasElement)) throw new Error('canvas');
        const ctx = node.getContext('2d');
        if (ctx === null) throw new Error('context');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, node.width, node.height);
      });
    },
  },
  {
    name: 'text under an svg rect',
    inner: `<p style="position:absolute;left:16px;top:8px;${LINE}">TRAP svg</p>
      <svg style="position:absolute;left:0;top:0;width:640px;height:56px"><rect width="640" height="56" fill="#fff"/></svg>${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'text under an opaque layer that does not receive pointer events',
    inner: `<p style="position:absolute;left:16px;top:16px;${LINE}">Under Penone Cover</p>
      <div style="position:absolute;left:0;top:0;width:640px;height:80px;background:#fff;pointer-events:none"></div>`,
    expected: 'Under Penone Cover',
  },
  {
    name: 'a floating label over an input',
    inner: `<div style="position:relative;margin:24px 16px;width:560px;height:64px">
      <label style="position:absolute;left:12px;top:12px;pointer-events:none;${LINE}">Floating Label</label>
      <input style="width:560px;height:64px;${field}">
    </div>`,
    expected: 'Floating Label',
  },
  {
    name: 'a pe:none label wrapping a span over an input',
    inner: `<div style="position:relative;margin:24px 16px;width:560px;height:64px">
      <label style="position:absolute;left:12px;top:12px;pointer-events:none;${LINE}"><span>Email address</span></label>
      <input style="width:560px;height:64px;${field}">
    </div>`,
    expected: 'Email address',
  },
  {
    name: 'a hero caption over an opaque sibling',
    inner: `<div style="position:relative;margin:24px 16px;width:560px;height:72px">
      <div style="position:absolute;inset:0;background:#246"></div>
      <p style="position:absolute;left:12px;top:16px;pointer-events:none;color:#fff;${LINE}">Hero Caption</p>
    </div>`,
    expected: 'Hero Caption',
  },
  {
    name: 'a hero caption under a pe:none wrapper',
    inner: `<div style="position:relative;margin:24px 16px;width:560px;height:72px">
      <div style="position:absolute;inset:0;background:#246"></div>
      <div style="pointer-events:none;position:absolute;left:12px;top:16px">
        <h1 style="margin:0;color:#fff;${LINE}">HeroCaption</h1>
      </div>
    </div>`,
    expected: 'HeroCaption',
  },
  {
    name: 'a textarea fully inside the frame',
    inner: `<textarea style="position:absolute;left:16px;top:24px;width:480px;height:80px;${field}">full field value</textarea>`,
    expected: 'full field value',
  },
  {
    name: 'a text input fully inside the frame',
    inner: `<input type="text" value="typed words" style="position:absolute;left:16px;top:28px;width:320px;height:44px;${field}">`,
    expected: 'typed words',
  },
  {
    name: 'an input with no type',
    inner: `<input value="missing type" style="position:absolute;left:16px;top:28px;width:320px;height:44px;${field}">`,
    expected: 'missing type',
  },
  {
    name: 'a textarea that crosses the frame with no selection',
    inner: `<textarea style="position:absolute;left:16px;top:120px;width:400px;height:140px;${field}">partial value</textarea>${markerAt(16)}`,
    expected: MARKER,
  },
  {
    name: 'the selection of a textarea that crosses the frame',
    inner: `<textarea id="f" style="position:absolute;left:16px;top:120px;width:400px;height:140px;${field}">partial value</textarea>`,
    expected: 'partial',
    prepare: selectField(0, 7),
  },
  {
    name: 'the selection of an input that crosses the frame',
    inner: `<input id="f" type="text" value="partial value" style="position:absolute;left:16px;top:150px;width:400px;height:80px;${field}">`,
    expected: 'partial',
    prepare: selectField(0, 7),
  },
  {
    name: 'a textarea under an opaque cover',
    inner: `<textarea style="position:absolute;left:16px;top:16px;width:480px;height:70px;${field}">TRAP field</textarea>
      <div style="position:absolute;left:0;top:0;width:640px;height:100px;background:#fff"></div>${markerAt(120)}`,
    expected: MARKER,
  },
  {
    name: 'a textarea with no box',
    inner: `<textarea style="display:none">TRAP hidden field</textarea>${markerAt(28)}`,
    expected: MARKER,
  },
  {
    name: 'a password input',
    inner: `<input type="password" value="SecretPass" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'a password input in any case',
    inner: `<input type="PASSWORD" value="SecretPass" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'text security disc on a text input',
    inner: `<input type="text" value="MaskedBankPass" autocomplete="off" style="-webkit-text-security:disc;position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'autocomplete current-password',
    inner: `<input type="text" value="MaskedBankPass" autocomplete="current-password" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'a name with password token',
    inner: `<input type="text" name="user_password" value="toggledSecret" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'an id that is pwd',
    inner: `<input id="pwd" type="text" value="toggledSecret" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'autocomplete cc-number',
    inner: `<input type="text" autocomplete="cc-number" value="4111111111111111" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'otp maxlength 1 cell',
    inner: `<input type="text" maxlength="1" value="9" style="position:absolute;left:16px;top:16px;width:48px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'otp inputmode numeric maxlength 6',
    inner: `<input type="text" inputmode="numeric" maxlength="6" value="123456" style="position:absolute;left:16px;top:16px;width:120px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'type=email',
    inner: `<input type="email" value="ada@example.com" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'aria-label with pin',
    inner: `<input type="text" aria-label="Enter PIN" value="4242" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'a label naming CVV',
    css: SR_ONLY,
    inner: `<label class="sr-only" for="cvv">CVV</label>
      <input id="cvv" type="text" value="123" style="position:absolute;left:16px;top:16px;width:120px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'a label naming Senha is not sensitive',
    inner: `<label for="senha" style="position:absolute;left:16px;top:8px;font:16px sans-serif">Senha</label>
      <input id="senha" type="text" value="plain words" style="position:absolute;left:16px;top:40px;width:320px;height:44px;${field}">`,
    expected: 'Senha plain words',
  },
  {
    name: 'Typing test name is not a pin token',
    inner: `<input type="text" name="Typing test" value="safe words" style="position:absolute;left:16px;top:28px;width:320px;height:44px;${field}">`,
    expected: 'safe words',
  },
  {
    name: 'name=pin',
    inner: `<input type="text" name="pin" value="4242" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'name=otp_code',
    inner: `<input type="text" name="otp_code" value="123456" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'name=userPassword',
    inner: `<input type="text" name="userPassword" value="SecretPass" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'a name that is пароль',
    inner: `<input type="text" name="пароль" value="SecretPass" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'an id with pw token',
    inner: `<input id="user_pw" type="text" value="SecretPass" style="position:absolute;left:16px;top:16px;width:320px;height:44px;${field}">${markerAt(80)}`,
    expected: MARKER,
  },
  {
    name: 'a fixed menu escaping overflow:hidden nav',
    inner: `<nav style="overflow:hidden;height:40px;background:#eee;margin:16px">
      <button type="button" aria-label="Menu"></button>
      <div style="position:fixed;left:56px;top:200px;background:#fff;padding:8px;${LINE}">MenuItem one</div>
    </nav>`,
    expected: 'MenuItem one',
  },
  {
    name: 'a fixed list item escaping overflow:hidden nav',
    inner: `<nav style="overflow:hidden;height:40px;background:#eee;margin:16px">
      <ul style="margin:0;padding:0;list-style:none">
        <li style="position:fixed;left:56px;top:200px;background:#fff;padding:8px;${LINE}"><a href="#go" style="color:#111;text-decoration:none">Fixed Link</a></li>
      </ul>
    </nav>`,
    expected: 'Fixed Link',
  },
  {
    name: 'a fixed span escaping overflow:hidden nav',
    inner: `<nav style="overflow:hidden;height:40px;background:#eee;margin:16px">
      <div style="position:fixed;left:56px;top:200px;background:#fff;padding:8px;${LINE}"><span>Fixed Span</span></div>
    </nav>`,
    expected: 'Fixed Span',
  },
  {
    name: 'absolute under relative inside overflow:hidden keeps the visible marker',
    inner: `<div style="overflow:hidden;height:48px;margin:16px;background:#eee">
      <div style="position:relative;height:48px">
        <span style="position:absolute;left:16px;top:4px;${LINE}">Shown Marker</span>
      </div>
      <p style="margin:0;${LINE}">TRAP clipped</p>
    </div>`,
    expected: MARKER,
  },
  {
    name: 'fixed under transform inside overflow:hidden keeps the in-box marker',
    inner: `<div style="overflow:hidden;height:72px;margin:16px;background:#eee">
      <div style="transform:translateZ(0)">
        <span style="position:fixed;left:16px;top:8px;${LINE}">Shown Marker</span>
      </div>
      <p style="margin:0;padding-top:120px;${LINE}">TRAP clipped</p>
    </div>`,
    expected: MARKER,
  },
  {
    name: 'RTL Hebrew with Latin keeps document order',
    inner: `<p dir="rtl" style="position:absolute;left:16px;top:28px;${LINE}">שלום FontSnap עולם</p>`,
    expected: 'שלום FontSnap עולם',
  },
  {
    name: 'RTL Arabic with digits keeps document order',
    inner: `<p dir="rtl" style="position:absolute;left:16px;top:28px;${LINE}">السعر 250 ريال اليوم</p>`,
    expected: 'السعر 250 ريال اليوم',
  },
  {
    name: '::first-letter does not invent a space',
    css: 'p::first-letter{font-size:48px;float:left;line-height:1}',
    inner: `<p style="position:absolute;left:16px;top:28px;width:520px;margin:0;font:32px/40px sans-serif;color:#111">Once upon a time</p>`,
    expected: 'Once upon a time',
  },
  {
    name: 'CJK wrap does not invent spaces',
    inner: `<p style="position:absolute;left:16px;top:28px;width:200px;margin:0;font:28px/36px sans-serif;color:#111;word-break:break-all">日本語の文字です</p>`,
    expected: '日本語の文字です',
  },
  {
    name: 'a heading under a painted stretched-link button',
    css: `.card{position:relative;width:520px;margin:24px 16px;padding:20px;border:1px solid #ccc}
.btn{display:inline-block;padding:8px 12px;background:#0d6efd;color:#fff;text-decoration:none;min-width:4rem;min-height:2rem}
.stretched-link::after{content:"";position:absolute;inset:0}`,
    inner: `<div class="card"><h2 style="margin:0 0 16px;${LINE}">Card Title Here</h2>
      <a class="btn stretched-link" href="#go" aria-label="Go somewhere"></a></div>`,
    expected: 'Card Title Here',
  },
  {
    name: 'body pointer-events:none under a modal cover',
    css: 'body{pointer-events:none}',
    inner: `<p style="position:absolute;left:16px;top:28px;${LINE}">Article text</p>
      <div style="position:absolute;left:0;top:0;width:640px;height:200px;background:rgba(0,0,0,.5);pointer-events:auto">
        <p style="position:absolute;left:16px;top:100px;color:#fff;${LINE}">Sign in</p>
      </div>`,
    expected: 'Sign in',
  },
];

for (const item of previewCases) {
  test(`the preview follows visibility: ${item.name}`, async ({ context, extensionId, serve }) => {
    const text = await previewInFrame(context, extensionId, serve, item.inner, {
      ...(item.css === undefined ? {} : { css: item.css }),
      ...(item.prepare === undefined ? {} : { prepare: item.prepare }),
    });
    expect(text).toBe(item.expected);
  });
}

test('framing the middle of a large pre finishes quickly', async ({
  context,
  extensionId,
  serve,
}) => {
  const lines = Array.from({ length: 4000 }, (_, i) => `line-${String(i).padStart(4, '0')} x`).join(
    '\n',
  );
  const origin = await serve(
    new Map([
      [
        '/',
        {
          type: 'text/html; charset=utf-8',
          body: `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0">
<pre id="big" style="margin:0;padding:8px;font:14px/18px monospace;white-space:pre">${lines}</pre>
</body></html>`,
        },
      ],
    ]),
  );
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  await site.evaluate(() => {
    window.scrollTo(0, 18 * 2000);
  });
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toBeVisible();
  const opened = context.waitForEvent('page', {
    predicate: (candidate) => isExtensionPage(candidate.url(), EXTENSION_PAGES.result),
  });
  const started = Date.now();
  await site.mouse.move(20, 120);
  await site.mouse.down();
  await site.mouse.move(700, 360, { steps: 4 });
  await site.mouse.up();
  const result = await opened;
  const elapsed = Date.now() - started;
  await expect(result.locator('#shot')).toBeVisible();
  const text = await result.locator('#pvText').inputValue();
  expect(elapsed).toBeLessThan(2000);
  expect(text.length).toBeLessThanOrEqual(120);
});

async function previewAround(
  context: BrowserContext,
  extensionId: string,
  serve: (routes: ReadonlyMap<string, Route>) => Promise<string>,
  body: string,
  target: string,
  options?: {
    prepare?: (site: Page) => Promise<void>;
    /** Dispatch on the overlay (needed when a top-layer dialog sits above it). */
    viaOverlay?: boolean;
  },
): Promise<string> {
  const origin = await serve(new Map([['/', { type: 'text/html; charset=utf-8', body }]]));
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  if (options?.prepare !== undefined) await options.prepare(site);
  const box = await site.locator(target).boundingBox();
  expect(box, `${target} has a box`).not.toBeNull();
  const { x = 0, y = 0, width = 0, height = 0 } = box ?? {};
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toBeVisible();
  const opened = context.waitForEvent('page', {
    predicate: (candidate) => isExtensionPage(candidate.url(), EXTENSION_PAGES.result),
  });
  const fromX = x - 8;
  const fromY = y - 8;
  const toX = x + width + 8;
  const toY = y + height + 8;
  if (options?.viaOverlay === true) {
    await site.locator('div[style*="crosshair"]').evaluate(
      (node, rect) => {
        const fire = (type: string, clientX: number, clientY: number) => {
          node.dispatchEvent(
            new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true }),
          );
        };
        fire('mousedown', rect.fromX, rect.fromY);
        fire('mousemove', rect.toX, rect.toY);
        fire('mouseup', rect.toX, rect.toY);
      },
      { fromX, fromY, toX, toY },
    );
  } else {
    await site.mouse.move(fromX, fromY);
    await site.mouse.down();
    await site.mouse.move(toX, toY, { steps: 4 });
    await site.mouse.up();
  }
  const result = await opened;
  await expect(result.locator('#shot')).toBeVisible();
  await expect(result.locator('#results li').first()).toBeVisible();
  return result.locator('#pvText').inputValue();
}

test('the preview takes below-fold text when html/body are height 100% with overflow-x hidden', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await previewAround(
    context,
    extensionId,
    serve,
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{height:100%;margin:0}body{overflow-x:hidden}
    </style></head><body>
      <div style="height:1800px"></div>
      <p id="t" style="font:32px sans-serif;margin:40px">Below Fold Text</p>
      <div style="height:400px"></div>
    </body></html>`,
    '#t',
    {
      prepare: async (site) => {
        await site.evaluate(() => {
          window.scrollTo(0, 1800);
        });
      },
    },
  );
  expect(text).toBe('Below Fold Text');
});

test('the preview takes dialog showModal text over an overflow clipper', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await previewAround(
    context,
    extensionId,
    serve,
    `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <div style="overflow:hidden;height:20px">
        <dialog id="d"><p id="t" style="font:24px sans-serif;margin:16px">DlgText here</p></dialog>
      </div>
    </body></html>`,
    '#t',
    {
      viaOverlay: true,
      prepare: async (site) => {
        await site.locator('#d').evaluate((node) => {
          if (!(node instanceof HTMLDialogElement)) throw new Error('dialog');
          node.showModal();
        });
      },
    },
  );
  expect(text).toBe('DlgText here');
});

test('the preview still reaches a target after many spacer text nodes', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await previewAround(
    context,
    extensionId,
    serve,
    `<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>`,
    '#t',
    {
      prepare: async (site) => {
        await site.evaluate(() => {
          const root = document.body;
          for (let i = 0; i < 12000; i++) {
            const spacer = document.createElement('div');
            spacer.textContent = ' ';
            root.append(spacer);
          }
          const target = document.createElement('p');
          target.id = 't';
          target.style.cssText = 'font:32px sans-serif;margin:40px';
          target.textContent = 'Target heading';
          root.append(target);
        });
      },
    },
  );
  expect(text).toBe('Target heading');
});

test('the preview keeps only the framed line of a tall paragraph', async ({
  context,
  extensionId,
  serve,
}) => {
  const origin = await serve(
    new Map([
      [
        '/',
        {
          type: 'text/html; charset=utf-8',
          body: `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:40px">
  <p id="tall" style="margin:0;width:420px;font:28px/40px sans-serif;color:#111">Line Alpha Words<br>Line Bravo Words<br>Line Charlie Words</p>
</body></html>`,
        },
      ],
    ]),
  );
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  const middle = await site.evaluate(() => {
    const tall = document.getElementById('tall');
    if (tall === null) throw new Error('tall');
    const walker = document.createTreeWalker(tall, NodeFilter.SHOW_TEXT);
    walker.nextNode();
    const bravo = walker.nextNode();
    if (bravo === null) throw new Error('bravo');
    const range = document.createRange();
    range.selectNodeContents(bravo);
    const line = range.getClientRects()[0];
    if (line === undefined) throw new Error('line');
    return {
      x: line.left,
      y: line.top,
      w: line.width,
      h: line.height,
      text: bravo.nodeValue ?? '',
    };
  });
  expect(middle.text.trim()).toBe('Line Bravo Words');
  await clickToolbarIcon(context, extensionId, site);
  await expect(site.locator('div[style*="crosshair"]')).toBeVisible();
  const opened = context.waitForEvent('page', {
    predicate: (candidate) => isExtensionPage(candidate.url(), EXTENSION_PAGES.result),
  });
  await site.mouse.move(middle.x - 4, middle.y + 2);
  await site.mouse.down();
  await site.mouse.move(middle.x + middle.w + 4, middle.y + middle.h - 2, { steps: 4 });
  await site.mouse.up();
  const result = await opened;
  await expect(result.locator('#pvText')).toHaveValue('Line Bravo Words');
});

test('the preview stays empty when framed lines exceed 100 graphemes', async ({
  context,
  extensionId,
  serve,
}) => {
  const long = 'Word '.repeat(40).trim();
  expect(long.length).toBeGreaterThan(100);
  const text = await previewAround(
    context,
    extensionId,
    serve,
    `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:40px"><p id="t" style="font:24px/32px sans-serif;max-width:480px;color:#111">${long}</p></body></html>`,
    '#t',
  );
  // Empty capture leaves #pvText empty (the pangram is only the render fallback).
  expect(text).toBe('');
});

test('framing the article under a body pe:none modal does not take article text', async ({
  context,
  extensionId,
  serve,
}) => {
  const text = await previewAround(
    context,
    extensionId,
    serve,
    `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="pointer-events:none;margin:0">
  <p id="t" style="font:28px sans-serif;margin:40px">Article text</p>
  <div style="position:fixed;inset:0;background:rgba(0,0,0,.5);pointer-events:auto;display:flex;align-items:center;justify-content:center">
    <div style="background:#fff;padding:24px;font:24px sans-serif">Sign in</div>
  </div>
</body></html>`,
    '#t',
  );
  expect(text).not.toContain('Article');
  expect(text === 'Sign in' || text === '').toBe(true);
});
