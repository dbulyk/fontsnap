import type en from '../../public/_locales/en/messages.json';

/** Keys of the default locale; a typo in `t('…')` fails the typecheck. */
export type MessageKey = keyof typeof en;

/** UI languages written right to left. */
const RTL = /^(ar|fa|he|iw|ur)\b/;

/** Localized message by key. Throws on a missing message so mistakes are loud, not blank. */
export function t(key: MessageKey, substitutions?: string[]): string {
  const text = chrome.i18n.getMessage(key, substitutions);
  if (text === '') throw new Error(`Missing i18n message: ${key}`);
  return text;
}

/**
 * Fills `data-i18n="key"` (text), `data-i18n-ph="key"` (placeholder) and `data-i18n-title="key"` (title
 * attribute) in `root` and, for a whole document, sets `<html lang>` from the UI language and
 * `<html dir="rtl">` for right-to-left languages.
 */
export function applyI18n(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = t(element.dataset['i18n'] as MessageKey);
  }
  for (const element of root.querySelectorAll<HTMLInputElement>('[data-i18n-ph]')) {
    element.placeholder = t(element.dataset['i18nPh'] as MessageKey);
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    element.title = t(element.dataset['i18nTitle'] as MessageKey);
  }
  if ('documentElement' in root) {
    const { documentElement } = root as Document;
    const lang = chrome.i18n.getUILanguage();
    documentElement.lang = lang;
    if (RTL.test(lang)) documentElement.dir = 'rtl';
  }
}
