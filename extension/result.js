import * as ort from './ort/ort.wasm.min.mjs';
import { fromRGBA, textLines, cropNormalize, prep, softmax, makeRanker } from './lib/fontsnap-core.js';
import { t, applyI18n } from './lib/i18n.js';
import { genericFamily, cssFontFamily, previewText, visibleResults } from './lib/ui.js';
import { parseResultHash } from './lib/capture.js';
applyI18n();
const $ = (id) => document.getElementById(id),
  status = (t, err) => {
    $('status').textContent = t;
    $('status').className = 'status' + (err ? ' err' : '');
  };
ort.env.wasm.wasmPaths = chrome.runtime.getURL('ort/');
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
let session,
  ranker,
  lastImg,
  runId = 0;
const MAX_SIDE = 2400; // very large uploads are downscaled first (textcrop cost grows with kernel x pixels)
const ready = (async () => {
  const meta = await (await fetch('model/meta.json')).json();
  ranker = makeRanker(meta);
  session = await ort.InferenceSession.create(chrome.runtime.getURL('model/model_fp16.onnx'), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
})();
function drawGray(cv, im) {
  cv.width = im.w;
  cv.height = im.h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const id = ctx.createImageData(im.w, im.h);
  for (let i = 0; i < im.w * im.h; i++) {
    const v = im.c === 1 ? [im.data[i], im.data[i], im.data[i]] : im.data.subarray(i * 3, i * 3 + 3);
    id.data.set([v[0], v[1], v[2], 255], i * 4);
  }
  ctx.putImageData(id, 0, 0);
}
async function identify(canvas) {
  $('shot').style.display = 'block';
  $('dropHint').style.display = 'none';
  const my = ++runId;
  status(t('analyzing'));
  await ready;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }),
    d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const img = fromRGBA(d.data, canvas.width, canvas.height),
    pre = textLines(img),
    probs = [];
  for (const v of ['pack', 'crop']) {
    const c = cropNormalize(img, v, 96, 6, pre);
    if (v === 'pack') drawGray($('seen'), c);
    const out = await session.run({ input: new ort.Tensor('float32', prep(c), [1, 3, 320, 320]) });
    probs.push(softmax(out.logits.data));
  }
  if (my !== runId) return; // a newer image superseded this run
  lastImg = ranker.rank(probs, { alpha: 0.5, merge: true, k: 5 });
  render(lastImg);
  status(pre.lines.length ? '' : t('noLines'), !pre.lines.length);
}
const loaded = new Set();
function loadFont(name) {
  const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}&display=swap`;
  if (loaded.has(href)) return;
  loaded.add(href);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}
function render(all) {
  const list = visibleResults(all);
  const text = previewText($('pvText').value, ''),
    ol = $('results');
  ol.innerHTML = '';
  list.forEach((r, i) => {
    if (r.inGF) loadFont(r.name);
    const li = document.createElement('li'),
      gf = `https://fonts.google.com/specimen/${encodeURIComponent(r.name).replace(/%20/g, '+')}`;
    li.innerHTML = `<div class="row"><span class="name">${i + 1}. </span><span class="meta"></span></div><div class="bar"><i></i></div><div class="sample"></div><div class="row"><span class="meta"></span><span class="acts"></span></div>`;
    li.querySelector('.name').append(r.name);
    li.querySelectorAll('.meta')[0].textContent = `${Math.round(r.conf * 100)}%`;
    li.querySelectorAll('.meta')[0].title = t('scoreTitle');
    li.querySelector('.bar i').style.width = `${Math.max(2, r.conf * 100)}%`;
    const s = li.querySelector('.sample');
    s.textContent = text;
    s.style.fontFamily = `'${r.name}', ${genericFamily(r.category)}`;
    li.querySelectorAll('.meta')[1].textContent = r.category || (r.inGF ? '' : t('notOnGF'));
    const acts = li.querySelector('.acts'),
      cp = document.createElement('button');
    cp.textContent = t('copyCss');
    cp.onclick = () =>
      navigator.clipboard.writeText(cssFontFamily(r.name, r.category)).then(() => {
        cp.textContent = t('copied');
        setTimeout(() => (cp.textContent = t('copyCss')), 1200);
      });
    acts.append(cp);
    if (r.inGF) {
      const a = document.createElement('a');
      a.href = gf;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Google Fonts ↗';
      acts.append(a);
    }
    ol.append(li);
  });
}
$('pvText').addEventListener('input', () => lastImg && render(lastImg));
async function fromBlob(blob) {
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return status(t('readFail'), true);
  }
  const sc = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height)),
    cv = $('shot');
  cv.width = Math.round(bmp.width * sc);
  cv.height = Math.round(bmp.height * sc);
  cv.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close();
  identify(cv).catch((e) => status(t('errorMsg', [e.message]), true));
}
$('file').addEventListener('change', (e) => e.target.files[0] && fromBlob(e.target.files[0]));
document.addEventListener('paste', (e) => {
  const it = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'));
  if (it) fromBlob(it.getAsFile());
});
const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
  if (f) fromBlob(f);
});
(async () => {
  try {
    await ready;
    status(t('ready'));
  } catch (e) {
    status(t('modelFail', [e.message]), true);
    return;
  }
  const handoff = parseResultHash(location.hash);
  if (!handoff) return;
  if (handoff.kind === 'error') return status(t('captureFail', [handoff.message]), true);
  const st = (await chrome.storage.session.get(handoff.id))[handoff.id];
  if (!st) return;
  chrome.storage.session.remove(handoff.id);
  if (st.error) return status(t('captureFail', [st.error]), true);
  if (st.text) $('pvText').value = st.text;
  fromBlob(await (await fetch(st.dataUrl)).blob());
})();
