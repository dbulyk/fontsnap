import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
  CWS_LOCALES,
  FIXED_NUMBERS,
  MANIFEST_MESSAGE_KEYS,
  checkLocales,
  digitValue,
  findHardcodedNumber,
} from '../../scripts/lib/locales';
import { buildManifest } from '../../src/manifest';
import { PROTOTYPE_NAMES } from './helpers/media';

interface Entry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
type Messages = Record<string, Entry>;

const greeting: Entry = {
  message: 'Hello $NAME$',
  placeholders: { name: { content: '$1' } },
};

function baseEn(): Messages {
  return {
    appName: { message: 'Name' },
    appDesc: { message: 'Short description' },
    greeting,
    hint: { message: 'A hint' },
  };
}

const baseFiles: Record<string, string> = {
  'manifest.ts': "export const a = '__MSG_appName__'; export const b = '__MSG_appDesc__';",
  'popup.ts': "t('greeting', ['x']);",
  'popup.html': '<p data-i18n="hint"></p>',
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function check(options: {
  en?: Messages | undefined;
  ru?: Messages | undefined;
  files?: Record<string, string>;
  skipDefaultDir?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), 'locales-'));
  dirs.push(root);
  const locales: Record<string, Messages | undefined> = {
    en: 'en' in options ? options.en : baseEn(),
    ru: 'ru' in options ? options.ru : baseEn(),
  };
  for (const [locale, messages] of Object.entries(locales)) {
    if (!messages || (locale === 'en' && options.skipDefaultDir)) continue;
    const file = join(root, '_locales', locale, 'messages.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(messages));
  }
  for (const [name, content] of Object.entries(options.files ?? baseFiles)) {
    const file = join(root, 'src', name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return checkLocales({
    localesDir: join(root, '_locales'),
    srcDir: join(root, 'src'),
  });
}

const rules = (problems: { rule: string }[]) => problems.map((p) => p.rule);

describe('checkLocales', () => {
  it('accepts consistent locales', () => {
    expect(check({})).toEqual([]);
  });

  it('reports a key missing from a locale and an extra key', () => {
    const ru = baseEn();
    delete ru['hint'];
    ru['bonus'] = { message: 'x' };
    const problems = check({ ru });
    expect(rules(problems)).toEqual(['keys-mismatch', 'keys-mismatch']);
    expect(problems.map((p) => p.message).join('\n')).toMatch(/hint[\s\S]*bonus/);
  });

  it('reports different placeholder names or indexes between locales', () => {
    const renamed = {
      ...baseEn(),
      greeting: {
        message: 'Привет $WHO$',
        placeholders: { who: { content: '$1' } },
      },
    };
    expect(rules(check({ ru: renamed }))).toEqual(['placeholder-mismatch']);
    const reindexed = {
      ...baseEn(),
      greeting: {
        message: 'Привет $NAME$',
        placeholders: { name: { content: '$2' } },
      },
    };
    expect(rules(check({ ru: reindexed }))).toEqual(['placeholder-mismatch']);
  });

  it('reports a declared placeholder that a translation dropped from its text', () => {
    const dropped = {
      ...baseEn(),
      greeting: {
        message: 'Привет',
        placeholders: { name: { content: '$1' } },
      },
    };
    expect(rules(check({ ru: dropped }))).toEqual(['unused-placeholder']);
  });

  it('reports a $NAME$ token without a declaration', () => {
    const broken = { ...baseEn(), greeting: { message: 'Hello $NAME$' } };
    expect(rules(check({ en: broken, ru: broken }))).toContain('undeclared-placeholder');
  });

  it('reports invalid key names', () => {
    const bad = { ...baseEn(), 'bad key!': { message: 'x' } };
    const problems = check({
      en: bad,
      ru: bad,
      files: { ...baseFiles, 'x.ts': "'bad key!'" },
    });
    expect(rules(problems)).toContain('bad-key-name');
  });

  it('reports a missing default locale directory', () => {
    expect(rules(check({ skipDefaultDir: true }))).toContain('missing-default-locale');
  });

  it('reports empty messages', () => {
    const empty = { ...baseEn(), hint: { message: '  ' } };
    expect(rules(check({ en: empty, ru: empty }))).toEqual(['empty-message', 'empty-message']);
  });

  it('reports keys used in code, html or manifest that do not exist in en', () => {
    const problems = check({
      files: {
        ...baseFiles,
        'a.ts': "t('missingFromCode');",
        'a.html': '<i data-i18n="missingFromHtml"></i><b data-i18n-title="missingTitle"></b>',
        'manifest.ts': `${baseFiles['manifest.ts'] ?? ''} const c = '__MSG_missingFromManifest__';`,
      },
    });
    expect(rules(problems)).toEqual(Array<string>(4).fill('unknown-key-used'));
  });

  it('reports en keys that nothing uses', () => {
    const unused = { ...baseEn(), orphan: { message: 'x' } };
    const problems = check({ en: unused, ru: unused });
    expect(problems).toEqual([
      {
        rule: 'unused-key',
        message: expect.stringContaining('orphan') as unknown,
      },
    ]);
  });

  it.each(['links', 'options', 'viaMap'])(
    'does not count a bare string literal "%s" as a use of the key',
    (key) => {
      const extra = { ...baseEn(), [key]: { message: 'x' } };
      const files = {
        ...baseFiles,
        'map.ts': `const row = { ${key}: 1 }; export const a = row['${key}']; document.getElementById('${key}');`,
      };
      const problems = check({ en: extra, ru: extra, files });
      expect(problems).toEqual([
        {
          rule: 'unused-key',
          message: expect.stringContaining(key) as unknown,
        },
      ]);
    },
  );

  it.each([
    ['a line comment', "// t('oldKey');"],
    ['a block comment', "/* t('oldKey') */"],
    ['a JSDoc comment', "/**\n * Used to call t('oldKey').\n */\nexport const a = 1;"],
    ['a trailing comment', "export const a = 1; // getMessage('oldKey')"],
    ['a commented-out list', "// export const L = ['oldKey'] satisfies MessageKey[];"],
  ])('does not count a key mentioned only in %s as used', (_name, source) => {
    const old = { ...baseEn(), oldKey: { message: 'old' } };
    const files = { ...baseFiles, 'old.ts': source };
    const problems = check({ en: old, ru: old, files });
    expect(problems).toEqual([
      {
        rule: 'unused-key',
        message: expect.stringContaining('oldKey') as unknown,
      },
    ]);
  });

  it('does not report a missing key that is only mentioned in a comment', () => {
    const files = {
      ...baseFiles,
      'c.ts': "// t('missingKey')\n/* __MSG_missingKey2__ */",
      'c.html': '<!-- <p data-i18n="missingKey3"></p> -->\n<p data-i18n="hint"></p>',
    };
    // The live reference in c.html keeps 'hint' used; the commented-out ones are ignored entirely.
    expect(check({ files: { ...files, 'popup.html': '' } })).toEqual([]);
  });

  it('counts a key in a string that merely contains a comment marker', () => {
    const files = {
      ...baseFiles,
      'url.ts': "export const u = 'https://x.test//a'; t('greeting', [u]);",
    };
    expect(check({ files })).toEqual([]);
  });

  it('counts keys declared in an explicit list that satisfies MessageKey[]', () => {
    const extra = {
      ...baseEn(),
      dynamicA: { message: 'a' },
      dynamicB: { message: 'b' },
    };
    const files = {
      ...baseFiles,
      'dynamic.ts': "export const DYNAMIC = ['dynamicA', 'dynamicB'] satisfies MessageKey[];",
    };
    expect(check({ en: extra, ru: extra, files })).toEqual([]);
  });

  it('reports a key in a satisfies MessageKey[] list that does not exist', () => {
    const files = {
      ...baseFiles,
      'dynamic.ts': "export const DYNAMIC = ['nope'] satisfies MessageKey[];",
    };
    expect(rules(check({ files }))).toEqual(['unknown-key-used']);
  });

  it('reports a placeholder whose content is not a $n argument', () => {
    const hardcoded = {
      ...baseEn(),
      greeting: {
        message: 'Hello $NAME$',
        placeholders: { name: { content: 'Bob' } },
      },
    };
    expect(rules(check({ en: hardcoded, ru: hardcoded }))).toEqual([
      'placeholder-content',
      'placeholder-content',
    ]);
  });

  it('reports hardcoded numbers and percents in any locale', () => {
    const ru = { ...baseEn(), hint: { message: 'Занято 50%' } };
    expect(rules(check({ ru }))).toEqual(['hardcoded-number']);
  });

  it('allows descriptions up to 132 characters and rejects longer ones', () => {
    const ok = { ...baseEn(), appDesc: { message: 'a'.repeat(132) } };
    expect(check({ en: ok, ru: ok })).toEqual([]);
    const long = { ...baseEn(), appDesc: { message: 'a'.repeat(133) } };
    expect(rules(check({ en: long, ru: long }))).toEqual([
      'description-too-long',
      'description-too-long',
    ]);
  });

  it('rejects names longer than 75 characters', () => {
    const long = { ...baseEn(), appName: { message: 'n'.repeat(76) } };
    expect(rules(check({ en: long, ru: long }))).toEqual(['name-too-long', 'name-too-long']);
  });
});

// Message keys are looked up in the default locale: a key that is merely inherited by every object
// (constructor, toString, __proto__ ...) must not count as defined.
describe('checkLocales and prototype names', () => {
  const KEYS = PROTOTYPE_NAMES.filter((name) => /^[A-Za-z][A-Za-z0-9_]*$/.test(name));

  it.each(KEYS)('reports %s used in code as not defined in en', (name) => {
    const problems = check({
      files: { ...baseFiles, 'extra.ts': `t('${name}');` },
    });
    expect(rules(problems), name).toContain('unknown-key-used');
  });

  it.each(KEYS)('reports %s used as data-i18n as not defined in en', (name) => {
    const problems = check({
      files: { ...baseFiles, 'extra.html': `<p data-i18n="${name}"></p>` },
    });
    expect(rules(problems), name).toContain('unknown-key-used');
  });

  it.each(KEYS)('reports %s in a translation that en does not have as an extra key', (name) => {
    const ru: Messages = { ...baseEn(), [name]: { message: 'x' } };
    const problems = check({ ru });
    expect(problems.map((p) => p.message).join('\n'), name).toContain(`extra keys: ${name}`);
  });

  it.each(KEYS)('accepts %s when en really defines it and something uses it', (name) => {
    const en: Messages = { ...baseEn(), [name]: { message: 'x' } };
    const ru: Messages = { ...baseEn(), [name]: { message: 'y' } };
    expect(check({ en, ru, files: { ...baseFiles, 'extra.ts': `t('${name}');` } })).toEqual([]);
  });
});

describe('findHardcodedNumber', () => {
  it.each([
    '50%',
    '50 %',
    'save %1 now',
    '1,234',
    '1 234',
    '1.234',
    '1\u00a0234',
    'about 2.5',
    '10\u202f000',
    '$COUNT$%',
    '$COUNT$ %',
    'Counting the first 200 words',
    'Version 2',
    'Top 10 pages',
    '100\uff05',
    '\u066a\u0661\u0660\u0660',
    'm\u00b2',
    'half \u00bd',
    'step \u2460',
    'Roman \u216b',
    'x\u2075',
    'one \u0f2a',
    '\u0661\u0662\u0663 words',
    '\ufe6a',
    '100 percent',
  ])('flags %j', (message) => {
    expect(findHardcodedNumber(message)).toBeDefined();
  });

  it.each([
    'Page $COUNT$',
    'Share: $PERCENT$',
    'Hello, world',
    'Words of $MIN$ to $MAX$ characters',
  ])('does not flag %j', (message) => {
    expect(findHardcodedNumber(message)).toBeUndefined();
  });
});

describe('checkLocales on a broken locales directory', () => {
  it('reports invalid JSON and a locale folder without messages.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'locales-broken-'));
    dirs.push(root);
    const messages = JSON.stringify({
      appName: { message: 'Name' },
      appDesc: { message: 'Description' },
    });
    for (const [locale, text] of [
      ['en', messages],
      ['ru', '{ nope'],
    ] as const) {
      mkdirSync(join(root, '_locales', locale), { recursive: true });
      writeFileSync(join(root, '_locales', locale, 'messages.json'), text);
    }
    mkdirSync(join(root, '_locales', 'de'), { recursive: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(
      join(root, 'src', 'm.ts'),
      "export const a = '__MSG_appName__' + '__MSG_appDesc__';",
    );
    const problems = checkLocales({
      localesDir: join(root, '_locales'),
      srcDir: join(root, 'src'),
    });
    expect(rules(problems)).toEqual(
      expect.arrayContaining(['invalid-json', 'missing-messages-file']),
    );
  });
});

describe('required locales and the brand', () => {
  it('reports missing and unexpected locale directories', () => {
    const problems = checkRequired(['en', 'ru', 'de'], undefined);
    expect(problems.map((p) => p.rule)).toEqual(['missing-locale']);
    expect(checkRequired(['en'], undefined).map((p) => p.rule)).toEqual(['unexpected-locale']);
    expect(checkRequired(['en', 'ru'], undefined)).toEqual([]);
  });

  it('wants the brand in the name of every locale', () => {
    expect(checkRequired(['en', 'ru'], 'Name')).toEqual([]);
    const problems = checkRequired(['en', 'ru'], 'FontSnap');
    expect(problems.map((p) => p.rule)).toEqual(['brand-missing', 'brand-missing']);
  });

  function checkRequired(requiredLocales: string[], brand: string | undefined) {
    const root = mkdtempSync(join(tmpdir(), 'locales-'));
    dirs.push(root);
    for (const locale of ['en', 'ru']) {
      const file = join(root, '_locales', locale, 'messages.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(baseEn()));
    }
    for (const [name, content] of Object.entries(baseFiles)) {
      const file = join(root, 'src', name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    return checkLocales({
      localesDir: join(root, '_locales'),
      srcDir: join(root, 'src'),
      requiredLocales,
      ...(brand === undefined ? {} : { brand }),
    });
  }
});

describe('the fixed product number (FIXED_NUMBERS)', () => {
  it('lists the three messages that say "the 5 closest fonts" and nothing else', () => {
    expect([...FIXED_NUMBERS]).toEqual([
      ['appDesc', 5],
      ['scoreTitle', 5],
      ['wUse4', 5],
    ]);
  });

  it('reads the value of a digit of any script', () => {
    expect(['5', '٥', '۵', '५', '৫', '๕', '５'].map(digitValue)).toEqual([5, 5, 5, 5, 5, 5, 5]);
    expect(['0', '9', '٩', '𝟓'].map(digitValue)).toEqual([0, 9, 9, 5]);
    expect(['a', '½', '①', 'Ⅻ', '%', ''].map(digitValue)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('allows only the declared number, in any script, and still no percent sign', () => {
    expect(findHardcodedNumber('the top 5 fonts', 5)).toBeUndefined();
    expect(findHardcodedNumber('أفضل ٥', 5)).toBeUndefined();
    expect(findHardcodedNumber('the top 6 fonts', 5)).toBe('6');
    expect(findHardcodedNumber('top 15', 5)).toBe('1');
    expect(findHardcodedNumber('5% of fonts', 5)).toBe('%');
    expect(findHardcodedNumber('top ½', 5)).toBe('½');
    expect(findHardcodedNumber('the top 5 fonts')).toBe('5');
  });

  it('is applied only to the listed keys of checkLocales', () => {
    const withFive = {
      ...baseEn(),
      appDesc: { message: 'the 5 closest fonts' },
      hint: { message: 'the 5 closest fonts' },
    };
    expect(rules(check({ en: withFive, ru: withFive }))).toEqual([
      'hardcoded-number',
      'hardcoded-number',
    ]);
  });
});

// Port of the pre-TypeScript tests/js/unit/locales.test.mjs: the real locales of the real extension.
describe('FontSnap locales', () => {
  const root = process.cwd();
  const localesDir = join(root, 'public', '_locales');
  const langs = readdirSync(localesDir).sort();
  const read = (locale: string) =>
    JSON.parse(readFileSync(join(localesDir, locale, 'messages.json'), 'utf8')) as Messages;
  const en = read('en');
  const enKeys = Object.keys(en).sort();

  it('uses default_locale en and __MSG__ name/description in the manifest', () => {
    const manifest = buildManifest({ version: '0.1.0' });
    expect(manifest.default_locale).toBe('en');
    expect(manifest.name).toBe(`__MSG_${MANIFEST_MESSAGE_KEYS.name}__`);
    expect(manifest.description).toBe(`__MSG_${MANIFEST_MESSAGE_KEYS.description}__`);
    expect(MANIFEST_MESSAGE_KEYS).toEqual({ name: 'appName', description: 'appDesc' });
  });

  it('has every Chrome Web Store locale and nothing else (55)', () => {
    expect(CWS_LOCALES).toHaveLength(55);
    expect(langs).toEqual([...CWS_LOCALES].sort());
  });

  it.each(langs)(
    'locale %s: same keys as en, placeholders consistent, store limits, brand',
    (locale) => {
      const messages = read(locale);
      expect(Object.keys(messages).sort(), `${locale} keys differ from en`).toEqual(enKeys);
      for (const key of enKeys) {
        const entry = messages[key];
        const reference = en[key];
        expect(entry?.message.trim(), `${locale}.${key} empty`).toBeTruthy();
        expect(entry?.placeholders ?? {}, `${locale}.${key} placeholders`).toEqual(
          reference?.placeholders ?? {},
        );
        const used = new Set(
          [...(entry?.message ?? '').matchAll(/\$([A-Za-z_]+)\$/g)].map((m) =>
            (m[1] ?? '').toLowerCase(),
          ),
        );
        expect([...used].sort(), `${locale}.${key} uses placeholders`).toEqual(
          Object.keys(reference?.placeholders ?? {}).sort(),
        );
      }
      expect(
        Array.from(messages['appName']?.message ?? '').length,
        `${locale} name > 75`,
      ).toBeLessThanOrEqual(75);
      expect(
        Array.from(messages['appDesc']?.message ?? '').length,
        `${locale} description > 132`,
      ).toBeLessThanOrEqual(132);
      expect(messages['appName']?.message, `${locale} name must keep the brand`).toContain(
        'FontSnap',
      );
    },
  );

  it('every i18n key referenced in code/HTML/manifest exists in en and none is unused', () => {
    expect(
      checkLocales({
        localesDir,
        srcDir: join(root, 'src'),
        requiredLocales: CWS_LOCALES,
        brand: 'FontSnap',
      }),
    ).toEqual([]);
  });

  it('gives each locale at most one numeric character per fixed-number message, and none elsewhere', () => {
    for (const locale of langs) {
      for (const [key, entry] of Object.entries(read(locale))) {
        const numerals = Array.from(entry.message).filter((char) => /\p{N}/u.test(char));
        expect(numerals.length, `${locale}.${key}`).toBeLessThanOrEqual(
          FIXED_NUMBERS.has(key) ? 1 : 0,
        );
      }
    }
  });
});
