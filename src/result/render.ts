import type { RankedFont } from '../shared/core/ranker';
import { t } from '../shared/i18n';
import {
  cssFontFamily,
  genericFamily,
  percentLabel,
  previewText,
  visibleResults,
} from '../shared/ui';

/** "Google Fonts" is a product name, not a sentence: it is the same in every language. */
export const GOOGLE_FONTS_LABEL = 'Google Fonts ↗';

const plus = (name: string) => encodeURIComponent(name).replace(/%20/g, '+');

function div(doc: Document, className: string, ...children: HTMLElement[]): HTMLDivElement {
  const element = doc.createElement('div');
  element.className = className;
  element.append(...children);
  return element;
}

function span(doc: Document, className: string): HTMLSpanElement {
  const element = doc.createElement('span');
  element.className = className;
  return element;
}

/**
 * Renders the list of identified fonts into `#results`. Font previews are Google Fonts stylesheets (family
 * names only, never the preview text); each family is requested once.
 */
export function createRenderer(doc: Document): (all: RankedFont[], typed: string) => void {
  const loaded = new Set<string>();

  function loadFont(name: string): void {
    const href = `https://fonts.googleapis.com/css2?family=${plus(name)}&display=swap`;
    if (loaded.has(href)) return;
    loaded.add(href);
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    doc.head.appendChild(link);
  }

  return (all, typed) => {
    const list = visibleResults(all);
    const text = previewText(typed, '');
    const ol = doc.getElementById('results');
    if (!ol) return;
    ol.replaceChildren();
    list.forEach((r, i) => {
      if (r.inGF) loadFont(r.name);
      const li = doc.createElement('li');
      const name = span(doc, 'name');
      name.append(`${i + 1}. `);
      const score = span(doc, 'meta');
      const bar = doc.createElement('i');
      const sample = div(doc, 'sample');
      const category = span(doc, 'meta');
      const acts = span(doc, 'acts');
      li.append(
        div(doc, 'row', name, score),
        div(doc, 'bar', bar),
        sample,
        div(doc, 'row', category, acts),
      );
      name.append(r.name);
      score.textContent = percentLabel(r.conf);
      score.title = t('scoreTitle');
      bar.style.width = `${Math.max(2, r.conf * 100)}%`;
      sample.textContent = text;
      sample.style.fontFamily = `'${r.name}', ${genericFamily(r.category)}`;
      category.textContent = r.category || (r.inGF ? '' : t('notOnGF'));
      const copy = doc.createElement('button');
      copy.textContent = t('copyCss');
      copy.onclick = () => {
        void navigator.clipboard.writeText(cssFontFamily(r.name, r.category)).then(() => {
          copy.textContent = t('copied');
          setTimeout(() => {
            copy.textContent = t('copyCss');
          }, 1200);
        });
      };
      acts.append(copy);
      if (r.inGF) {
        const a = doc.createElement('a');
        a.href = `https://fonts.google.com/specimen/${plus(r.name)}`;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = GOOGLE_FONTS_LABEL;
        acts.append(a);
      }
      ol.append(li);
    });
  };
}
