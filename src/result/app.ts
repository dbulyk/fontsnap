import { parseResultHash, type CaptureEntry } from '../shared/capture';
import { fromRGBA, type Img } from '../shared/core/image';
import { cropNormalize } from '../shared/core/pipeline';
import type { RankedFont } from '../shared/core/ranker';
import { textLines } from '../shared/core/textcrop';
import { dataUrlToBlob } from '../shared/data-url';
import { required } from '../shared/dom';
import { errorMessage } from '../shared/errors';
import { applyI18n, t } from '../shared/i18n';
import { loadModel } from './model';
import { createRenderer } from './render';

/** Very large uploads are downscaled first (textcrop cost grows with kernel x pixels). */
const MAX_SIDE = 2400;

function drawGray(cv: HTMLCanvasElement, im: Img): void {
  cv.width = im.w;
  cv.height = im.h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  const id = ctx.createImageData(im.w, im.h);
  for (let i = 0; i < im.w * im.h; i++) {
    const v =
      im.c === 1
        ? [im.data[i], im.data[i], im.data[i]]
        : [im.data[i * 3], im.data[i * 3 + 1], im.data[i * 3 + 2]];
    id.data.set([v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, 255], i * 4);
  }
  ctx.putImageData(id, 0, 0);
}

function isEntry(value: unknown): value is CaptureEntry {
  return typeof value === 'object' && value !== null;
}

/** The result page: upload / paste / drop an image, or open with a capture handed over by the service worker. */
export function initResult(doc: Document): void {
  applyI18n(doc);
  const win = doc.defaultView;
  if (!win) return;
  const $ = (id: string): HTMLElement => {
    const element = doc.getElementById(id);
    if (!element) throw new Error(`The page has no #${id}`);
    return element;
  };
  const shot = required(doc.querySelector<HTMLCanvasElement>('#shot'), '#shot');
  const seen = required(doc.querySelector<HTMLCanvasElement>('#seen'), '#seen');
  const preview = required(doc.querySelector<HTMLInputElement>('#pvText'), '#pvText');
  const fileInput = required(doc.querySelector<HTMLInputElement>('#file'), '#file');
  const show = (text: string, err?: boolean) => {
    $('status').textContent = text;
    $('status').className = 'status' + (err ? ' err' : '');
  };
  // Whether an image has been dealt with (analysing, an error, a result): then the model getting ready must not put
  // "Ready." over it - an unreadable file chosen while the model loaded used to lose its error half a second later.
  const flow = { touched: false };
  const status = (text: string, err?: boolean) => {
    flow.touched = true;
    show(text, err);
  };
  const render = createRenderer(doc);
  let lastImg: RankedFont[] | undefined;
  let runId = 0;
  const ready = loadModel();

  async function identify(canvas: HTMLCanvasElement): Promise<void> {
    shot.style.display = 'block';
    $('dropHint').style.display = 'none';
    const my = ++runId;
    status(t('analyzing'));
    const model = await ready;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No 2D canvas');
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const img = fromRGBA(d.data, canvas.width, canvas.height);
    const pre = textLines(img);
    const probs: Float64Array[] = [];
    for (const v of ['pack', 'crop'] as const) {
      const c = cropNormalize(img, v, 96, 6, pre);
      if (v === 'pack') drawGray(seen, c);
      probs.push(await model.probs(c));
    }
    if (my !== runId) return; // a newer image superseded this run
    lastImg = model.ranker.rank(probs, { alpha: 0.5, merge: true, k: 5 });
    render(lastImg, preview.value);
    status(pre.lines.length ? '' : t('noLines'), !pre.lines.length);
  }

  preview.addEventListener('input', () => {
    if (lastImg) render(lastImg, preview.value);
  });

  async function fromBlob(blob: Blob): Promise<void> {
    // the hint belongs to the capture the service worker handed over; it goes when the user brings an image of their own
    $('wholeNote').hidden = true;
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      status(t('readFail'), true);
      return;
    }
    const sc = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const cv = shot;
    cv.width = Math.round(bmp.width * sc);
    cv.height = Math.round(bmp.height * sc);
    cv.getContext('2d', { willReadFrequently: true })?.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close();
    identify(cv).catch((e: unknown) => {
      status(t('errorMsg', [errorMessage(e)]), true);
    });
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void fromBlob(file);
  });
  doc.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (file) void fromBlob(file);
  });
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => {
    drop.classList.remove('over');
  });
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = [...(e.dataTransfer?.files ?? [])].find((file) => file.type.startsWith('image/'));
    if (f) void fromBlob(f);
  });

  void (async () => {
    try {
      await ready;
      if (!flow.touched) show(t('ready'));
    } catch (e) {
      show(t('modelFail', [errorMessage(e)]), true);
      return;
    }
    const handoff = parseResultHash(win.location.hash);
    if (!handoff) return;
    if (handoff.kind === 'error') {
      status(t('captureFail', [handoff.message]), true);
      return;
    }
    const stored: unknown = (await chrome.storage.session.get(handoff.id))[handoff.id];
    if (!stored) return;
    void chrome.storage.session.remove(handoff.id);
    if (!isEntry(stored)) return;
    if (stored.error) {
      status(t('captureFail', [stored.error]), true);
      return;
    }
    if (stored.text) preview.value = stored.text;
    if (stored.dataUrl) await fromBlob(dataUrlToBlob(stored.dataUrl));
    $('wholeNote').hidden = stored.note !== 'whole-view';
  })();
}
