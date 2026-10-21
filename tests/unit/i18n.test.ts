// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyI18n, t, type MessageKey } from '../../src/shared/i18n';
import { createChromeStub } from './helpers/chrome-stub';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
});

describe('t', () => {
  beforeEach(() => {
    createChromeStub({ locale: 'en' }).install();
  });

  it('returns the message with substitutions applied', () => {
    expect(t('errorMsg', ['boom'])).toBe('Error: boom');
    expect(t('loading')).toBe('Loading model…');
  });

  it('throws when the message is missing so typos fail loudly', () => {
    expect(() => t('doesNotExist' as MessageKey)).toThrow(/doesNotExist/);
  });
});

describe('applyI18n', () => {
  it('fills text, placeholders and titles from data-i18n, data-i18n-ph and data-i18n-title', () => {
    createChromeStub({ locale: 'ru' }).install();
    document.body.innerHTML =
      '<p data-i18n="loading"></p><input data-i18n-ph="previewPh"><b data-i18n-title="scoreTitle"></b>';
    applyI18n(document);
    expect(document.querySelector('p')?.textContent).toBe('Загрузка модели…');
    expect(document.querySelector('input')?.placeholder).toBe('Введите свой текст');
    expect(document.querySelector('b')?.title).toBe('Относительная оценка среди первых 5');
  });

  it('sets the document language from the UI language', () => {
    createChromeStub({ locale: 'ru' }).install();
    applyI18n(document);
    expect(document.documentElement.lang).toBe('ru');
  });

  it('falls back to en messages for a UI language without a locale', () => {
    createChromeStub({ locale: 'en-GB' }).install();
    document.body.innerHTML = '<p data-i18n="loading"></p>';
    applyI18n(document);
    expect(document.querySelector('p')?.textContent).toBe('Loading model…');
  });

  it('leaves <html lang> alone when it is applied to a fragment instead of a document', () => {
    createChromeStub({ locale: 'ru' }).install();
    document.documentElement.lang = 'en';
    document.body.innerHTML = '<p data-i18n="loading"></p>';
    applyI18n(document.body);
    expect(document.documentElement.lang).toBe('en');
    expect(document.querySelector('p')?.textContent).toBe('Загрузка модели…');
  });
});

describe('right-to-left languages', () => {
  it.each(['ar', 'fa', 'he', 'iw', 'ur', 'ar-EG', 'he-IL', 'fa-IR'])(
    '%s sets dir=rtl',
    (locale) => {
      createChromeStub({ locale: locale === 'iw' || locale === 'ur' ? 'en' : locale }).install();
      vi.stubGlobal('chrome', {
        ...(globalThis as unknown as { chrome: object }).chrome,
        i18n: { getUILanguage: () => locale, getMessage: () => 'x' },
      });
      applyI18n(document);
      expect(document.documentElement.dir).toBe('rtl');
      expect(document.documentElement.lang).toBe(locale);
    },
  );

  it.each(['en', 'en-US', 'ru', 'de', 'ja', 'arx', 'hebrew'])(
    '%s keeps the default direction',
    (locale) => {
      vi.stubGlobal('chrome', { i18n: { getUILanguage: () => locale, getMessage: () => 'x' } });
      applyI18n(document);
      expect(document.documentElement.dir).toBe('');
    },
  );

  it('applies the real Arabic and Hebrew locales', () => {
    createChromeStub({ locale: 'ar' }).install();
    document.body.innerHTML = '<h1 data-i18n="wTitle"></h1>';
    applyI18n(document);
    expect(document.querySelector('h1')?.textContent).toBe('تم تثبيت FontSnap');
    expect(document.documentElement.dir).toBe('rtl');
  });
});
