import { Window } from 'happy-dom';
import { EXTENSION_PAGES } from '../../src/shared/constants';

const TRANSLATABLE_ATTRIBUTES = ['placeholder', 'aria-label', 'title'];

/**
 * Text that is in the markup of a page on purpose and is not translated, per page (path relative to src/), as
 * exact strings: the product name, glyphs drawn in the mock-up of the browser toolbar on the welcome page and the
 * numbers of its numbered list. The markup of these pages is unchanged since before the template; any other text
 * is still reported. A Map of Sets: an inherited name such as `constructor` is not a page.
 */
export const UNTRANSLATED_ALLOWED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [EXTENSION_PAGES.result, new Set(['FontSnap'])],
  [EXTENSION_PAGES.welcome, new Set(['FontSnap', '⋮', '📌', '1', '2', '3', '4'])],
]);

/**
 * Returns visible text and user-facing attributes in an HTML page that do not come from i18n:
 * every text node needs a `data-i18n` ancestor, `title` needs `data-i18n-title`, `placeholder` needs
 * `data-i18n-ph`, and `aria-label` must be set from code via t(). `page` (path relative to src/) selects
 * the exact strings of UNTRANSLATED_ALLOWED that are accepted as they are.
 */
export function findUntranslatedText(html: string, page?: string): string[] {
  const allowed = page === undefined ? undefined : UNTRANSLATED_ALLOWED.get(page);
  const window = new Window();
  window.document.write(html);
  const found: string[] = [];

  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').trim();
      const parent = node.parentElement;
      if (text !== '' && !parent?.closest('[data-i18n], script, style') && !allowed?.has(text)) {
        found.push(text);
      }
      return;
    }
    if (node.nodeType !== 1) {
      node.childNodes.forEach(visit);
      return;
    }
    const element = node as Element;
    for (const attribute of element.attributes) {
      if (!TRANSLATABLE_ATTRIBUTES.includes(attribute.name)) continue;
      const translated =
        (attribute.name === 'title' && element.hasAttribute('data-i18n-title')) ||
        (attribute.name === 'placeholder' && element.hasAttribute('data-i18n-ph'));
      if (!translated && attribute.value.trim() !== '') {
        found.push(`${attribute.name}="${attribute.value}"`);
      }
    }
    element.childNodes.forEach(visit);
  };

  window.document.childNodes.forEach((child) => {
    visit(child as unknown as Node);
  });
  void window.happyDOM.close();
  return found;
}
