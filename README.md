# FontSnap: AI Font Identifier from Image

Chrome extension (Manifest V3) that identifies the Google Font in a selected screen region or an uploaded screenshot.
Inference runs fully on-device with onnxruntime-web (WASM); images never leave the browser.

Model: EfficientNet-B3 fine-tuned from [storia/font-classify-onnx](https://huggingface.co/storia/font-classify-onnx) (MIT),
3665 classes → 1845 families. realset3 (263 held-out real screenshots): **59.3% top-1 / 77.9% top-5** family-level ("best" pipeline).

The repository is built on the toolchain of the internal chrome-extension-template: TypeScript strict, Vite (with terser for
the store build), typed ESLint, Prettier, Vitest with coverage thresholds, Playwright e2e and GitHub Actions. Quality is
enforced by code and automated checks, not by review alone; see "What the checks guarantee" and `AGENTS.md`.

## What is inside

- **Region selection.** Toolbar icon (or Alt+Shift+F, or the context menu "identify font in a region") injects a selection
  overlay (`src/select`), the service worker (`src/background`) takes a screenshot of the visible tab, crops it (OffscreenCanvas,
  PNG, or a JPEG quality ladder when the crop would not fit `chrome.storage.session`) and opens the result page.
- **Right-click on an image.** The image is downloaded by the service worker when the server allows it, otherwise the tab is
  screenshot and cropped to the image's box.
- **Result page** (`src/result`): paste, drop or choose an image (also the way in on `chrome://` pages), top-5 Google Fonts with
  a live preview, relative score (results below 1% are hidden), "copy CSS" with the category's generic fallback.
- **Welcome page** (`src/welcome`) opens once on install (not on updates) with the pin or usage instructions, depending on
  whether FontSnap is already on the toolbar; right-to-left for Arabic, Hebrew and Persian.
- **Recognition pipeline** (`src/shared/core`): text-line finder, cv2-compatible preprocessing, test-time augmentation (two
  crops), family aggregation, popularity prior `rank^-0.5`, near-duplicate family merge. `python/fontsnap_ref` is the reference.
- **Localization**: 55 Chrome Web Store locales in `public/_locales`, generated from `scripts/i18n/*.txt`.

## Layout

| Path                                   | Contents                                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/manifest.ts`                      | the manifest, generated into `dist/manifest.json` (the version comes from `package.json`)                                                                               |
| `src/shared/`                          | constants (`EXTENSION_PAGES`), i18n, typed messaging, `capture.ts` (crop → session handoff helpers), `ui.ts`, `core/` (the recognition pipeline); imports no other area |
| `src/background/`                      | service worker: toolbar and context menus, screenshot, crop, handoff                                                                                                    |
| `src/select/`                          | the selection overlay, injected on demand, built as `dist/select.js`                                                                                                    |
| `src/result/`, `src/welcome/`          | the two pages (markup and styles as before)                                                                                                                             |
| `public/`                              | `_locales/` (55 languages) and `icons/icon-<size>.png`, copied as is                                                                                                    |
| `model/`                               | `model_fp16.onnx` (Git LFS) and `meta.json`: copied into the build by the vendor plugin, byte for byte                                                                  |
| `scripts/`                             | build and check helpers (`lib/` is unit-tested), `eval/` (JS evaluation on realset3), `i18n/` (locale sources and `build-locales.py`)                                   |
| `python/fontsnap_ref/`, `python/data/` | Python reference pipeline (`textcrop`, `pipeline`, `evaluate`, `build_meta`) and its data (classes, family mapping v2b, Google Fonts metadata)                          |
| `data/realset3/`                       | 263 labelled screenshots (`images/` via Git LFS, `labels.csv`) and the collection scripts                                                                               |
| `tests/`                               | `unit` (Vitest), `e2e` (Playwright), `regression` (realset3 + parity), `python` (pytest), `fixtures`, `guard-snapshots`, `thresholds.json`                              |
| `store/`                               | Chrome Web Store listings, graphics and the privacy policy (not part of the build, never formatted)                                                                     |

## Setup

Requires git-lfs, Node 22.13 or newer (`.nvmrc`) and, for the Python reference, Python 3.10+.

```
git lfs install && git lfs pull        # model and test images
npm ci
npx playwright install chromium        # once (add --with-deps on a fresh Linux machine)
python -m venv .venv && . .venv/bin/activate && pip install -r python/requirements.txt
```

## Commands

| Command                                    | What it does                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `npm run build`                            | Production build into `dist/` (minified by terser), then `verify-dist`                    |
| `npm run zip`                              | Zip `dist/` into `release/fontsnap-extension-<version>.zip` (+ `.sha256`)                 |
| `npm run dev`                              | Build once, then rebuild `dist/` on changes (reload the extension)                        |
| `npm run lint` / `format` / `format:check` | ESLint (typed, strict) / Prettier write / Prettier check                                  |
| `npm run typecheck`                        | `tsc --noEmit` for `src/` and for tests, scripts and configs                              |
| `npm test`                                 | Vitest unit tests with coverage thresholds                                                |
| `npm run test:e2e`                         | Build `dist-e2e/` and run Playwright in a headed browser (needs a display)                |
| `npm run test:e2e:xvfb`                    | The same under a private virtual display; use this on machines and CI without one         |
| `npm run test:regression`                  | realset3 on the TypeScript pipeline (thresholds) and JS-vs-Python parity, about 2 minutes |
| `npm run eval:js`                          | The same evaluation as a script: `-- --backend node\|web --limit N --out file.json`       |
| `npm run check:locales` / `check:version`  | Locale consistency / `package.json` == manifest version                                   |
| `npm run check`                            | Lint, format, types, unit, locales, build, version, e2e; works without a display          |
| `npm run guards:update`                    | Regenerate `tests/guard-snapshots` after a deliberate change of a guard (read the diff)   |

Load the extension manually: `npm run build`, open `chrome://extensions`, enable Developer mode, **Load unpacked** and pick
`dist/`. Click the toolbar icon (or Alt+Shift+F, or right-click → "FontSnap: identify font in a region") and drag over text.
On `chrome://` pages the result tab opens in upload mode (paste, drop or choose an image).

`test:e2e:xvfb` starts Xvfb with `-noreset` on purpose: by default Xvfb resets after its last client exits and refuses
connections until it is back, so a test launching Chrome right as the previous one closes failed intermittently with
`Missing X server or $DISPLAY`. If you wrap e2e in your own `xvfb-run`, pass the same flag.

## Tests

```
npm run lint && npm run format:check && npm run typecheck && npm test        # TypeScript
ruff check . && ruff format --check python tests                             # Python lint
python -m pytest -q                                                          # Python reference
(cd python && python -m fontsnap_ref.evaluate)                               # → out/py_realset3.json
npm run test:regression                                                      # JS on realset3 (thresholds) + JS-vs-Python parity
npm run test:e2e:xvfb                                                        # the real, minified extension in Chromium
```

Thresholds: `tests/thresholds.json` (best ≥ 59.0/77.5, bare ≥ 45.0/69.0, parity top-1 agreement ≥ 99%), overridable with
`FONTSNAP_MIN_BEST_TOP1`, `FONTSNAP_MIN_BEST_TOP5`, `FONTSNAP_MIN_BARE_TOP1`, `FONTSNAP_MIN_BARE_TOP5`, `FONTSNAP_MIN_PARITY`;
`FONTSNAP_BACKEND=web` runs the regression on onnxruntime-web (WASM). After changing the Python textcrop, regenerate the
fixtures: `cd python && python ../tests/make_fixtures.py`.

`tests/e2e/identify.spec.ts` feeds the first 24 realset3 images to the result page of the minified extension and compares every
card (name and percent) with `tests/fixtures/chrome-top5.json`, a slice of the full 263-image run recorded before the move
to TypeScript and terser. The whole set can be compared the same way in a browser; any difference between the minified build and
the Python/Node pipelines shows up there.

## Exceptions to the template (WebAssembly, the model, the CSP)

The template forbids WebAssembly. FontSnap runs its model with onnxruntime-web, so it has a short, explicit list of exceptions;
each is declared once and held by tests that fail on any deviation.

| What                                                                                                                                            | Where it is declared                                     | What holds it                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ort/ort.wasm.min.mjs`, `ort/ort-wasm-simd-threaded.mjs`, `ort/ort-wasm-simd-threaded.wasm` of onnxruntime-web **1.30.0**, byte for byte        | `VENDOR_FILES` in `scripts/lib/vendor.ts` (sha256, size) | `vendor.test.ts`, `dist.test.ts`, the build (`vendorPlugin`), `verify-dist`                                                                                                                               |
| `model/model_fp16.onnx` and `model/meta.json`                                                                                                   | the same table                                           | the same                                                                                                                                                                                                  |
| CSP `extension_pages` is exactly `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` (string equality; no `unsafe-eval`, no extra source) | `EXTENSION_PAGES_CSP` in `src/manifest.ts`               | `manifest.test.ts`, `dist.test.ts` (ten variants), `verify-dist`, e2e `manifest.spec.ts`                                                                                                                  |
| `cross_origin_embedder_policy` credentialless, `cross_origin_opener_policy` same-origin (SharedArrayBuffer for multithreaded WASM)              | `src/manifest.ts`                                        | `manifest.test.ts`, `dist.test.ts`                                                                                                                                                                        |
| The one external import of the build, `onnxruntime-web/wasm` → `ort/ort.wasm.min.mjs`                                                           | `ORT_SPECIFIER`, `ORT_EXTERNAL` in `vendor.ts`           | `src-only.test.ts` (that id passes, eleven look-alikes are refused), `vite-configs.test.ts` (`vendorPlugin` answers only that specifier), `dist.test.ts` (the import must resolve to a file of the build) |

**The runtime cannot be pointed elsewhere.** onnxruntime-web has two settings that would run WebAssembly other than the
pinned files with every check above green: `env.wasm.wasmPaths` (another URL, another `.wasm`) and `env.wasm.wasmBinary`
(other bytes). Three layers close them: (1) ESLint refuses the identifiers `env`, `wasmPaths`, `wasmBinary` (also as strings,
templates, keys, destructured names) and any import of `onnxruntime-*` in every `src/` context except `src/result/model.ts`;
(2) `model.test.ts` pins that file, source included: `wasmPaths` is the one string `chrome.runtime.getURL('ort/')`, nothing else
is assigned to the environment, `wasmBinary` is never set, the model and the family table come from their packaged URLs;
(3) `verify-dist` scans every built `.js`/`.mjs` for the header of a module in any spelling (raw, escapes, base64, hex, number
lists, a `.wasm` name), for `wasmBinary`, and for `wasmPaths` anywhere but once, from a call, in `assets/result-*.js`; the vendor
files are exempt by exact path and sha256 only (`scripts/lib/wasm-scan.ts`). Names assembled at run time remain the accepted
boundary of the template, but without `env` or the import they cannot reach the runtime.

Everything else of the template stays: no `eval`/`new Function`/injected scripts, no remote code, no other `.wasm` or media, `public/`
holds locales and icons only. The only network access of the extension is the Google Fonts preview: the result page links
`https://fonts.googleapis.com/css2?family=<name>&display=swap` stylesheets (family names only, never page text) and
`https://fonts.google.com/specimen/<name>` links; the service worker may `fetch` the image the user right-clicked (without
credentials; a failure falls back to a screenshot).

Other deliberate adaptations of the guards (details in the pull request): Web Store limits of 75 characters for the name, the
brand in the name and exactly the 55 locales; the fixed number of results ("5") in three messages; `data-i18n-ph` placeholders;
a per-page list of strings that are not translated by design (`UNTRANSLATED_ALLOWED`); `terser` in the allowed Vite keys.

## What the checks guarantee

- Locales have identical keys and placeholders; keys used in code, HTML and the manifest exist in `en` and `en` has no unused
  keys (a key counts as used only through `t()`, `data-i18n*`, `__MSG_x__` or an explicit `[...] satisfies MessageKey[]` list);
  the name is at most 75 characters and contains "FontSnap", the description at most 132; no hardcoded text in HTML.
- One hand-written expected manifest (`scripts/lib/expected-manifest.ts`) is compared in full with `buildManifest()` by
  `manifest.test.ts` (which also pins the exact key set) and with the built `dist/manifest.json` by `verify-dist`, so a wrong
  `src/manifest.ts` fails the build as well as the tests. `verify-dist` is also an allowlist over the files on disk: chunks,
  stylesheets in `assets/`, the manifest and its pages, locale messages, the manifest icons and the five pinned vendor files;
  anything else is an error.
- e2e tests run fully parallel, each with its own browser profile and each worker with its own HTTP server. Coverage is at least
  80% for `src/shared`, `scripts/lib` and for the unit-tested sources overall.

### Guards are pinned by snapshots

A guard that can be weakened by editing a config is pinned by an **exact snapshot** in `tests/guard-snapshots/*.json`:

| Snapshot         | What it fixes                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `scripts.json`   | `scripts`, `engines`, `overrides` of `package.json`                                                                     |
| `workflows.json` | every workflow, composite action and `dependabot.yml`: `on:`, jobs, `needs`, `permissions`, steps, env                  |
| `tooling.json`   | the effective Vitest and Playwright config, every tsconfig, `.nvmrc`, `.npmrc` (absent), Prettier files, `src/env.d.ts` |
| `eslint.json`    | the effective ESLint config, with rule options, for one representative file of each context                             |

The tests compare the current state with the files using `toEqual`, and every lintable file must map to a snapshotted context. After a
**deliberate** change run `npm run guards:update`, review `git diff tests/guard-snapshots`, and explain the change in the pull
request. ESLint inline configuration is never honoured; `scripts/check-reports.ts` fails on any skipped, todo, flaky or retried test.
Other layout guards: extension code lives under `src/` only; `src/` holds `.ts`, `.html` and `.css`; pages carry only
`<script type="module" src="./index.ts">`; tool configuration is an exact list of root files; the Vite configuration imports only
`vite`, `node:` built-ins and the pinned files. `python/`, `data/`, `store/`, `model/` and `scripts/i18n/` are outside the Node
toolchain and are never formatted (`.prettierignore`).

## Recipes: extending an allowlist

Every list that a guard checks has ONE declared source of truth that all its consumers import, plus a test that pins the consumers
to it. Extend a list by editing it and following the recipe, never by editing guard code.

- **Add a page**: add it to `EXTENSION_PAGES` (`src/shared/constants.ts`), create `src/<area>/<page>.html` (only
  `<script type="module" src="./index.ts">`), a thin `index.ts` and the logic in `app.ts`; add the `data-i18n` keys to every
  locale; run `npm run guards:update` and read the diff; if the manifest names the page, edit `src/manifest.ts` and
  `scripts/lib/expected-manifest.ts`.
- **Add a dependency**: `npm i some-lib` (runtime) or `npm i -D some-tool`, from the npm registry only (no `file:`, git, URL or
  tarball). A library that brings a `.wasm` file fails the build.
- **Allow a media type**: add the extension to `ALLOWED_MEDIA` in `scripts/lib/static-assets.ts`.
- **Update onnxruntime-web or the model**: install the new version (exact), run `npm run build` to see the new sha256 and size in the
  error, edit `VENDOR_FILES` (`scripts/lib/vendor.ts`) and its copy in `tests/unit/vendor.test.ts`, and run the full regression
  and the browser check; for a new model also `python/fontsnap_ref/build_meta.py`.

## Releasing

1. Bump the version: `npm version x.y.z --no-git-tag-version` (updates `package.json` and the lockfile). Chrome versions are one to
   four dot-separated integers, each 0-65535; `npm run check:version` and the zip step enforce it.
2. `npm run check`, commit.
3. `git tag v<version>` and push the tag.

CI builds the zip and a `.sha256` file; the read-only `verify-tag` job requires the tag to be exactly `v` plus the version in the
manifest inside that zip; then the `release` job, the only one with write access, verifies the checksum and publishes the zip and
its checksum as release assets (`gh release create`, never overwriting). Nothing is published for a pull request or a push to
`main`. Build provenance (`actions/attest-build-provenance`) runs in its own `attest` job when the repository is public or the
repository variable `ENABLE_ATTESTATIONS` is `true`. Publishing to the Chrome Web Store is manual.

## CI

`.github/workflows/ci.yml`: `checks` (lint, format, types, unit tests with coverage, locales, version), `e2e` (Chromium cached by
Playwright version, headed under Xvfb), `reference` (ruff, pytest, the Python evaluation, the model regression and parity), `build`
(zip and checksum as an artifact), and for version tags `verify-tag`, the optional `attest` and `release`. Third-party actions are
pinned to full commit SHAs, every job has a timeout, and Dependabot keeps npm packages and actions up to date. Git LFS is pulled only
by the jobs that read the model or the test images (`.github/actions/lfs-pull`, cached in `.git/lfs`: the bandwidth quota is small).
Thresholds can be overridden with repository variables of the same names.

## Licenses / provenance

Base model storia/font-classify-onnx (MIT); onnxruntime-web (MIT, fetched from npm and copied into the build unchanged). All code is
our own; no code from jdiputadoevotech/font-classify (unlicensed) is included. Font previews load from Google Fonts (font names only).
