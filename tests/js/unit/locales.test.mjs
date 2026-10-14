import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../../scripts/lib/evaljs.mjs';

const EXT = path.join(ROOT, 'extension');
const LOC = path.join(EXT, '_locales');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const langs = fs.readdirSync(LOC).sort();
const read = (l) => JSON.parse(fs.readFileSync(path.join(LOC, l, 'messages.json'), 'utf8'));
const en = read('en');
const enKeys = Object.keys(en).sort();
// Chrome Web Store locale codes (https://developer.chrome.com/docs/extensions/reference/api/i18n#locales)
const CWS =
  'ar am bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr gu he hi hr hu id it ja kn ko lt lv ml mr ms nl no pl pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr uk vi zh_CN zh_TW'.split(
    ' ',
  );

test('manifest uses default_locale en and __MSG__ name/description', () => {
  assert.equal(manifest.default_locale, 'en');
  assert.equal(manifest.name, '__MSG_appName__');
  assert.equal(manifest.description, '__MSG_appDesc__');
});

test('every Chrome Web Store locale is present and nothing else', () => {
  assert.deepEqual(langs, [...CWS].sort());
});

for (const l of langs) {
  test(`locale ${l}: same keys as en, placeholders consistent, store limits`, () => {
    const m = read(l);
    assert.deepEqual(Object.keys(m).sort(), enKeys, `${l} keys differ from en`);
    for (const k of enKeys) {
      const msg = m[k].message;
      assert.ok(typeof msg === 'string' && msg.trim(), `${l}.${k} empty`);
      assert.deepEqual(m[k].placeholders || {}, en[k].placeholders || {}, `${l}.${k} placeholders`);
      const used = new Set([...msg.matchAll(/\$([A-Za-z_]+)\$/g)].map((x) => x[1].toLowerCase()));
      assert.deepEqual([...used].sort(), Object.keys(en[k].placeholders || {}).sort(), `${l}.${k} uses placeholders`);
    }
    assert.ok([...m.appName.message].length <= 75, `${l} name > 75`);
    assert.ok([...m.appDesc.message].length <= 132, `${l} description > 132`);
    assert.ok(m.appName.message.includes('FontSnap'), `${l} name must keep the brand`);
  });
}

test('every i18n key referenced in code/HTML exists in en', () => {
  const src = ['background.js', 'result.js', 'select.js', 'welcome.js', 'result.html', 'welcome.html']
    .map((f) => fs.readFileSync(path.join(EXT, f), 'utf8'))
    .join('\n');
  const keys = new Set([
    ...[...src.matchAll(/data-i18n(?:-ph|-title)?="([^"]+)"/g)].map((x) => x[1]),
    ...[...src.matchAll(/\bt\('([A-Za-z]+)'/g)].map((x) => x[1]),
    ...[...src.matchAll(/getMessage\('([A-Za-z]+)'/g)].map((x) => x[1]),
    ...[...JSON.stringify(manifest).matchAll(/__MSG_([A-Za-z]+)__/g)].map((x) => x[1]),
  ]);
  assert.ok(keys.size > 20);
  for (const k of keys) assert.ok(en[k], `missing en key ${k}`);
});
