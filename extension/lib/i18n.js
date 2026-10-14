// Tiny chrome.i18n wrapper for extension pages: t(key, subs) and applyI18n() for data-i18n* attributes.
const RTL = /^(ar|fa|he|iw|ur)\b/;
export const t = (key, subs) => globalThis.chrome?.i18n?.getMessage(key, subs) || key;
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  const lang = chrome.i18n.getUILanguage();
  document.documentElement.lang = lang;
  if (RTL.test(lang)) document.documentElement.dir = 'rtl';
}
