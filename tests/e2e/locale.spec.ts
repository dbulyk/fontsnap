import { expect, test, type UiLocale } from './fixtures';

// The welcome page, opened on install, shows the UI language: the text, <html lang> and, for right-to-left
// languages, <html dir="rtl">. The manifest name comes from the same locale files and keeps the brand.
const CASES: { locale: UiLocale; heading: string; dir: 'rtl' | '' }[] = [
  { locale: 'en', heading: 'FontSnap is installed', dir: '' },
  { locale: 'ru', heading: 'FontSnap установлен', dir: '' },
  { locale: 'ar', heading: 'تم تثبيت FontSnap', dir: 'rtl' },
  { locale: 'he', heading: 'FontSnap הותקן', dir: 'rtl' },
  { locale: 'fa', heading: 'FontSnap نصب شد', dir: 'rtl' },
];

for (const { locale, heading, dir } of CASES) {
  test.describe(`${locale} UI`, () => {
    test.use({ uiLocale: locale });

    test(`the welcome page speaks ${locale}, direction "${dir}"`, async ({
      welcomePage,
      serviceWorker,
    }) => {
      await expect(welcomePage.locator('h1')).toHaveText(heading);
      await expect(welcomePage.locator('html')).toHaveAttribute('lang', new RegExp(`^${locale}`));
      await expect.poll(() => welcomePage.evaluate(() => document.documentElement.dir)).toBe(dir);
      const name = await serviceWorker.evaluate(() => chrome.runtime.getManifest().name);
      expect(name).toContain('FontSnap');
      expect(name.length).toBeLessThanOrEqual(75);
    });
  });
}
