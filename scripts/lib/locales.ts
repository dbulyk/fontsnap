import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';

/** The messages the manifest names (`__MSG_<key>__`): the Chrome Web Store limits apply to them. */
export const MANIFEST_MESSAGE_KEYS = { name: 'appName', description: 'appDesc' } as const;

/** Chrome Web Store locale codes (https://developer.chrome.com/docs/extensions/reference/api/i18n#locales). */
export const CWS_LOCALES: readonly string[] = (
  'ar am bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr gu he hi hr hu id it ja kn ko lt lv ml mr ' +
  'ms nl no pl pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr uk vi zh_CN zh_TW'
).split(' ');

export interface LocaleProblem {
  rule: string;
  message: string;
}

export interface CheckOptions {
  /** Directory with `<locale>/messages.json` files (public/_locales). */
  localesDir: string;
  /** Source tree scanned for message keys (.ts and .html files, including the manifest builder). */
  srcDir: string;
  defaultLocale?: string;
  /** When given, the locale directories must be exactly these (no missing, no extra). */
  requiredLocales?: readonly string[];
  /** When given, every locale's name message must contain it (the brand is not translated away). */
  brand?: string;
}

interface Entry {
  message: string;
  placeholders?: Record<string, { content?: string }>;
}
type Messages = Record<string, Entry>;

const KEY_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const DESCRIPTION_LIMIT = 132; // Chrome Web Store
const NAME_LIMIT = 75; // Chrome Web Store

/**
 * The few messages that state a fixed product number, and that number: FontSnap always shows the 5 closest
 * fonts, so the store description, the score tooltip and the usage hint say "5" (in each language's own digits).
 * The template wants numbers passed in as placeholders so that every locale formats them natively, which
 * is right for computed values and wrong for a constant of the product that is part of the sentence; the texts
 * are translations that must not change. Only these keys may contain only this number; everything else stays
 * number-free.
 */
export const FIXED_NUMBERS: ReadonlyMap<string, number> = new Map([
  ['appDesc', 5],
  ['scoreTitle', 5],
  ['wUse4', 5],
]);

const DECIMAL_DIGIT = /^\p{Nd}$/u;

/** The value (0-9) of a decimal digit of any script, or undefined for any other character. */
export function digitValue(char: string): number | undefined {
  const code = char.codePointAt(0);
  if (code === undefined || !DECIMAL_DIGIT.test(char)) return undefined;
  // Decimal digits come in contiguous runs of ten starting at zero.
  let start = code;
  while (DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start--;
  return (code - start) % 10;
}

/**
 * Finds digits and percent signs baked into a translation. Numbers and percents must be passed
 * in as placeholders formatted in code so every locale formats them natively. Any numeric character
 * of any script (`\p{N}`: decimal digits, ², ½, ①, Ⅻ, ...) and every percent sign variant (% ٪ ％ ﹪) is
 * rejected once placeholders are removed, except digits whose value is `allowed` (see FIXED_NUMBERS).
 */
export function findHardcodedNumber(message: string, allowed?: number): string | undefined {
  const withoutPlaceholders = message.replace(/\$[A-Za-z0-9_@]+\$/g, '');
  const checked =
    allowed === undefined
      ? withoutPlaceholders
      : Array.from(withoutPlaceholders)
          .filter((char) => digitValue(char) !== allowed)
          .join('');
  return /[\p{N}%\u066a\uff05\ufe6a]/u.exec(checked)?.[0];
}

function walk(dir: string, extensions: string[]): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path, extensions));
    else if (extensions.some((ext) => name.endsWith(ext)) && !name.endsWith('.d.ts'))
      files.push(path);
  }
  return files;
}

function placeholderSignature(entry: Entry): string {
  const placeholders = Object.entries(entry.placeholders ?? {})
    .map(([name, value]) => `${name.toLowerCase()}=${value.content ?? ''}`)
    .sort();
  return placeholders.join(',');
}

function undeclaredPlaceholders(entry: Entry): string[] {
  const declared = new Set(Object.keys(entry.placeholders ?? {}).map((name) => name.toLowerCase()));
  const used = [...entry.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  );
  return used.filter((name) => !declared.has(name));
}

function unusedPlaceholders(entry: Entry): string[] {
  const used = new Set(
    [...entry.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((m) => (m[1] ?? '').toLowerCase()),
  );
  return Object.keys(entry.placeholders ?? {}).filter((name) => !used.has(name.toLowerCase()));
}

function readMessages(file: string, problems: LocaleProblem[]): Messages | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Messages;
  } catch (error) {
    problems.push({ rule: 'invalid-json', message: `${file}: ${String(error)}` });
    return undefined;
  }
}

interface KeyUsage {
  /**
   * Keys referenced via t('…') / getMessage('…'), data-i18n(-ph|-title)="…", __MSG_…__ or an explicit
   * `[...] satisfies MessageKey[]` list (for keys chosen at run time). Only these count as used,
   * and they must all exist; a bare string literal that happens to equal a key means nothing.
   */
  references: Map<string, string>;
}

function scanSources(srcDir: string): KeyUsage {
  const references = new Map<string, string>();
  const addReference = (key: string | undefined, file: string) => {
    if (key !== undefined && !references.has(key)) references.set(key, file);
  };
  for (const file of walk(srcDir, ['.ts', '.html'])) {
    // Comments never count: a key mentioned only in `// t('oldKey')` is unused.
    const raw = readFileSync(file, 'utf8');
    const source = file.endsWith('.html')
      ? raw.replace(/<!--[\s\S]*?-->/g, '')
      : stripComments(raw, file);
    for (const m of source.matchAll(/__MSG_([A-Za-z0-9_@]+)__/g)) addReference(m[1], file);
    if (file.endsWith('.html')) {
      for (const m of source.matchAll(/data-i18n(?:-ph|-title)?="([^"]*)"/g))
        addReference(m[1], file);
      continue;
    }
    for (const m of source.matchAll(/\b(?:t|getMessage)\(\s*(['"`])([A-Za-z0-9_@]+)\1/g)) {
      addReference(m[2], file);
    }
    for (const list of source.matchAll(/\[([^\]]*)\]\s*satisfies\s+MessageKey\[\]/g)) {
      for (const key of (list[1] ?? '').matchAll(/(['"`])([^'"`]+)\1/g)) addReference(key[2], file);
    }
  }
  return { references };
}

export function checkLocales(options: CheckOptions): LocaleProblem[] {
  const { localesDir, srcDir, defaultLocale = 'en', requiredLocales, brand } = options;
  const problems: LocaleProblem[] = [];

  if (!existsSync(join(localesDir, defaultLocale, 'messages.json'))) {
    return [
      {
        rule: 'missing-default-locale',
        message: `No ${defaultLocale}/messages.json in ${localesDir}`,
      },
    ];
  }

  const locales = new Map<string, Messages>();
  for (const name of readdirSync(localesDir)) {
    const file = join(localesDir, name, 'messages.json');
    if (!existsSync(file)) {
      problems.push({ rule: 'missing-messages-file', message: `${name}: messages.json not found` });
      continue;
    }
    const messages = readMessages(file, problems);
    if (messages) locales.set(name, messages);
  }
  if (requiredLocales !== undefined) {
    const present = new Set(locales.keys());
    const wanted = new Set(requiredLocales);
    const missing = requiredLocales.filter((name) => !present.has(name));
    const extra = [...present].filter((name) => !wanted.has(name));
    if (missing.length > 0) {
      problems.push({ rule: 'missing-locale', message: `missing locales: ${missing.join(', ')}` });
    }
    if (extra.length > 0) {
      problems.push({
        rule: 'unexpected-locale',
        message: `unexpected locales: ${extra.join(', ')}`,
      });
    }
  }
  const reference = locales.get(defaultLocale);
  if (!reference) return problems;
  // A Map: a key such as `constructor` or `toString` is not defined just because every object has it.
  const definitions = new Map(Object.entries(reference));
  const referenceKeys = [...definitions.keys()];

  for (const [locale, messages] of locales) {
    for (const [key, entry] of Object.entries(messages)) {
      if (!KEY_NAME.test(key)) {
        problems.push({
          rule: 'bad-key-name',
          message: `${locale}: "${key}" is not a valid key name`,
        });
      }
      if (entry.message.trim() === '') {
        problems.push({ rule: 'empty-message', message: `${locale}: "${key}" is empty` });
      }
      for (const name of undeclaredPlaceholders(entry)) {
        problems.push({
          rule: 'undeclared-placeholder',
          message: `${locale}: "${key}" uses $${name.toUpperCase()}$ without declaring it`,
        });
      }
      for (const [name, placeholder] of Object.entries(entry.placeholders ?? {})) {
        if (!/^\$[1-9]$/.test(placeholder.content ?? '')) {
          problems.push({
            rule: 'placeholder-content',
            message: `${locale}: "${key}" placeholder "${name}" must have content "$1".."$9", found ${JSON.stringify(placeholder.content)}`,
          });
        }
      }
      for (const name of unusedPlaceholders(entry)) {
        problems.push({
          rule: 'unused-placeholder',
          message: `${locale}: "${key}" declares "${name}" but the message never uses $${name.toUpperCase()}$`,
        });
      }
      const number = findHardcodedNumber(entry.message, FIXED_NUMBERS.get(key));
      if (number !== undefined) {
        problems.push({
          rule: 'hardcoded-number',
          message: `${locale}: "${key}" contains "${number}"; pass numbers/percents as placeholders formatted in code (a fixed product number goes to FIXED_NUMBERS in scripts/lib/locales.ts)`,
        });
      }
      const refEntry = definitions.get(key);
      if (
        locale !== defaultLocale &&
        refEntry &&
        placeholderSignature(entry) !== placeholderSignature(refEntry)
      ) {
        problems.push({
          rule: 'placeholder-mismatch',
          message: `${locale}: "${key}" placeholders (${placeholderSignature(entry)}) differ from ${defaultLocale} (${placeholderSignature(refEntry)})`,
        });
      }
    }

    if (locale !== defaultLocale) {
      const keys = new Set(Object.keys(messages));
      const missing = referenceKeys.filter((key) => !keys.has(key));
      const extra = [...keys].filter((key) => !definitions.has(key));
      if (missing.length > 0) {
        problems.push({
          rule: 'keys-mismatch',
          message: `${locale}: missing keys: ${missing.join(', ')}`,
        });
      }
      if (extra.length > 0) {
        problems.push({
          rule: 'keys-mismatch',
          message: `${locale}: extra keys: ${extra.join(', ')}`,
        });
      }
    }

    const description = messages[MANIFEST_MESSAGE_KEYS.description]?.message ?? '';
    if (description.length > DESCRIPTION_LIMIT) {
      problems.push({
        rule: 'description-too-long',
        message: `${locale}: ${MANIFEST_MESSAGE_KEYS.description} is ${String(description.length)} characters (max ${String(DESCRIPTION_LIMIT)})`,
      });
    }
    const name = messages[MANIFEST_MESSAGE_KEYS.name]?.message ?? '';
    if (name.length > NAME_LIMIT) {
      problems.push({
        rule: 'name-too-long',
        message: `${locale}: ${MANIFEST_MESSAGE_KEYS.name} is ${String(name.length)} characters (max ${String(NAME_LIMIT)})`,
      });
    }
    if (brand !== undefined && !name.includes(brand)) {
      problems.push({
        rule: 'brand-missing',
        message: `${locale}: ${MANIFEST_MESSAGE_KEYS.name} does not contain the brand "${brand}"`,
      });
    }
  }

  const usage = scanSources(srcDir);
  for (const [key, file] of usage.references) {
    if (!definitions.has(key)) {
      problems.push({
        rule: 'unknown-key-used',
        message: `"${key}" used in ${file} is not in ${defaultLocale}`,
      });
    }
  }
  const referenced = new Set(usage.references.keys());
  for (const key of referenceKeys) {
    if (!referenced.has(key)) {
      problems.push({
        rule: 'unused-key',
        message: `"${key}" in ${defaultLocale} is not used anywhere`,
      });
    }
  }
  return problems;
}
