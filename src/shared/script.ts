import { UNKNOWN_SUBSETS } from './core/ranker';
import { fieldFromCapture } from './graphemes';
import { DIGITS, sampleOf, type SampleEntry, type ScriptCode } from './samples';

const VOTE = new Map<string, ScriptCode | 'CJK'>([
  ['Arab', 'Arab'],
  ['Hebr', 'Hebr'],
  ['Deva', 'Deva'],
  ['Beng', 'Beng'],
  ['Taml', 'Taml'],
  ['Telu', 'Telu'],
  ['Gujr', 'Gujr'],
  ['Knda', 'Knda'],
  ['Mlym', 'Mlym'],
  ['Thai', 'Thai'],
  ['Ethi', 'Ethi'],
  ['Kore', 'Kore'],
  ['Jpan', 'CJK'],
  ['Hira', 'CJK'],
  ['Hans', 'CJK'],
  ['Hant', 'CJK'],
]);

const CHAR_SCRIPT: readonly { test: RegExp; bucket: ScriptCode | 'Han' | 'Kana' }[] = [
  { test: /^\p{Script=Latin}$/u, bucket: 'Latn' },
  { test: /^\p{Script=Cyrillic}$/u, bucket: 'Cyrl' },
  { test: /^\p{Script=Greek}$/u, bucket: 'Grek' },
  { test: /^\p{Script=Arabic}$/u, bucket: 'Arab' },
  { test: /^\p{Script=Hebrew}$/u, bucket: 'Hebr' },
  { test: /^\p{Script=Devanagari}$/u, bucket: 'Deva' },
  { test: /^\p{Script=Bengali}$/u, bucket: 'Beng' },
  { test: /^\p{Script=Tamil}$/u, bucket: 'Taml' },
  { test: /^\p{Script=Telugu}$/u, bucket: 'Telu' },
  { test: /^\p{Script=Gujarati}$/u, bucket: 'Gujr' },
  { test: /^\p{Script=Kannada}$/u, bucket: 'Knda' },
  { test: /^\p{Script=Malayalam}$/u, bucket: 'Mlym' },
  { test: /^\p{Script=Thai}$/u, bucket: 'Thai' },
  { test: /^\p{Script=Ethiopic}$/u, bucket: 'Ethi' },
  { test: /^\p{Script=Hangul}$/u, bucket: 'Kore' },
  { test: /^\p{Script=Hiragana}$/u, bucket: 'Kana' },
  { test: /^\p{Script=Katakana}$/u, bucket: 'Kana' },
  { test: /^\p{Script=Han}$/u, bucket: 'Han' },
];

const DEFAULT_LOCALE = new Map<ScriptCode, string>([
  ['Latn', 'en'],
  ['Cyrl', 'ru'],
  ['Grek', 'el'],
  ['Arab', 'ar'],
  ['Hebr', 'he'],
  ['Deva', 'hi'],
  ['Beng', 'bn'],
  ['Taml', 'ta'],
  ['Telu', 'te'],
  ['Gujr', 'gu'],
  ['Knda', 'kn'],
  ['Mlym', 'ml'],
  ['Thai', 'th'],
  ['Ethi', 'am'],
  ['Kore', 'ko'],
  ['Jpan', 'ja'],
  ['Hans', 'zh_CN'],
  ['Hant', 'zh_TW'],
]);

const SCRIPT_SUBSET = new Map<ScriptCode, string>([
  ['Latn', 'latin'],
  ['Cyrl', 'cyrillic'],
  ['Grek', 'greek'],
  ['Arab', 'arabic'],
  ['Hebr', 'hebrew'],
  ['Deva', 'devanagari'],
  ['Beng', 'bengali'],
  ['Taml', 'tamil'],
  ['Telu', 'telugu'],
  ['Gujr', 'gujarati'],
  ['Knda', 'kannada'],
  ['Mlym', 'malayalam'],
  ['Thai', 'thai'],
  ['Ethi', 'ethiopic'],
  ['Jpan', 'japanese'],
  ['Kore', 'korean'],
  ['Hans', 'chinese-simplified'],
  ['Hant', 'chinese-traditional'],
]);

const SCRIPT_TAGS = new Map<string, ScriptCode>([
  ['latn', 'Latn'],
  ['cyrl', 'Cyrl'],
  ['grek', 'Grek'],
  ['arab', 'Arab'],
  ['hebr', 'Hebr'],
  ['deva', 'Deva'],
  ['beng', 'Beng'],
  ['taml', 'Taml'],
  ['telu', 'Telu'],
  ['gujr', 'Gujr'],
  ['knda', 'Knda'],
  ['mlym', 'Mlym'],
  ['thai', 'Thai'],
  ['ethi', 'Ethi'],
  ['jpan', 'Jpan'],
  ['kore', 'Kore'],
  ['hans', 'Hans'],
  ['hant', 'Hant'],
]);

/**
 * Map a language subtag onto a sample-table locale.
 * `pt` → Brazilian (the larger sample); legacy HTML tags `iw`/`in`/`tl`.
 */
const LOCALE_ALIAS = new Map<string, string>([
  ['nb', 'no'],
  ['nn', 'no'],
  ['pt', 'pt_BR'],
  ['iw', 'he'],
  ['in', 'id'],
  ['tl', 'fil'],
]);

const PERSIAN = new Set(['پ', 'چ', 'ژ', 'گ']);
const LETTER = /\p{L}/u;
const EN_SAMPLE: SampleEntry = {
  script: 'Latn',
  text: 'The quick brown fox jumps over the lazy dog',
};

export interface ChosenSample {
  locale: string;
  script: ScriptCode;
  text: string;
  /** Second line under an automatic sample. Empty when typed or page text is shown. */
  digits: string;
  /** Typed input or captured page text is never swapped per card. */
  fromRealText: boolean;
}

export interface ChooseSampleInput {
  typed?: string | null | undefined;
  pageText?: string | null | undefined;
  /** primaryScript values of the top-5 ranked families. */
  topScripts?: readonly string[] | undefined;
  hint?: string | null | undefined;
  lang?: string | null | undefined;
  uiLang?: string | null | undefined;
}

export interface FamilyCoverage {
  script: string;
  subsets: number;
}

function normalizeLocale(tag: string): string {
  const parts = tag.trim().replace(/-/g, '_').split('_');
  const head = parts[0];
  if (head === undefined || head === '') return '';
  if (parts.length === 1) return head.toLowerCase();
  const second = parts[1];
  if (second === undefined || second === '') return head.toLowerCase();
  const rest = parts.slice(2).map((part) => part.toLowerCase());
  return [head.toLowerCase(), second.toUpperCase(), ...rest].join('_');
}

function tagParts(tag: string): string[] {
  return tag
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
    .split('-')
    .filter((part) => part !== '');
}

function explicitScript(tag: string): ScriptCode | undefined {
  for (const part of tagParts(tag).slice(1)) {
    const script = SCRIPT_TAGS.get(part);
    if (script !== undefined) return script;
  }
  return undefined;
}

function localeForBase(normalized: string): string | undefined {
  if (sampleOf(normalized) !== undefined) return normalized;
  const base = normalized.split('_')[0] ?? '';
  if (base === 'zh') {
    const upper = normalized.toUpperCase();
    if (upper.includes('TW') || upper.includes('HK') || upper.includes('HANT')) return 'zh_TW';
    return 'zh_CN';
  }
  if (sampleOf(base) !== undefined) return base;
  const aliased = LOCALE_ALIAS.get(base);
  if (aliased !== undefined && sampleOf(aliased) !== undefined) return aliased;
  return undefined;
}

/** Map a BCP 47 tag onto a locale that has a sample row. */
export function localeFromTag(tag: string | null | undefined): string | undefined {
  if (tag === null || tag === undefined) return undefined;
  const normalized = normalizeLocale(tag);
  if (normalized === '') return undefined;
  const locale = localeForBase(normalized);
  if (locale === undefined) return undefined;
  const forced = explicitScript(tag);
  const sample = sampleOf(locale);
  if (forced !== undefined && sample !== undefined && sample.script !== forced) return undefined;
  return locale;
}

export function scriptOfLocale(locale: string): ScriptCode | undefined {
  return sampleOf(locale)?.script;
}

/** Script of a BCP 47 tag. An explicit script subtag wins over the locale row. */
export function scriptOfLang(tag: string | null | undefined): ScriptCode | undefined {
  if (tag === null || tag === undefined || tag.trim() === '') return undefined;
  return explicitScript(tag) ?? scriptOfLocale(localeFromTag(tag) ?? '');
}

function hanVariant(lang?: string | null, uiLang?: string | null): 'Hans' | 'Hant' {
  const fromLang = scriptOfLang(lang);
  if (fromLang === 'Hans' || fromLang === 'Hant') return fromLang;
  if (scriptOfLang(uiLang) === 'Hant') return 'Hant';
  return 'Hans';
}

function bucketOf(ch: string): ScriptCode | 'Han' | 'Kana' | undefined {
  for (const row of CHAR_SCRIPT) {
    if (row.test.test(ch)) return row.bucket;
  }
  return undefined;
}

function tally(
  text: string,
  lang?: string | null,
  uiLang?: string | null,
): { counts: Map<ScriptCode, number>; other: number } {
  const raw: (ScriptCode | 'Han' | 'Kana')[] = [];
  let other = 0;
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    const bucket = bucketOf(ch);
    if (bucket === undefined) {
      other += 1;
      continue;
    }
    raw.push(bucket);
  }
  const kana = raw.some((bucket) => bucket === 'Kana');
  const counts = new Map<ScriptCode, number>();
  const add = (code: ScriptCode) => counts.set(code, (counts.get(code) ?? 0) + 1);
  for (const bucket of raw) {
    if (bucket === 'Kana' || (bucket === 'Han' && kana)) add('Jpan');
    else if (bucket === 'Han') add(hanVariant(lang, uiLang));
    else add(bucket);
  }
  return { counts, other };
}

function majority(counts: ReadonlyMap<ScriptCode, number>, other: number): ScriptCode | undefined {
  let best: ScriptCode | undefined;
  let bestN = 0;
  let tied = false;
  for (const [code, n] of counts) {
    if (n > bestN) {
      best = code;
      bestN = n;
      tied = false;
    } else if (n === bestN) tied = true;
  }
  if (best === undefined || tied || other >= bestN) return undefined;
  return best;
}

/** Dominant letter script. Digits and punctuation do not vote. Kana marks Han as Japanese. */
export function detectScript(
  text: string,
  langHint?: string | null,
  uiLang?: string | null,
): ScriptCode | undefined {
  const found = tally(text, langHint, uiLang);
  return majority(found.counts, found.other);
}

/**
 * Rule B: at least 3 of the top 5 share one non-Latin primaryScript.
 * Jpan, Hira, Hans and Hant count as one CJK bucket. Latn and empty never vote.
 */
export function voteScript(topScripts: readonly string[]): ScriptCode | 'CJK' | undefined {
  const counts = new Map<ScriptCode | 'CJK', number>();
  for (const raw of topScripts.slice(0, 5)) {
    const bucket = VOTE.get(raw);
    if (bucket === undefined) continue;
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  let best: ScriptCode | 'CJK' | undefined;
  let bestN = 0;
  for (const [key, n] of counts) {
    if (n > bestN) {
      best = key;
      bestN = n;
    }
  }
  if (best === undefined || bestN < 3) return undefined;
  return best;
}

/** Language inside a CJK vote: page lang, then UI lang, then the top-5 majority. */
export function resolveCjk(
  topScripts: readonly string[],
  lang?: string | null,
  uiLang?: string | null,
): 'Jpan' | 'Hans' | 'Hant' {
  const fromLang = scriptOfLang(lang);
  if (fromLang === 'Jpan' || fromLang === 'Hans' || fromLang === 'Hant') return fromLang;
  const fromUi = scriptOfLang(uiLang);
  if (fromUi === 'Jpan' || fromUi === 'Hans' || fromUi === 'Hant') return fromUi;
  const counts = new Map<'Jpan' | 'Hans' | 'Hant', number>([
    ['Jpan', 0],
    ['Hans', 0],
    ['Hant', 0],
  ]);
  for (const raw of topScripts.slice(0, 5)) {
    let key: 'Jpan' | 'Hans' | 'Hant' | undefined;
    if (raw === 'Jpan' || raw === 'Hira') key = 'Jpan';
    else if (raw === 'Hans' || raw === 'Hant') key = raw;
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: 'Jpan' | 'Hans' | 'Hant' = 'Jpan';
  let bestN = -1;
  for (const [code, n] of counts) {
    if (n > bestN) {
      best = code;
      bestN = n;
    }
  }
  return best;
}

function hasPersian(hint: string): boolean {
  for (const ch of hint) {
    if (PERSIAN.has(ch)) return true;
  }
  return false;
}

function localeForScript(
  script: ScriptCode,
  lang?: string | null,
  uiLang?: string | null,
  hint?: string | null,
): string {
  const langLoc = localeFromTag(lang);
  if (langLoc !== undefined && scriptOfLocale(langLoc) === script) return langLoc;
  const uiLoc = localeFromTag(uiLang);
  if (uiLoc !== undefined && scriptOfLocale(uiLoc) === script) return uiLoc;
  if (script === 'Arab' && hint !== undefined && hint !== null && hasPersian(hint)) return 'fa';
  return DEFAULT_LOCALE.get(script) ?? 'en';
}

function entry(locale: string): SampleEntry {
  return sampleOf(locale) ?? EN_SAMPLE;
}

function realText(
  text: string,
  locale: 'typed' | 'page',
  lang?: string | null,
  uiLang?: string | null,
): ChosenSample {
  return {
    locale,
    script: detectScript(text, lang, uiLang) ?? 'Latn',
    text,
    digits: '',
    fromRealText: true,
  };
}

/** Typed text, then page text that fits the field, then model vote, hint, page lang, UI, English. */
export function chooseSample(input: ChooseSampleInput): ChosenSample {
  const typed = (input.typed ?? '').trim();
  if (typed !== '') return realText(typed, 'typed', input.lang, input.uiLang);
  const page = fieldFromCapture(input.pageText);
  if (page !== '') return realText(page, 'page', input.lang, input.uiLang);

  const top = input.topScripts ?? [];
  let script: ScriptCode | undefined;
  const voted = voteScript(top);
  if (voted === 'CJK') script = resolveCjk(top, input.lang, input.uiLang);
  else if (voted !== undefined) script = voted;

  if (
    script === undefined &&
    input.hint !== undefined &&
    input.hint !== null &&
    input.hint !== ''
  ) {
    const found = tally(input.hint, input.lang, input.uiLang);
    const dominant = majority(found.counts, found.other);
    const letters = dominant === undefined ? 0 : (found.counts.get(dominant) ?? 0);
    // Q1: a Latin alt/title ("photo", filenames) does not vote; page lang wins.
    if (dominant !== undefined && dominant !== 'Latn' && letters >= 3) script = dominant;
  }
  script ??= scriptOfLang(input.lang) ?? scriptOfLang(input.uiLang) ?? 'Latn';
  const locale = localeForScript(script, input.lang, input.uiLang, input.hint);
  const sample = entry(locale);
  return {
    locale: sampleOf(locale) === undefined ? 'en' : locale,
    script: sample.script,
    text: sample.text,
    digits: DIGITS,
    fromRealText: false,
  };
}

/** Bit for `name` in meta.subsetNames. JS bitwise ops stop being safe past bit 30. */
export function subsetBit(subsetNames: readonly string[], name: string): number | undefined {
  const index = subsetNames.indexOf(name);
  if (index < 0 || index > 30) return undefined;
  return 1 << index;
}

export function familyHasSubset(
  subsets: number,
  subsetNames: readonly string[],
  name: string,
): boolean {
  // Unknown metadata is not a mask. Bitwise AND with -1 would match every subset.
  if (subsets === UNKNOWN_SUBSETS) return false;
  const bit = subsetBit(subsetNames, name);
  return bit !== undefined && (subsets & bit) !== 0;
}

function inGfLatin(cp: number): boolean {
  if (cp <= 0x00ff) return true;
  if (cp === 0x0131 || cp === 0x0152 || cp === 0x0153) return true;
  if (cp >= 0x02bb && cp <= 0x02bc) return true;
  return cp === 0x02c6 || cp === 0x02da || cp === 0x02dc;
}

/** Subset a font needs in order to draw this sample. `latin` covers Latin-1; diacritics need `latin-ext`. */
export function requiredSubset(locale: string, script: ScriptCode): string {
  if (script === 'Latn') {
    if (locale === 'vi') return 'vietnamese';
    const text = sampleOf(locale)?.text;
    if (text !== undefined) {
      for (const ch of text) {
        if (!/^\p{L}$/u.test(ch)) continue;
        const cp = ch.codePointAt(0);
        if (cp !== undefined && !inGfLatin(cp)) return 'latin-ext';
      }
    }
    return 'latin';
  }
  return SCRIPT_SUBSET.get(script) ?? 'latin';
}

function covers(
  subsets: number,
  subsetNames: readonly string[],
  locale: string,
  script: ScriptCode,
): boolean {
  if (familyHasSubset(subsets, subsetNames, requiredSubset(locale, script))) return true;
  return script === 'Hant' && familyHasSubset(subsets, subsetNames, 'chinese-hongkong');
}

function knownScript(raw: string): ScriptCode | undefined {
  if (raw === 'Hira') return 'Jpan';
  for (const code of DEFAULT_LOCALE.keys()) {
    if (code === raw) return code;
  }
  return undefined;
}

function card(locale: string): { text: string; locale: string; script: ScriptCode } {
  const sample = entry(locale);
  const resolved = sampleOf(locale) === undefined ? 'en' : locale;
  return { text: `${sample.text}\n${DIGITS}`, locale: resolved, script: sample.script };
}

function cardChosen(chosen: ChosenSample): { text: string; locale: string; script: ScriptCode } {
  return {
    text: chosen.digits === '' ? chosen.text : `${chosen.text}\n${chosen.digits}`,
    locale: chosen.locale,
    script: chosen.script,
  };
}

function latinFallback(
  subsets: number,
  subsetNames: readonly string[],
  lang?: string | null,
  uiLang?: string | null,
): { text: string; locale: string; script: ScriptCode } {
  const candidates: string[] = [];
  const langLoc = localeFromTag(lang);
  if (langLoc !== undefined && scriptOfLocale(langLoc) === 'Latn') candidates.push(langLoc);
  const uiLoc = localeFromTag(uiLang);
  if (uiLoc !== undefined && scriptOfLocale(uiLoc) === 'Latn' && !candidates.includes(uiLoc)) {
    candidates.push(uiLoc);
  }
  if (!candidates.includes('en')) candidates.push('en');
  for (const locale of candidates) {
    if (covers(subsets, subsetNames, locale, 'Latn')) return card(locale);
  }
  return card('en');
}

/**
 * Per-card text for an automatic sample. Real text is kept.
 * A family with no Google Fonts metadata (subsets -1) keeps the shared sample.
 */
export function sampleForFamily(
  chosen: ChosenSample,
  family: FamilyCoverage,
  subsetNames: readonly string[],
  lang?: string | null,
  uiLang?: string | null,
): { text: string; locale: string; script: ScriptCode } {
  if (chosen.fromRealText) {
    return { text: chosen.text, locale: chosen.locale, script: chosen.script };
  }
  if (
    family.subsets === UNKNOWN_SUBSETS ||
    covers(family.subsets, subsetNames, chosen.locale, chosen.script)
  ) {
    return cardChosen(chosen);
  }
  const mapped = knownScript(family.script);
  if (mapped !== undefined && mapped !== 'Latn') {
    const locale = DEFAULT_LOCALE.get(mapped);
    if (locale !== undefined && covers(family.subsets, subsetNames, locale, mapped)) {
      return card(locale);
    }
  }
  return latinFallback(family.subsets, subsetNames, lang, uiLang);
}

export function htmlLang(locale: string): string {
  return locale.replace(/_/g, '-');
}

export function sampleDir(script: ScriptCode): 'auto' | undefined {
  return script === 'Arab' || script === 'Hebr' ? 'auto' : undefined;
}
