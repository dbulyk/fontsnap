import { describe, expect, it } from 'vitest';
import { MEDIA_SAMPLES, PROTOTYPE_NAMES, withMedia } from './helpers/media';
import {
  ALLOWED_MEDIA,
  FORBIDDEN_MEDIA,
  hasAllowedMediaExtension,
  isAllowedDistMedia,
  isAllowedSrcFile,
  MEDIA_SIGNATURES,
  STATIC_ASSET_RULE,
  isStaticAsset,
} from '../../scripts/lib/static-assets';

describe('isStaticAsset (paths relative to public/ or to the build output)', () => {
  it.each([
    '_locales/en/messages.json',
    '_locales/pt_BR/messages.json',
    'icons/icon-16.png',
    'icons/icon-128.png',
  ])('accepts %s', (file) => {
    expect(isStaticAsset(file)).toBe(true);
  });

  it.each([
    'icons/icon-dark.svg',
    'icons/logo.png',
    'icons/icon-16.svg',
    'data.json',
    'legacy.js',
    '_locales/en/extra.mjs',
    'fonts/a.woff2',
  ])('rejects %s', (file) => {
    expect(isStaticAsset(file)).toBe(false);
  });

  it('explains what is allowed, SVG icons included in the explanation', () => {
    expect(STATIC_ASSET_RULE).toMatch(/_locales\/<locale>\/messages\.json/);
    expect(STATIC_ASSET_RULE).toMatch(/PNG icons named icons\/icon-<size>\.png/);
    expect(STATIC_ASSET_RULE).toMatch(/SVG/);
    expect(STATIC_ASSET_RULE).toMatch(/scripts\/lib\/static-assets\.ts/);
  });
});

describe('ALLOWED_MEDIA, the one list of media a build may carry', () => {
  const listed = (extension: string): string[] => [extension];

  it('is a set of extensions: the recipe is to add one, and a type without a signature stays refused', () => {
    expect(ALLOWED_MEDIA).toBeInstanceOf(Set);
    withMedia(['no-such-type'], () => {
      expect(isAllowedSrcFile('src/popup/a.no-such-type')).toBe(false);
    });
  });

  it.each([...MEDIA_SIGNATURES.keys()])(
    'opens both gates for %s with one entry, and only then',
    (extension) => {
      const sample = MEDIA_SAMPLES.get(extension) ?? Buffer.alloc(0);
      const src = `src/popup/logo.${extension}`;
      const dist = `assets/logo-abc.${extension}`;
      const wasListed = ALLOWED_MEDIA.has(extension);
      withMedia(wasListed ? [] : listed(extension), () => {
        expect(isAllowedSrcFile(src)).toBe(true);
        expect(isAllowedDistMedia(dist, sample)).toBe(true);
      });
      expect(isAllowedSrcFile(src)).toBe(wasListed);
      expect(isAllowedDistMedia(dist, sample)).toBe(wasListed);
    },
  );

  it('checks the bytes of a listed medium, not its name', () => {
    for (const extension of MEDIA_SIGNATURES.keys()) {
      withMedia(listed(extension), () => {
        expect(isAllowedDistMedia(`assets/logo-abc.${extension}`, Buffer.from('alert(1)'))).toBe(
          false,
        );
      });
    }
  });

  it('only takes media from assets/, by a lower-case extension', () => {
    withMedia(['webp'], () => {
      const webp = MEDIA_SAMPLES.get('webp') ?? Buffer.alloc(0);
      expect(isAllowedDistMedia('logo.webp', webp)).toBe(false);
      expect(isAllowedDistMedia('assets/sub/logo.webp', webp)).toBe(false);
      expect(isAllowedDistMedia('assets/logo.WEBP', webp)).toBe(false);
      expect(isAllowedDistMedia('assets/logo.webp.js', webp)).toBe(false);
    });
  });

  it('has a sample for every signature, and no signature for a type that can carry script', () => {
    for (const extension of MEDIA_SIGNATURES.keys()) {
      expect(MEDIA_SAMPLES.has(extension), `a sample for ${extension} in helpers/media.ts`).toBe(
        true,
      );
      expect(
        MEDIA_SIGNATURES.get(extension)?.(MEDIA_SAMPLES.get(extension) ?? Buffer.alloc(0)),
      ).toBe(true);
    }
    for (const type of FORBIDDEN_MEDIA) expect(MEDIA_SIGNATURES.has(type), type).toBe(false);
    for (const type of ['svg', 'html', 'js', 'wasm', 'json', 'txt'])
      expect(FORBIDDEN_MEDIA.has(type)).toBe(true);
  });

  it('refuses, even when listed, a type that can carry script (svg, html, wasm, js, json, txt ...)', () => {
    withMedia(['svg', 'txt', 'wasm', 'html', 'js', 'json'], () => {
      for (const extension of ['svg', 'txt', 'wasm', 'js', 'json']) {
        expect(isAllowedSrcFile(`src/popup/a.${extension}`), extension).toBe(false);
      }
      for (const extension of ['svg', 'txt', 'wasm', 'html', 'js', 'json']) {
        expect(isAllowedDistMedia(`assets/a.${extension}`, Buffer.from('<svg/>')), extension).toBe(
          false,
        );
      }
    });
  });
});

// ALLOWED_MEDIA[extension] once read the prototype: `evil.constructor` passed both gates and its
// code ran in the popup. Nothing inherited from Object.prototype may open a gate, whatever the case.
describe('prototype names are not media types', () => {
  it.each(PROTOTYPE_NAMES)('%s is refused in src/ and in the build', (name) => {
    const bytes = Buffer.from('document.title = "PWNED";');
    expect(isAllowedSrcFile(`src/popup/evil.${name}`)).toBe(false);
    expect(hasAllowedMediaExtension(`assets/evil-abc.${name}`)).toBe(false);
    expect(isAllowedDistMedia(`assets/evil-abc.${name}`, bytes)).toBe(false);
  });

  it('also when the name is the whole extension of a listed-looking file', () => {
    withMedia(['webp'], () => {
      for (const name of PROTOTYPE_NAMES) {
        expect(isAllowedSrcFile(`src/popup/logo.webp.${name}`), name).toBe(false);
      }
    });
  });
});

describe('the messages never advise editing guard code', () => {
  it('point to the list and the recipe', () => {
    for (const rule of [STATIC_ASSET_RULE]) {
      expect(rule).toContain('ALLOWED_MEDIA');
      expect(rule).toContain('Allow a media type');
      expect(rule).not.toMatch(/scripts\/lib\/(dist|layout)\.ts/);
    }
  });
});
