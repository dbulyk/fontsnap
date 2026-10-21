import { describe, expect, it } from 'vitest';
import { UNKNOWN_SUBSETS } from '../../src/shared/core/ranker';
import { DIGITS, sampleOf } from '../../src/shared/samples';
import {
  chooseSample,
  detectScript,
  familyHasSubset,
  htmlLang,
  localeFromTag,
  requiredSubset,
  sampleDir,
  sampleForFamily,
  scriptOfLang,
  subsetBit,
  voteScript,
} from '../../src/shared/script';
import { PROTOTYPE_NAMES } from './helpers/media';

describe('detectScript', () => {
  it('detects each table script and ignores digits', () => {
    expect(detectScript('Hello 0123')).toBe('Latn');
    expect(detectScript('Съешь же ещё')).toBe('Cyrl');
    expect(detectScript('Ξεσκεπάζω')).toBe('Grek');
    expect(detectScript('صف خلق خود')).toBe('Arab');
    expect(detectScript('דג סקרן')).toBe('Hebr');
    expect(detectScript('सभी मनुष्य')).toBe('Deva');
    expect(detectScript('সমস্ত মানুষ')).toBe('Beng');
    expect(detectScript('மனிதப்')).toBe('Taml');
    expect(detectScript('ప్రతిపత్తి')).toBe('Telu');
    expect(detectScript('પ્રતિષ્ઠા')).toBe('Gujr');
    expect(detectScript('ಎಲ್ಲಾ')).toBe('Knda');
    expect(detectScript('മനുഷ്യരെല്ലാവരും')).toBe('Mlym');
    expect(detectScript('มนุษย์ทั้งหลาย')).toBe('Thai');
    expect(detectScript('የሰው፡ልጅ')).toBe('Ethi');
    expect(detectScript('다람쥐')).toBe('Kore');
    expect(detectScript('あのイーハトーヴォ')).toBe('Jpan');
    expect(detectScript('天地玄黄')).toBe('Hans');
    expect(detectScript('天地玄黃', 'zh-TW')).toBe('Hant');
    expect(detectScript('天地玄黃', 'zh-Hant')).toBe('Hant');
    expect(detectScript('天地玄黃', undefined, 'zh-HK')).toBe('Hant');
    expect(detectScript('天地玄黃', 'zh-CN', 'zh-TW')).toBe('Hans');
    expect(detectScript('カタカナ')).toBe('Jpan');
    expect(detectScript('123 !!!')).toBeUndefined();
  });

  it('picks the majority script in mixed text', () => {
    expect(detectScript('Hello Привет Привет Привет')).toBe('Cyrl');
    expect(detectScript('aaббб')).toBe('Cyrl');
    expect(detectScript('ааaб')).toBe('Cyrl');
    expect(detectScript('abаб')).toBeUndefined();
    expect(detectScript('សួស្តី')).toBeUndefined();
    expect(detectScript('aសួស្តីសួស្តី')).toBeUndefined();
    expect(detectScript('東京タワー')).toBe('Jpan');
    expect(detectScript('Hello!!!')).toBe('Latn');
  });
});

describe('voteScript', () => {
  it('needs ≥3 matching non-Latin scripts; CJK buckets together', () => {
    expect(voteScript(['Arab', 'Arab', 'Arab', 'Latn', ''])).toBe('Arab');
    expect(voteScript(['Arab', 'Arab', 'Latn', 'Latn', ''])).toBeUndefined();
    expect(voteScript(['Jpan', 'Hans', 'Hira', 'Latn', ''])).toBe('CJK');
    expect(voteScript(['Latn', '', 'Latn', '', 'Latn'])).toBeUndefined();
    expect(voteScript(['Khmr', 'Khmr', 'Khmr', 'Khmr', 'Khmr'])).toBeUndefined();
    expect(voteScript(['Kore', 'Kore', 'Kore', 'Latn', ''])).toBe('Kore');
    expect(voteScript(['Hira', 'Hira', 'Hira', 'Latn', ''])).toBe('CJK');
    expect(voteScript(['Latn', 'Latn', 'Latn', 'Latn', 'Latn', 'Arab', 'Arab', 'Arab'])).toBe(
      undefined,
    );
  });
});

describe('chooseSample', () => {
  it('follows typed > page > B > hint > lang > UI > en', () => {
    expect(chooseSample({ typed: 'Hi', pageText: 'Page', uiLang: 'ru' }).text).toBe('Hi');
    expect(chooseSample({ pageText: 'Привет', uiLang: 'en' }).text).toBe('Привет');
    expect(
      chooseSample({ topScripts: ['Arab', 'Arab', 'Arab', 'Arab', 'Arab'], uiLang: 'en' }).text,
    ).toBe(sampleOf('ar')?.text ?? '');
    expect(chooseSample({ hint: 'سلام دنیا', uiLang: 'en' }).locale).toBe('ar');
    expect(chooseSample({ lang: 'ru', uiLang: 'en' }).text).toBe(sampleOf('ru')?.text ?? '');
    expect(chooseSample({ uiLang: 'ru' }).text).toBe(sampleOf('ru')?.text ?? '');
    expect(chooseSample({}).text).toBe(sampleOf('en')?.text ?? '');
    expect(chooseSample({ uiLang: 'ru' }).digits).toBe(DIGITS);
    expect(chooseSample({ pageText: 'a'.repeat(100), uiLang: 'ru' }).text).toBe('a'.repeat(100));
    expect(chooseSample({ pageText: 'a'.repeat(101), uiLang: 'ru' }).text).toBe(
      sampleOf('ru')?.text ?? '',
    );
    expect(chooseSample({ topScripts: ['Arab', 'Arab', 'Arab', '', ''], hint: 'چای' }).locale).toBe(
      'fa',
    );
    expect(
      chooseSample({
        topScripts: ['Arab', 'Arab', 'Arab', '', ''],
        hint: 'چای',
        lang: 'ar',
      }).locale,
    ).toBe('ar');
    expect(
      chooseSample({ topScripts: ['Hans', 'Hans', 'Hans', 'Jpan', ''], lang: 'ja' }).locale,
    ).toBe('ja');
    expect(chooseSample({ uiLang: 'constructor' }).locale).toBe('en');
    expect(chooseSample({ typed: '  Hi  ' }).locale).toBe('typed');
    expect(chooseSample({ typed: 'Hi' }).digits).toBe('');
    expect(chooseSample({ pageText: 'Page' }).locale).toBe('page');
    expect(chooseSample({ hint: 'аб', uiLang: 'en' }).locale).toBe('en');
    expect(chooseSample({ hint: 'سلام گچ', uiLang: 'en' }).locale).toBe('fa');
    expect(chooseSample({ topScripts: ['Jpan', 'Jpan', 'Jpan', 'Latn', ''] }).locale).toBe('ja');
    expect(
      chooseSample({ topScripts: ['Jpan', 'Jpan', 'Jpan', 'Latn', ''], lang: 'zh-TW' }).locale,
    ).toBe('zh_TW');
    expect(chooseSample({ uiLang: 'nb' }).locale).toBe('no');
    expect(chooseSample({ uiLang: 'nn' }).locale).toBe('no');
    expect(
      chooseSample({ topScripts: ['Deva', 'Deva', 'Deva', 'Latn', ''], lang: 'mr' }).locale,
    ).toBe('mr');
    expect(
      chooseSample({ topScripts: ['Deva', 'Deva', 'Deva', 'Latn', ''], lang: 'en' }).locale,
    ).toBe('hi');
    expect(chooseSample({ lang: 'sr-Latn', uiLang: 'en' }).locale).toBe('en');
    expect(chooseSample({ lang: 'sr-Latn', uiLang: 'en' }).text).toBe(sampleOf('en')?.text ?? '');
    expect(chooseSample({ lang: 'sr-Latn', uiLang: 'ru' }).locale).toBe('en');
    expect(chooseSample({ lang: 'pt', uiLang: 'ru' }).locale).toBe('pt_BR');
    expect(chooseSample({ lang: 'pt-BR', uiLang: 'en' }).locale).toBe('pt_BR');
    expect(chooseSample({ lang: 'iw', uiLang: 'en' }).locale).toBe('he');
    expect(chooseSample({ lang: 'in', uiLang: 'en' }).locale).toBe('id');
    expect(chooseSample({ lang: 'tl', uiLang: 'en' }).locale).toBe('fil');
    // Q1: Latin alt does not vote; page lang wins. Non-Latin alt still votes.
    expect(chooseSample({ lang: 'ru', hint: 'photo', uiLang: 'en' }).locale).toBe('ru');
    expect(chooseSample({ lang: 'en', hint: 'مثال على الخط', uiLang: 'en' }).locale).toBe('ar');
  });
});

describe('language tags', () => {
  it('reads the script subtag and the Norwegian aliases', () => {
    expect(scriptOfLang('ru')).toBe('Cyrl');
    expect(scriptOfLang('en-US')).toBe('Latn');
    expect(scriptOfLang('zh-HK')).toBe('Hant');
    expect(scriptOfLang('zh-TW')).toBe('Hant');
    expect(scriptOfLang('zh-Hans')).toBe('Hans');
    expect(scriptOfLang('zh-CN')).toBe('Hans');
    expect(scriptOfLang('nb')).toBe('Latn');
    expect(scriptOfLang('sr-Latn')).toBe('Latn');
    expect(scriptOfLang('xx')).toBeUndefined();
    expect(localeFromTag('sr-Latn')).toBeUndefined();
    expect(localeFromTag('nb')).toBe('no');
    expect(localeFromTag('zh-HK')).toBe('zh_TW');
    expect(htmlLang('zh_CN')).toBe('zh-CN');
    expect(sampleDir('Arab')).toBe('auto');
    expect(sampleDir('Hebr')).toBe('auto');
    expect(sampleDir('Latn')).toBeUndefined();
    for (const name of PROTOTYPE_NAMES) {
      expect(scriptOfLang(name), name).toBeUndefined();
      expect(localeFromTag(name), name).toBeUndefined();
    }
  });
});

describe('sampleForFamily', () => {
  const subsetNames = [
    'latin',
    'latin-ext',
    'cyrillic',
    'arabic',
    'japanese',
    'chinese-simplified',
    'chinese-traditional',
    'chinese-hongkong',
    'devanagari',
    'vietnamese',
  ];
  const bit = (name: string) => 1 << subsetNames.indexOf(name);
  const chosen = chooseSample({ uiLang: 'ru' });

  it('falls back when the family lacks the sample subset', () => {
    const outfit = sampleForFamily(
      chosen,
      { script: '', subsets: bit('latin') | bit('latin-ext') },
      subsetNames,
      null,
      'ru',
    );
    expect(outfit.locale).toBe('en');
    expect(outfit.script).toBe('Latn');
    expect(outfit.text).toBe(`${sampleOf('en')?.text ?? ''}\n${DIGITS}`);
    const roboto = sampleForFamily(
      chosen,
      { script: '', subsets: bit('latin') | bit('cyrillic') },
      subsetNames,
    );
    expect(roboto.locale).toBe('ru');
    expect(roboto.text).toBe(`${sampleOf('ru')?.text ?? ''}\n${DIGITS}`);
    const unknown = sampleForFamily(chosen, { script: '', subsets: -1 }, subsetNames);
    expect(unknown.text).toContain(sampleOf('ru')?.text ?? '');
  });

  it('does not substitute real text', () => {
    const real = chooseSample({ typed: 'Съешь' });
    const out = sampleForFamily(real, { script: '', subsets: bit('latin') }, subsetNames);
    expect(out.text).toBe('Съешь');
  });

  it('uses English when a latin-only face cannot draw a latin-ext UI sample', () => {
    const cs = chooseSample({ uiLang: 'cs' });
    const out = sampleForFamily(cs, { script: '', subsets: bit('latin') }, subsetNames, null, 'cs');
    expect(out.locale).toBe('en');
    expect(out.text.startsWith(sampleOf('en')?.text ?? 'missing')).toBe(true);
  });

  it('keeps a Latin-1 page language on a face that only has latin', () => {
    const de = chooseSample({ lang: 'de', uiLang: 'en' });
    const out = sampleForFamily(de, { script: '', subsets: bit('latin') }, subsetNames, 'de', 'en');
    expect(out.locale).toBe('de');
  });

  it('shows the Japanese sample for a Hiragana family that covers japanese', () => {
    const out = sampleForFamily(
      chosen,
      { script: 'Hira', subsets: bit('japanese') | bit('latin') },
      subsetNames,
    );
    expect(out.locale).toBe('ja');
    expect(out.text.startsWith(sampleOf('ja')?.text ?? 'missing')).toBe(true);
  });

  it('keeps Traditional Chinese when the face only lists chinese-hongkong', () => {
    const tw = chooseSample({ lang: 'zh-TW', uiLang: 'en' });
    const out = sampleForFamily(
      tw,
      { script: 'Hant', subsets: bit('chinese-hongkong') },
      subsetNames,
      'zh-TW',
      'en',
    );
    expect(out.locale).toBe('zh_TW');
  });

  it('falls back to English when an Arabic primary script has no arabic subset', () => {
    const ar = chooseSample({
      topScripts: ['Arab', 'Arab', 'Arab', 'Arab', ''],
      uiLang: 'en',
    });
    const out = sampleForFamily(
      ar,
      { script: 'Arab', subsets: bit('latin') },
      subsetNames,
      null,
      'en',
    );
    expect(out.locale).toBe('en');
  });

  it('keeps unknown metadata and the default sample of the family script', () => {
    expect(familyHasSubset(UNKNOWN_SUBSETS, subsetNames, 'latin')).toBe(false);
    expect(familyHasSubset(UNKNOWN_SUBSETS, subsetNames, 'cyrillic')).toBe(false);
    const unknown = sampleForFamily(chosen, { script: '', subsets: UNKNOWN_SUBSETS }, subsetNames);
    expect(unknown.text).toBe(`${sampleOf('ru')?.text ?? ''}\n${DIGITS}`);
    const deva = sampleForFamily(
      chosen,
      { script: 'Deva', subsets: bit('devanagari') },
      subsetNames,
      'mr',
      'en',
    );
    expect(deva.locale).toBe('hi');
    const viet = chooseSample({ uiLang: 'vi' });
    expect(sampleForFamily(viet, { script: '', subsets: bit('latin') }, subsetNames).locale).toBe(
      'en',
    );
    expect(
      sampleForFamily(viet, { script: '', subsets: bit('vietnamese') }, subsetNames).locale,
    ).toBe('vi');
    const tw = chooseSample({ uiLang: 'zh-TW' });
    expect(
      sampleForFamily(tw, { script: 'Hans', subsets: bit('chinese-simplified') }, subsetNames)
        .locale,
    ).toBe('zh_CN');
    for (const name of PROTOTYPE_NAMES) expect(subsetBit(subsetNames, name), name).toBeUndefined();
    expect(() =>
      sampleForFamily(chosen, { script: 'constructor', subsets: bit('latin') }, subsetNames),
    ).not.toThrow();
  });
});

describe('requiredSubset', () => {
  it('maps each sample to the Google Fonts subset that can draw it', () => {
    expect(requiredSubset('en', 'Latn')).toBe('latin');
    expect(requiredSubset('de', 'Latn')).toBe('latin');
    expect(requiredSubset('fr', 'Latn')).toBe('latin');
    expect(requiredSubset('es', 'Latn')).toBe('latin');
    expect(requiredSubset('ca', 'Latn')).toBe('latin');
    expect(requiredSubset('cs', 'Latn')).toBe('latin-ext');
    expect(requiredSubset('pl', 'Latn')).toBe('latin-ext');
    expect(requiredSubset('hr', 'Latn')).toBe('latin-ext');
    expect(requiredSubset('vi', 'Latn')).toBe('vietnamese');
    expect(requiredSubset('ru', 'Cyrl')).toBe('cyrillic');
    expect(requiredSubset('el', 'Grek')).toBe('greek');
    expect(requiredSubset('ja', 'Jpan')).toBe('japanese');
    expect(requiredSubset('zh_CN', 'Hans')).toBe('chinese-simplified');
    expect(requiredSubset('zh_TW', 'Hant')).toBe('chinese-traditional');
  });
});
