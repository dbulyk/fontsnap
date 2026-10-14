import * as ort from './ort/ort.wasm.min.mjs';
import { fromRGBA, textLines, cropNormalize, prep, softmax, makeRanker } from './lib/fontsnap-core.js';
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
  const id = cv.getContext('2d').createImageData(im.w, im.h);
  for (let i = 0; i < im.w * im.h; i++) {
    const v = im.c === 1 ? [im.data[i], im.data[i], im.data[i]] : im.data.subarray(i * 3, i * 3 + 3);
    id.data.set([v[0], v[1], v[2], 255], i * 4);
  }
  cv.getContext('2d').putImageData(id, 0, 0);
}
async function identify(canvas) {
  $('shot').style.display = 'block';
  $('dropHint').style.display = 'none';
  const my = ++runId;
  status('Analyzing…');
  await ready;
  const t0 = performance.now();
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
  status(
    pre.lines.length
      ? `Done in ${Math.round(performance.now() - t0)} ms`
      : 'No clear text lines found — result may be unreliable. Try a tighter selection.',
    !pre.lines.length,
  );
}
const GENERIC = { Serif: 'serif', 'Sans Serif': 'sans-serif', Monospace: 'monospace', Handwriting: 'cursive', Display: 'sans-serif' };
const genericFamily = (cat) => GENERIC[cat] || 'sans-serif';
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
function render(list) {
  const text = $('pvText').value || 'The quick brown fox',
    ol = $('results');
  ol.innerHTML = '';
  list.forEach((r, i) => {
    if (r.inGF) loadFont(r.name);
    const li = document.createElement('li'),
      gf = `https://fonts.google.com/specimen/${encodeURIComponent(r.name).replace(/%20/g, '+')}`;
    li.innerHTML = `<div class="row"><span class="name">${i + 1}. </span><span class="meta"></span></div><div class="bar"><i></i></div><div class="sample"></div><div class="row"><span class="meta"></span><span class="acts"></span></div>`;
    li.querySelector('.name').append(r.name);
    li.querySelectorAll('.meta')[0].textContent = `${Math.round(r.conf * 100)}%`;
    li.querySelectorAll('.meta')[0].title = 'Relative score among the top 5';
    li.querySelector('.bar i').style.width = `${Math.max(2, r.conf * 100)}%`;
    const s = li.querySelector('.sample');
    s.textContent = text;
    s.style.fontFamily = `'${r.name}', sans-serif`;
    li.querySelectorAll('.meta')[1].textContent = r.category || (r.inGF ? '' : 'not on Google Fonts');
    const acts = li.querySelector('.acts'),
      cp = document.createElement('button');
    cp.textContent = 'Copy CSS';
    cp.onclick = () =>
      navigator.clipboard.writeText(`font-family: '${r.name}', ${genericFamily(r.category)};`).then(() => {
        cp.textContent = 'Copied';
        setTimeout(() => (cp.textContent = 'Copy CSS'), 1200);
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
    return status('Could not read this image.', true);
  }
  const sc = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height)),
    cv = $('shot');
  cv.width = Math.round(bmp.width * sc);
  cv.height = Math.round(bmp.height * sc);
  cv.getContext('2d', { willReadFrequently: true }).drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close();
  identify(cv).catch((e) => status('Error: ' + e.message, true));
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
    status('Ready. Paste, drop or choose an image.');
  } catch (e) {
    status('Model failed to load: ' + e.message, true);
    return;
  }
  const id = location.hash.slice(1);
  if (!id) return;
  const st = (await chrome.storage.session.get(id))[id];
  if (!st) return;
  chrome.storage.session.remove(id);
  if (st.error) return status('Capture failed: ' + st.error + ' — try again or paste a screenshot.', true);
  if (st.text) $('pvText').value = st.text;
  fromBlob(await (await fetch(st.dataUrl)).blob());
})();
