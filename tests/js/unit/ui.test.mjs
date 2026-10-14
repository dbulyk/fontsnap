import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../../scripts/lib/evaljs.mjs';
import { genericFamily, cssFontFamily, previewText, timingText, DEFAULT_PREVIEW } from '../../../extension/lib/ui.js';

const EXT = path.join(ROOT, 'extension');

test('CSS generic fallback follows the Google Fonts category', () => {
  assert.equal(genericFamily('Serif'), 'serif');
  assert.equal(genericFamily('Sans Serif'), 'sans-serif');
  assert.equal(genericFamily('Monospace'), 'monospace');
  assert.equal(genericFamily('Handwriting'), 'cursive');
  assert.equal(genericFamily('Display'), 'cursive');
  assert.equal(genericFamily(''), 'sans-serif');
  assert.equal(cssFontFamily('Lobster', 'Display'), "font-family: 'Lobster', cursive;");
  assert.equal(cssFontFamily('Roboto Mono', 'Monospace'), "font-family: 'Roboto Mono', monospace;");
});

test('preview text: typed > selected > pangram', () => {
  assert.equal(previewText('  Hello ', 'page text'), 'Hello');
  assert.equal(previewText('', '  Big\n  Title '), 'Big Title');
  assert.equal(previewText('', ''), DEFAULT_PREVIEW);
  assert.equal(previewText(undefined, 'x'.repeat(200)).length, 80);
});

test('timing text includes model load on the first run', () => {
  assert.equal(timingText(412.4, 0), 'Done in 412 ms');
  assert.equal(timingText(400, 1500.2), 'Done in 1900 ms (model load 1500 ms + analysis 400 ms)');
});

test('manifest: CWS limits, no author/key/fingerprint, both context menu items', () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json')));
  assert.equal(m.manifest_version, 3);
  assert.ok(m.name.length <= 75 && m.description.length <= 132, 'name<=75, description<=132');
  for (const k of ['author', 'key', 'fingerprint']) assert.ok(!(k in m), k);
  const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
  assert.match(bg, /id: 'fontsnap-image'[\s\S]*contexts: \['image'\]/);
  assert.doesNotMatch(bg.match(/id: 'fontsnap-select'[\s\S]*?\]/)[0], /'image'/);
});

test('meta.json: Google Fonts flags are consistent', () => {
  const m = JSON.parse(fs.readFileSync(path.join(EXT, 'model', 'meta.json')));
  const at = (f) => m.fams.indexOf(f);
  for (const f of ['pushster', 'thabit', 'bigshouldersdisplay', 'sansitaone', 'lobster'])
    assert.ok(m.inGF[at(f)], `${f} is on Google Fonts`);
  assert.equal(m.display[at('pushster')], 'Pushster');
  assert.equal(m.inGF[at('adobeblank')], false);
  m.inGF.forEach((g, i) => g && assert.ok(m.category[i], `${m.fams[i]} has a category`));
});
