import { parseResultHash, type CaptureEntry } from '../shared/capture';
import { fromRGBA, type Img } from '../shared/core/image';
import { cropNormalize } from '../shared/core/pipeline';
import type { RankedFont } from '../shared/core/ranker';
import { textLines } from '../shared/core/textcrop';
import { dataUrlToBlob } from '../shared/data-url';
import { required } from '../shared/dom';
import { errorMessage } from '../shared/errors';
import {
  MAX_PREVIEW_GRAPHEMES,
  graphemeCount,
  fieldFromCapture,
  sliceGraphemes,
} from '../shared/graphemes';
import { applyI18n, t } from '../shared/i18n';
import { insertionFits, isInsertInputType } from '../shared/preview-limit';
import { loadModel } from './model';
import { createRenderer, type PreviewContext } from './render';

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
  const resultsPanel = $('resultsPanel');
  const loader = $('loader');
  const pvLimit = $('pvLimit');
  const pvLimitBar = required(doc.querySelector<HTMLElement>('#pvLimitBar i'), '#pvLimitBar i');
  const pvLimitTrack = $('pvLimitBar');
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
  let subsetNames: string[] = [];
  let captureLang: string | undefined;
  let captureHint: string | undefined;
  const uiLang = chrome.i18n.getUILanguage();
  const ready = loadModel();

  function previewCtx(): PreviewContext {
    return {
      typed: preview.value,
      lang: captureLang,
      hint: captureHint,
      uiLang,
      subsetNames,
    };
  }

  function updateLimit(): void {
    const used = graphemeCount(preview.value);
    pvLimit.textContent = t('previewLimit', [String(used), String(MAX_PREVIEW_GRAPHEMES)]);
    const ratio = Math.min(1, used / MAX_PREVIEW_GRAPHEMES);
    pvLimitBar.style.width = `${String(Math.round(ratio * 100))}%`;
    const state =
      used >= MAX_PREVIEW_GRAPHEMES ? 'limit' : used >= MAX_PREVIEW_GRAPHEMES * 0.9 ? 'warn' : '';
    pvLimit.className = 'pv-limit' + (state ? ` ${state}` : '');
    pvLimitTrack.className = 'pv-limit-bar' + (state ? ` ${state}` : '');
  }

  function setBusy(busy: boolean): void {
    resultsPanel.setAttribute('aria-busy', busy ? 'true' : 'false');
    loader.hidden = !busy;
    if (busy) doc.getElementById('results')?.replaceChildren();
  }

  function paint(): void {
    if (lastImg) render(lastImg, previewCtx());
  }

  async function identify(canvas: HTMLCanvasElement): Promise<void> {
    shot.style.display = 'block';
    $('dropHint').style.display = 'none';
    const my = ++runId;
    status(t('analyzing'));
    setBusy(true);
    try {
      const model = await ready;
      subsetNames = model.subsetNames;
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
      paint();
      status(pre.lines.length ? '' : t('noLines'), !pre.lines.length);
    } finally {
      if (my === runId) setBusy(false);
    }
  }

  // Snapshot at compositionstart: if the commit would exceed the limit, compositionend restores it.
  let compositionSnapshot: { value: string; start: number; end: number } | null = null;

  // Reject inserts that would exceed the limit before they land (mid-string typing, paste, drop).
  // During IME composition leave the draft alone; compositionend restores the snapshot if over.
  preview.addEventListener('beforeinput', (e) => {
    if (e.isComposing) return;
    if (!isInsertInputType(e.inputType)) return;
    const data = e.data ?? '';
    // insertFromPaste often carries the text in data; when it does not, the paste handler clips.
    if (data === '') return;
    const start = preview.selectionStart ?? preview.value.length;
    const end = preview.selectionEnd ?? start;
    if (!insertionFits(preview.value, start, end, data)) e.preventDefault();
  });

  preview.addEventListener('compositionstart', () => {
    compositionSnapshot = {
      value: preview.value,
      start: preview.selectionStart ?? 0,
      end: preview.selectionEnd ?? 0,
    };
  });

  preview.addEventListener('compositionend', () => {
    if (graphemeCount(preview.value) <= MAX_PREVIEW_GRAPHEMES) {
      compositionSnapshot = null;
      updateLimit();
      paint();
      return;
    }
    // Over the limit: roll back the whole commit, do not slice the tail.
    if (compositionSnapshot) {
      preview.value = compositionSnapshot.value;
      preview.setSelectionRange(compositionSnapshot.start, compositionSnapshot.end);
    }
    compositionSnapshot = null;
    updateLimit();
    paint();
  });

  preview.addEventListener('paste', (e) => {
    const pasted = e.clipboardData?.getData('text') ?? '';
    if (!pasted) return;
    e.preventDefault();
    const start = preview.selectionStart ?? preview.value.length;
    const end = preview.selectionEnd ?? start;
    const room =
      MAX_PREVIEW_GRAPHEMES -
      graphemeCount(preview.value.slice(0, start) + preview.value.slice(end));
    const clipped = room > 0 ? sliceGraphemes(pasted, room) : '';
    preview.setRangeText(clipped, start, end, 'end');
    updateLimit();
    paint();
  });

  preview.addEventListener('input', (e) => {
    // Never trim during IME composition (would restart the session and eat the tail).
    if (e.isComposing) {
      updateLimit();
      paint();
      return;
    }
    if (graphemeCount(preview.value) > MAX_PREVIEW_GRAPHEMES) {
      // CDP insertText / some IMEs commit without compositionend: restore the snapshot
      // instead of slicing the tail (which eats mid-string commits at the limit).
      if (compositionSnapshot) {
        preview.value = compositionSnapshot.value;
        preview.setSelectionRange(compositionSnapshot.start, compositionSnapshot.end);
        compositionSnapshot = null;
      } else {
        const start = preview.selectionStart ?? MAX_PREVIEW_GRAPHEMES;
        preview.value = sliceGraphemes(preview.value, MAX_PREVIEW_GRAPHEMES);
        const caret = Math.min(start, preview.value.length);
        preview.setSelectionRange(caret, caret);
      }
    }
    updateLimit();
    paint();
  });

  async function fromBlob(blob: Blob, keepHints = false): Promise<void> {
    // the hint belongs to the capture the service worker handed over; it goes when the user brings an image of their own
    $('wholeNote').hidden = true;
    if (!keepHints) {
      captureLang = undefined;
      captureHint = undefined;
    }
    let bmp: ImageBitmap;
    try {
      bmp = await createImageBitmap(blob);
    } catch {
      status(t('readFail'), true);
      setBusy(false);
      return;
    }
    const sc = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const cv = shot;
    cv.width = Math.round(bmp.width * sc);
    cv.height = Math.round(bmp.height * sc);
    cv.getContext('2d', { willReadFrequently: true })?.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close();
    identify(cv).catch((e: unknown) => {
      setBusy(false);
      status(t('errorMsg', [errorMessage(e)]), true);
    });
  }

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void fromBlob(file);
  });
  doc.addEventListener('paste', (e) => {
    // Image-only paste must work even when the preview field is focused.
    // Excel/Word often put text/plain + image/* together: with focus in the field, paste text
    // only (field handler) and do not start a new analysis that would clear lang/hint.
    if (doc.activeElement === preview) {
      const text = e.clipboardData?.getData('text') ?? '';
      const types = e.clipboardData?.types;
      const hasText =
        text !== '' ||
        (types !== undefined && [...types].some((t) => t === 'text/plain' || t === 'text'));
      if (hasText) return;
    }
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    e.preventDefault();
    void fromBlob(file);
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

  updateLimit();

  void (async () => {
    try {
      const model = await ready;
      subsetNames = model.subsetNames;
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
    // One post-capture gate: long captured text empties the field so cards use the automatic sample.
    preview.value = fieldFromCapture(stored.text);
    captureLang = stored.lang;
    captureHint = stored.hint;
    updateLimit();
    if (stored.dataUrl) await fromBlob(dataUrlToBlob(stored.dataUrl), true);
    $('wholeNote').hidden = stored.note !== 'whole-view';
  })();
}
