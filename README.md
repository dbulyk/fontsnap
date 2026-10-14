# FontSnap: AI Font Identifier from Image

Chrome extension (Manifest V3) that identifies the Google Font in a selected screen region or an uploaded screenshot.
Inference runs fully on-device with onnxruntime-web (WASM); images never leave the browser.

Model: EfficientNet-B3 fine-tuned from [storia/font-classify-onnx](https://huggingface.co/storia/font-classify-onnx) (MIT),
3665 classes → 1845 families. realset3 (263 held-out real screenshots): **59.3% top-1 / 77.9% top-5** family-level ("best" pipeline).

## Layout
| Path | Contents |
|---|---|
| `extension/` | MV3 extension: `background.js` (capture + crop), `select.js` (region overlay), `result.*` (UI), `lib/fontsnap-core.js` (textcrop, preprocessing, family aggregation, popularity prior, family merge), `model/` (ONNX via LFS + `meta.json`) |
| `python/fontsnap_ref/` | Python reference pipeline (`textcrop`, `pipeline`, `evaluate`, `build_meta`) and `python/data/` (classes, family mapping v2b, Google Fonts metadata) |
| `scripts/` | `fetch-ort.mjs` (copies pinned onnxruntime-web into `extension/ort/`), `eval-js.mjs`, `build-zip.mjs`, `chrome-smoke.mjs` |
| `tests/` | `js/unit` (node:test), `js/regression` (realset3 + parity), `python` (pytest), `fixtures`, `thresholds.json` |
| `data/realset3/` | 263 labelled screenshots (`images/` via LFS, `labels.csv`) + collection scripts |

## Setup
Requires git-lfs, Node 20+, Python 3.10+.
```
git lfs install && git lfs pull
npm ci                                 # also copies onnxruntime-web 1.30.0 into extension/ort/
python -m venv .venv && . .venv/bin/activate && pip install -r python/requirements.txt
```

## Load unpacked
chrome://extensions → Developer mode → **Load unpacked** → select `extension/` (after `npm ci`, so `extension/ort/` exists).
Click the toolbar icon (or Alt+Shift+F, or right-click → "FontSnap: identify font in a region") and drag over text.
On chrome:// pages the result tab opens in upload mode (paste / drop / choose an image).
`npm run build` → `dist/fontsnap-extension-<version>.zip` for the Chrome Web Store.

## Tests
```
npm run lint && npm run format:check           # ESLint + Prettier
ruff check . && ruff format --check python tests
npm run test:unit                              # fontsnap-core.js unit tests (incl. parity fixtures from cv2)
python -m pytest -q                            # Python reference
(cd python && python -m fontsnap_ref.evaluate) # -> out/py_realset3.json
npm run test:regression                        # JS on realset3 (thresholds) + JS-vs-Python parity, ~2 min
node scripts/eval-js.mjs --backend web         # same with onnxruntime-web WASM (slower, single thread)
node scripts/chrome-smoke.mjs 263              # optional: real extension in headless Chromium (npx playwright install chromium)
```
Thresholds: `tests/thresholds.json` (best ≥ 59.0/77.5, bare ≥ 45.0/69.0, parity top-1 agreement ≥ 99%), overridable with
`FONTSNAP_MIN_BEST_TOP1`, `FONTSNAP_MIN_BEST_TOP5`, `FONTSNAP_MIN_BARE_TOP1`, `FONTSNAP_MIN_BARE_TOP5`, `FONTSNAP_MIN_PARITY`; `FONTSNAP_BACKEND=web` runs the regression on onnxruntime-web.
After changing the Python textcrop, regenerate fixtures: `cd python && python ../tests/make_fixtures.py`.

## CI
`.github/workflows/ci.yml` on push/PR: LFS checkout (cached), lint/format, unit tests (JS + Python), Python eval, regression + parity, zip artifact.
Thresholds can be overridden with repository variables of the same names.

## Licenses / provenance
Base model storia/font-classify-onnx (MIT); onnxruntime-web (MIT, fetched from npm). All code is our own; no code from
jdiputadoevotech/font-classify (unlicensed) is included. Font previews load from Google Fonts (font names only).
