import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initWelcome } from '../../src/welcome/app';
import { createChromeStub } from './helpers/chrome-stub';

let stub: ReturnType<typeof createChromeStub>;
let win: Window;
let document: Document;

/** A fresh window per test: the page registers listeners on its document and window that never go away. */
function load(
  locale = 'en',
  url = 'chrome-extension://test-extension-id/welcome/welcome.html',
): void {
  stub = createChromeStub({ locale });
  stub.install();
  win = new Window({ url });
  document = win.document as unknown as Document;
  document.documentElement.innerHTML = readFileSync('src/welcome/welcome.html', 'utf8');
}

const mode = () => document.body.dataset['mode'];
/** Lets the pending getUserSettings() promise settle. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  void win.happyDOM.close();
});

describe('the welcome page', () => {
  it('is localized from _locales and keeps the markup', async () => {
    load('en');
    initWelcome(document);
    await settle();
    expect(document.title).toBe('FontSnap is installed');
    expect(document.querySelector('h1')?.textContent).toBe('FontSnap is installed');
    expect(document.querySelector('.privacy')?.textContent).toBe(
      'Everything runs on your device. Images are never uploaded.',
    );
    expect(document.documentElement.lang).toBe('en');
    expect(document.documentElement.dir).toBe('');
  });

  it('speaks Russian for a Russian browser', async () => {
    load('ru');
    initWelcome(document);
    await settle();
    expect(document.querySelector('h1')?.textContent).toBe('FontSnap установлен');
    expect(document.documentElement.lang).toBe('ru');
  });

  it.each(['ar', 'he', 'fa'])('is right to left in %s', async (locale) => {
    load(locale);
    initWelcome(document);
    await settle();
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe(locale);
  });

  it('links "Try it now" to the result page of the extension (the address comes from the declared page list)', async () => {
    load();
    initWelcome(document);
    await settle();
    expect(document.getElementById('try')?.getAttribute('href')).toBe(
      'chrome-extension://test-extension-id/result/result.html',
    );
  });
});

describe('modes', () => {
  it('starts with the pin instructions', async () => {
    load();
    initWelcome(document);
    expect(mode()).toBe('pin');
    await settle();
    expect(mode()).toBe('pin');
  });

  it('starts from ?pinned=1 and lets the live toolbar state override it', async () => {
    load('en', 'chrome-extension://test-extension-id/welcome/welcome.html?pinned=1');
    initWelcome(document);
    expect(mode()).toBe('usage');
    await settle();
    expect(mode()).toBe('pin'); // the toolbar says it is not pinned (stub default)
  });

  it('switches to usage when the user pins FontSnap (live)', async () => {
    load();
    initWelcome(document);
    await settle();
    expect(mode()).toBe('pin');
    stub.chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: true });
    stub.fireSettingsChanged();
    await settle();
    expect(mode()).toBe('usage');
  });

  it('polls the toolbar state every 1.5 s', async () => {
    load();
    initWelcome(document);
    await settle();
    const calls = stub.chrome.action.getUserSettings.mock.calls.length;
    stub.chrome.action.getUserSettings.mockResolvedValue({ isOnToolbar: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(stub.chrome.action.getUserSettings.mock.calls.length).toBe(calls + 1);
    expect(mode()).toBe('usage');
  });

  it('polls when the tab becomes visible, but not while it is hidden', async () => {
    load();
    initWelcome(document);
    await settle();
    const calls = () => stub.chrome.action.getUserSettings.mock.calls.length;
    const before = calls();
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new win.Event('visibilitychange') as unknown as Event);
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls()).toBe(before);
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new win.Event('visibilitychange') as unknown as Event);
    await settle();
    expect(calls()).toBe(before + 1);
  });

  it('falls back to the query when the toolbar state cannot be read', async () => {
    load('en', 'chrome-extension://test-extension-id/welcome/welcome.html?pinned=1');
    stub.chrome.action.getUserSettings.mockRejectedValue(new Error('unsupported'));
    initWelcome(document);
    await settle();
    expect(mode()).toBe('usage');
  });

  it('follows #usage and #pin links and ignores other hashes', async () => {
    load();
    initWelcome(document);
    await settle();
    win.location.hash = '#usage';
    win.dispatchEvent(new win.Event('hashchange'));
    expect(mode()).toBe('usage');
    win.location.hash = '#pin';
    win.dispatchEvent(new win.Event('hashchange'));
    expect(mode()).toBe('pin');
    win.location.hash = '#nonsense';
    win.dispatchEvent(new win.Event('hashchange'));
    expect(mode()).toBe('pin');
  });

  it('a manual choice survives the next poll', async () => {
    load();
    initWelcome(document);
    await settle();
    win.location.hash = '#usage';
    win.dispatchEvent(new win.Event('hashchange'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(mode()).toBe('usage');
  });

  it('stops polling when the page is hidden for good (pagehide)', async () => {
    load();
    initWelcome(document);
    await settle();
    win.dispatchEvent(new win.Event('pagehide'));
    const before = stub.chrome.action.getUserSettings.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(stub.chrome.action.getUserSettings.mock.calls.length).toBe(before);
  });

  it('works on a Chrome without onUserSettingsChanged', async () => {
    load();
    const chromeStub = stub.chrome as { action: Partial<typeof stub.chrome.action> };
    delete chromeStub.action.onUserSettingsChanged;
    expect(() => {
      initWelcome(document);
    }).not.toThrow();
    await settle();
    expect(mode()).toBe('pin');
  });
});
