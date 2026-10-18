import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findUntranslatedText } from '../../scripts/lib/html-i18n';
import { checkLocales, CWS_LOCALES } from '../../scripts/lib/locales';
import { EXTENSION_PAGES } from '../../src/shared/constants';

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith('.html') ? [path] : [];
  });
}

describe('this repository', () => {
  it('has consistent, fully used locales (same as `npm run check:locales`)', () => {
    expect(
      checkLocales({
        localesDir: 'public/_locales',
        srcDir: 'src',
        requiredLocales: CWS_LOCALES,
        brand: 'FontSnap',
      }),
    ).toEqual([]);
  });

  it('has exactly the pages of EXTENSION_PAGES and no untranslated text in them', () => {
    const files = htmlFiles('src');
    expect(files.map((f) => f.replaceAll('\\', '/')).sort()).toEqual(
      Object.values(EXTENSION_PAGES)
        .map((page) => `src/${page}`)
        .sort(),
    );
    for (const file of files) {
      expect(
        findUntranslatedText(
          readFileSync(file, 'utf8'),
          file.replaceAll('\\', '/').slice('src/'.length),
        ),
        file,
      ).toEqual([]);
    }
  });
});
