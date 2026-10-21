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
- **Right-click on an image** analyses that image, in three steps (`src/background/clicked.ts`). (1) The pixels are loaded in the
  frame where the click happened (`chrome.scripting.executeScript` with `frameIds: [info.frameId]`, `loadImagePixels`): the element
  is drawn on a canvas, or, when the canvas is tainted, the clicked `srcUrl` is loaded once more with CORS; the PNG goes back to the
  service worker and nowhere else (an image larger than 2400 px is scaled). (2) Otherwise the tab is scrolled to the image (and given two frames and 200 ms to show the new position, which a screenshot taken at once can miss), screenshot
  and cropped by `getBoundingClientRect() × devicePixelRatio` (a larger image: its visible part; an image in an iframe: moved by the
  position of the `<iframe>` in the top frame, direct children only, found by the frame URL; the border of each side is followed exactly, an iframe with padding goes to step 3 because the side of the padding cannot be read without the style) and the scroll positions of every scroller are put back in a
  `finally` (scrolls are `behavior: 'instant'`, so a page with `scroll-behavior: smooth` is neither measured nor left mid-animation; a page that does not answer within 20 s / 5 s is given up on). (3) Otherwise the whole visible area is analysed and the result page says so (`wholeNote`); the screenshots of steps 2 and 3 go through one helper that keeps `captureVisibleTab` calls a second apart (Chrome's quota is two a second) and takes the picture once more only after the transient "image readback failed" (a screenshot soon after the page repainted); the quota, an inactive tab or a forbidden page are not retried. A `data:` image is decoded
  in the worker. With `activeTab` alone a cross-origin iframe is probably not scriptable (steps 1 and 2 then fall through to 3); the
  e2e build's loopback host permission stands in for the grant, so the e2e tests prove the logic, not the grant.
- **Result page** (`src/result`): paste, drop or choose an image (also the way in on `chrome://` pages), top-5 Google Fonts with
  a live preview, relative score (results below 1% are hidden), "copy CSS" with the category's generic fallback.
- **Welcome page** (`src/welcome`) opens once on install (not on updates) with the pin or usage instructions, depending on
  whether FontSnap is already on the toolbar; right-to-left for Arabic, Hebrew and Persian.
- **Recognition pipeline** (`src/shared/core`): text-line finder, cv2-compatible preprocessing, test-time augmentation (two
  crops), family aggregation, popularity prior `rank^-0.5`, near-duplicate family merge. `python/fontsnap_ref` is the reference.
- **Localization**: 55 Chrome Web Store locales in `public/_locales`, generated from `scripts/i18n/*.txt`.

## Layout

| Path                                              | Contents                                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/manifest.ts`                                 | the manifest, generated into `dist/manifest.json` (the version comes from `package.json`)                                                                               |
| `src/shared/`                                     | constants (`EXTENSION_PAGES`), i18n, typed messaging, `capture.ts` (crop → session handoff helpers), `ui.ts`, `core/` (the recognition pipeline); imports no other area |
| `src/background/`                                 | service worker: toolbar and context menus, screenshot, crop, handoff                                                                                                    |
| `src/select/`                                     | the selection overlay, injected on demand, built as `dist/select.js`                                                                                                    |
| `src/result/`, `src/welcome/`                     | the two pages (markup and styles as before)                                                                                                                             |
| `public/`                                         | `_locales/` (55 languages) and `icons/icon-<size>.png`, copied as is                                                                                                    |
| `model/`                                          | `model_fp16.onnx` (Git LFS) and `meta.json`: copied into the build by the vendor plugin, byte for byte                                                                  |
| `scripts/`                                        | build and check helpers (`lib/` is unit-tested), `eval/` (JS evaluation on realset3), `i18n/` (locale sources and `build-locales.py`)                                   |
| `python/fontsnap_ref/`, `python/data/`            | Python reference pipeline (`textcrop`, `pipeline`, `evaluate`, `build_meta`) and its data (classes, family mapping v2b, Google Fonts metadata)                          |
| `python/train/`                                   | Free-phase OFL inventory, on-the-fly synth loader, PyTorch port/parity, RunPod dry launcher (extra deps in `python/train/requirements.txt`)                             |
| `data/fonts_manifest_v3.tsv`, `data/licenses/v3/` | 582 new OFL class rows (Fontsource / Collletttivo / Velvetyne) with full-font URLs + sha256, and per-family `OFL.txt` (no font binaries)                                |
| `data/realset3/`                                  | 263 labelled screenshots (`images/` via Git LFS, `labels.csv`) and the collection scripts                                                                               |
| `data/realshots/`                                 | Label CSV format for tester-collected screenshots of new families (`out/realshots/images/` holds pixels)                                                                |
| `tests/`                                          | `unit` (Vitest), `e2e` (Playwright), `regression` (realset3 + parity), `python` (pytest), `fixtures`, `guard-snapshots`, `thresholds.json`                              |
| `store/`                                          | Chrome Web Store listings, graphics and the privacy policy (not part of the build, never formatted)                                                                     |

## Setup

Requires git-lfs, Node 22.13 or newer (`.nvmrc`) and, for the Python reference, Python 3.10+.

```
git lfs install && git lfs pull        # model and test images
npm ci
npx playwright install chromium        # once (add --with-deps on a fresh Linux machine)
python -m venv .venv && . .venv/bin/activate && pip install -r python/requirements.txt
# optional, local train/parity only (not the CI reference job):
pip install -r python/train/requirements.txt
```

## Train prep (OFL sources, $0 path)

Working directory for these commands is `python/` (same as `fontsnap_ref.evaluate`). The shipped `model/` bytes stay read-only.

```
python -m train inventory          # rebuild data/fonts_manifest_v3.tsv + licenses (network)
python -m train generate --check   # assert TSV/licenses match the loader
python -m train samples --split train --per-class 2 --dry-run
python -m train parity --limit 4   # CPU: PyTorch vs ORT on prep(crop_normalize)
python -m train runpod plan --mode calibrate   # prints create body; does not read RUNPOD_API_KEY
# live calibrate (not in CI; needs RUNPOD_API_KEY). Caps: <=20 min and <=$1. API v2:
# https://docs.runpod.io/api-reference-v2/ (base https://api.runpod.io/v2,
# price from GET /v2/catalog/gpus/{id} → price.secure).
# FONTSNAP_RUNPOD_LIVE=1 python -m train runpod watch --mode calibrate
```

Real-shot labels: `data/realshots/README.md`. Prior/merge tables for new sources live in `python/train/policy.py` (values stay at product defaults until a GPU hold-out).

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

Transparency: an image with an alpha channel (PNG, WebP, GIF, AVIF) is composited before it reaches the pipeline. The backdrop
is chosen by contrast, so that text stays against its ground: when the alpha-weighted mean luminance of the content (the `toGray`
formula, integers) is above 127.5 the image goes on black, otherwise on white; the tie and an image without content go to white. A
fully opaque image is not changed. `chooseBackdrop`, `compositeOver` and `fromRGBA` in `src/shared/core/image.ts` and `choose_backdrop`, `composite_over` and
`to_rgb` in `python/fontsnap_ref/image.py` apply the same integer sum, and the result page does not paint its canvas, so the alpha reaches
`fromRGBA`. A screenshot (region selection, right click on an image of another site) is opaque: transparency there is already
composited on the background of the page. `tests/fixtures/alpha-composite.json` is the table both sides are tested with, and
`tests/e2e/transparent.spec.ts` checks black text on transparent against black on white and white text on transparent against
white on black, by upload and by the context menu on a data: image, and that the pixels of a transparent image survive the
premultiplied canvas of Chromium. Python loaders call `to_rgb` (a test refuses a bare `convert("RGB")`).

## Exceptions to the template (WebAssembly, the model, the CSP)

The template forbids WebAssembly. FontSnap runs its model with onnxruntime-web, so it has a short, explicit list of exceptions;
each is declared once and held by tests that fail on any deviation.

| What                                                                                                                                                                                                                                                                                                       | Where it is declared                                     | What holds it                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ort/ort.wasm.min.mjs`, `ort/ort-wasm-simd-threaded.mjs`, `ort/ort-wasm-simd-threaded.wasm` of onnxruntime-web **1.30.0**, byte for byte                                                                                                                                                                   | `VENDOR_FILES` in `scripts/lib/vendor.ts` (sha256, size) | `vendor.test.ts`, `dist.test.ts`, the build (`vendorPlugin`), `verify-dist`                                                                                                                               |
| `model/model_fp16.onnx` and `model/meta.json`                                                                                                                                                                                                                                                              | the same table                                           | the same                                                                                                                                                                                                  |
| CSP `extension_pages` is exactly `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; object-src 'none'; base-uri 'none'` (string equality, the order too; no `unsafe-eval`, no extra source) | `EXTENSION_PAGES_CSP` in `src/manifest.ts`               | `manifest.test.ts`, `dist.test.ts` (42 variants), `verify-dist`, e2e `manifest.spec.ts`, `csp.spec.ts` and `font-preview.spec.ts` (the Google Fonts previews, which `connect-src` does not govern)        |
| `cross_origin_embedder_policy` credentialless, `cross_origin_opener_policy` same-origin (SharedArrayBuffer for multithreaded WASM)                                                                                                                                                                         | `src/manifest.ts`                                        | `manifest.test.ts`, `dist.test.ts`                                                                                                                                                                        |
| The one external import of the build, `onnxruntime-web/wasm` → `ort/ort.wasm.min.mjs`                                                                                                                                                                                                                      | `ORT_SPECIFIER`, `ORT_EXTERNAL` in `vendor.ts`           | `src-only.test.ts` (that id passes, eleven look-alikes are refused), `vite-configs.test.ts` (`vendorPlugin` answers only that specifier), `dist.test.ts` (the import must resolve to a file of the build) |

**The runtime cannot be pointed elsewhere, and the page cannot reach what loads it.** onnxruntime-web has two settings that would run
WebAssembly other than the pinned files with every check above green (`env.wasm.wasmPaths`: another URL or `.wasm`; `env.wasm.wasmBinary`:
other bytes), and it fetches its `.wasm` through `fetch`, so replacing `fetch` (or a prototype, `chrome.runtime.getURL`, the global object
through `document.defaultView`, `top`, ...) would load other bytes without touching the runtime at all. Rounds of review found the ways to
reach and replace those one after another, so the layers do not try to list the ways; the outermost ones remove the capability:

1. **The CSP** (`default-src 'self'`, `connect-src 'self'`): no request of the extension (a page, the worker of the runtime, the service worker)
   leaves the extension, whatever code runs and however the URL was built, and **neither does an image, a frame, a media file, a prefetch or a
   style sheet** - which no scan of the scripts can see (a CSS `url()`, an `<img>` or `<iframe srcdoc>` in HTML, `img.src` built at run time):
   the browser refuses them (`tests/e2e/csp.spec.ts` makes a page of the extension try each; no request passes, the violation is reported).
   Outside the extension only the Google Fonts previews are let in: `style-src` has `https://fonts.googleapis.com` (the `<link>`) and `font-src`
   `https://fonts.gstatic.com` (the files its CSS names); no `'unsafe-inline'` (there is no `<style>` and no `style=""` attribute: the code sets
   styles through CSSOM, which the CSP does not block). There is no `img-src` and no `worker-src`: the pages show packaged icons and draw the
   crop on a canvas from bytes decoded by `src/shared/data-url.ts` (no `data:` or `blob:` image), and the workers of the runtime are files of the
   extension; the fallbacks (`'self'`) are right. `data:` URLs cannot be fetched either, which is why the screenshot and the handed-over crop are
   decoded by `src/shared/data-url.ts`. The worker downloads nothing: the right-clicked image is loaded in its own page
   (`loadImagePixels`) or read from a screenshot of the visible area. `object-src 'none'` and `base-uri 'none'` close the plugin and `<base>` doors;
   `form-action` and `frame-ancestors` are not set (no page has a form, and no page of the extension is web accessible, so none can be framed).
2. **The runtime lives in a worker of its own** (`env.wasm.proxy = true`): it fetches and compiles its `.wasm` in a global scope that nothing in the
   page can reach, so replacing `fetch`, a prototype or a method in the page changes nothing there (`tests/e2e/runtime.spec.ts` shows that
   the page's `fetch` sees only `meta.json` and the model). At start-up `assertPinnedRuntime` requires `proxy` to be `true`, `wasmPaths` to be exactly
   the string `chrome.runtime.getURL('ort/')` and no `wasmBinary` (not own, not inherited, not a getter); `assertNoOutsideLoads`
   (resource timing) is only a detective for what the page loads.
3. **Lint is an allowlist, not a list of forbidden spellings** (`GLOBAL_ACCESS` in `eslint.config.js`, the local rule `fontsnap/global-access`):
   a global that is not on the list cannot be used in `src/` at all, a restricted one (`chrome`, `navigator`, `performance`, `Object`,
   `String`, ...) only through the members named there, and never written, aliased, destructured, computed or passed on; the properties
   that hand over a Window (`defaultView`, `contentWindow`, `view`, `source`, `currentTarget`, ...) are refused, the two page scripts that
   listen to their window hold it in one exact form. Adding a line is a decision about what the extension may touch, like a permission.
   The code that runs in the web page's process, where the CSP does not apply (**all of `src/select/`**, by glob, a new file included, and
   `src/background/measure.ts` and `src/background/load-image.ts`, the two functions handed to `chrome.scripting.executeScript`, which lint
   accepts as `func` and nothing else; `measureImage` measures and scrolls, `loadImagePixels` is the one function with an exception to
   "nothing that loads": `new Image()` with `crossOrigin = 'anonymous'` and one `src =` from its first parameter, the `srcUrl` of the click, written only on the
   `const` that `new Image()` made in that function and after `crossOrigin`, `DOM_MEMBERS.fromParameter`), is held to a closed class (`PAGE_PROCESS_GLOBS`): the Window is the first parameter of `startSelection`, under any name, used only
   as `.document`, `.addEventListener`, `.removeEventListener`, `.getSelection`, `.requestAnimationFrame`, `.devicePixelRatio` (the marker
   `__fontsnapActive` is the one thing written); no computed key, no cast, no `for...in`, no `typeof`/indexed types, no `Object.*` but
   `Object.assign(el.style, { key: value })` (a statement of its own; its result is never kept) with the overlay's own style keys (`cursor` and `background`, the two that could take a `url()`, only as a keyword, hex colour or `rgb()`; no `.style` anywhere else, no `setProperty`/`cssText`), only `div` elements (and `getElementsByTagName('iframe')`), nothing that loads or navigates, no `import.meta`, and **every member is on an allowlist by where it is declared** (`DOM_MEMBERS` and `PAGE_TYPES`, the type-aware rule `fontsnap/dom-members`: a member may be used only when ALL of its declarations are in `lib.dom.d.ts` and it is on the list (read, called or written only as the list says), or in another library (`Array`, `Promise`, `Math`...), or in the API of the extension, or in a type that `PAGE_TYPES` lists for the file; a member with no declaration (what `'click' in u` makes up) or declared anywhere else, such as an `interface` of the code's own, is an error, so a DOM value cannot be hidden behind a type - `createElementNS`, `createAttribute`, `setAttributeNode*`, `querySelector*`, `ownerDocument`, `click`, `href`, `innerHTML` and the rest are not on it; `left`/`top`/`width`/`height` take a literal length or exactly `${number}px`); `fetch` is on no file's list. `src/select` imports
   **values only from itself** (`./name`; other modules only as `import type`, `measure.ts` takes no value import), so nothing outside the
   folder can be bundled into `select.js`, and `tests/unit/select-bundle.test.ts` reads the real bundle to show it. `this` is allowed only
   in a class constructor (in a callback it is the window).
   The runtime's settings (`env`, `wasmPaths`, `wasmBinary`, the `onnxruntime-*` import) exist only in `src/result/model.ts`, which
   `model.test.ts` pins as an allowlist of its calls, strings, properties and operators.
4. **`verify-dist`** scans every built `.js`/`.mjs` (the vendor files are exempt by exact path and sha256 only; `scripts/lib/wasm-scan.ts`): a
   module header or a `.wasm` name in any spelling, including base64 (at every alignment), hex and byte lists that DECODE to one or to a URL;
   every URL in a string must be on `fonts.googleapis.com` or `fonts.google.com`; no `Worker`, `XMLHttpRequest`, `WebSocket`, `atob`, `eval`, `fetch`/`Request` outside `background.js` and the result chunk,
   `Function`, dynamic `import()`, `postMessage`, `webdriver`, resource-timing resizing, `WebAssembly`; `defaultView` only in the one form
   of the page scripts; in `select.js` and in the two functions that `background.js` hands to `executeScript` (found in the AST, de-duplicated by text: exactly two) no literal network API or way to load/navigate (`fetch`, `Image`, `.src =`, `setAttribute`, `open(`, `location`, `url(`...), but for the loader's `new Image`, `.crossOrigin = "anonymous"` and `.src = <its first parameter>`, once each, read in the syntax tree: the Image is a top-level `const` of the loader and the two writes are statements of that level, crossOrigin first; every `executeScript` call that hands over a function has the target `{ tabId, frameIds: [<one frame>] }` and nothing else (no `allFrames`, `documentIds`, second frame, spread), and the loader's `args` are exactly `[<name>.srcUrl]`; and in the chunk that imports the runtime `wasmPaths` is assigned exactly once to `chrome.runtime.getURL("ort/")`,
   `proxy` exactly once to `true`, and the start-up check is there.

What this does not do: a script that already runs in the page can defeat any check that runs in the same page; layers 3 and 4 and the
tests are what keep such a script out of the build, and layers 1 and 2 are what is left if one gets in.

Everything else of the template stays: no `eval`/`new Function`/injected scripts, no remote code, no other `.wasm` or media, `public/`
holds locales and icons only. The only network access of the extension is the Google Fonts preview: the result page links
`https://fonts.googleapis.com/css2?family=<name>&display=swap` stylesheets (family names only, never page text; a `<link>` is not
governed by `connect-src`) and `https://fonts.google.com/specimen/<name>` links. `fetch` is limited to the extension's own files by the CSP.

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

### Web Store graphics

`store/graphics/<locale>/` holds five screenshots and two promo tiles for each of the 55 locales; the root set is a copy of `en/`.
`scripts/store/` draws them from a release zip with the Playwright Chromium (not run in CI). It needs the Noto fonts (CJK, Ethiopic
and the Indic scripts), Inter and Heebo installed; `fonts.conf` picks the right Noto family per script.

```
unzip release/fontsnap-extension-0.1.0.zip -d /tmp/fs-ext                  # or the zip artifact of a CI run
for l in $(ls public/_locales); do LOC=$l EXT=/tmp/fs-ext npx tsx scripts/store/shots.ts; done   # → scripts/store/out/raw/
EXT=/tmp/fs-ext npx tsx scripts/store/compose.ts [locale ...]              # → store/graphics/<locale>/
```

Headlines are in `scripts/store/captions.json`; `npx tsx scripts/store/samples.ts` redraws the four sample images.

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
