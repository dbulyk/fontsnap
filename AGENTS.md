# Agent notes

Everything a machine can check is checked by `npm run check` (lint, types, tests, locale and version
checks, build, e2e). It works without a display. This file holds only what a machine cannot verify.

Setup: `git lfs pull` (model and test images), `npm ci`, then once `npx playwright install chromium`. Run e2e alone with
`npm run test:e2e:xvfb` (headed under a private Xvfb; plain `npm run test:e2e` needs a display).

- **Permissions are a product decision.** FontSnap has exactly four: `activeTab` + `scripting` (inject the
  selection overlay and take the screenshot of the tab the user invoked it on), `storage` (hand the crop to the
  result page through `chrome.storage.session`) and `contextMenus`. Do not add `permissions`, `host_permissions`,
  `content_scripts` or `optional_*` without a stated reason in the commit message. Never put host access in the
  release manifest; the e2e build's loopback permission is the only exception.
- **Messages from a web page are untrusted.** The only request, `fontsnap-rect` (the selection overlay → the
  service worker), is `content-script` only and its payload is hostile input: it can only start a screenshot of the
  tab the user invoked FontSnap on. A new request type must declare `from` in `src/shared/messages.ts`. Default to `['extension-page']`. Allow `'content-script'` only when a content
  script truly has to send it, and then treat the payload as hostile input and never let it trigger a
  privileged or irreversible action.
- **Guard snapshots change only on purpose.** `tests/guard-snapshots/*.json` pin `package.json` scripts,
  every workflow, the Vitest/Playwright/tsconfig/ESLint configuration and the small steering files exactly.
  If a guard is genuinely wrong, change it, run `npm run guards:update`, read `git diff tests/guard-snapshots`
  and explain the change in the PR. Never regenerate a snapshot just to make a test pass, and do not work
  around a guard (skipped or retried tests, lower thresholds, ignore comments, sleeps, assembled property
  names, `Atomics.wait`, blocking the run in any other way).
- **Targeted test runs use `npx`.** `npx vitest run <path>` and `npx playwright test <path>`; `npm test` and
  `npm run test:e2e` check that every spec file ran and fail for a partial run.
- **Release attestations are opt-in on private repositories.** The `attest` job runs for public
  repositories or when the repository variable `ENABLE_ATTESTATIONS` is `true`; do not make it
  unconditional (it fails on plans without attestation support), keep `release` waiting for it (a skipped
  `attest` lets the release proceed, a failed one stops it), do not give `release` the OIDC permissions
  back, and do not remove the checksum.
- **Extension code lives under `src/` only.** `public/` holds locales and icons, never code; tool
  configuration (ESLint, Prettier, tsconfig, Vite, package.json) exists only at the repository root.
- **One declared source of truth per list.** Every list of pages and every allowlist (pages: `EXTENSION_PAGES`
  in `src/shared/constants.ts`; media: `ALLOWED_MEDIA` in `scripts/lib/static-assets.ts`; package.json fields:
  `PACKAGE_KEYS`; Vite config keys: `ALLOWED_VITE_KEYS`; tool configs: `OWNED_TOOL_CONFIGS`) lives in one place
  that the build, the guards, `verify-dist` and the tests import, and a test pins the consumers to it. Extend a
  list by editing that one list and following the recipe in `README.md` ("Recipes"), never by editing guard code;
  if a recipe seems to need a guard edit, a consumer is missing the import.
- **WebAssembly is unsupported, with ONE narrow exception: `VENDOR_FILES` in `scripts/lib/vendor.ts`.** FontSnap
  runs its model with onnxruntime-web, so five files are allowed, byte for byte (sha256 and size): the three
  onnxruntime-web 1.30.0 runtime files, `model/model_fp16.onnx` and `model/meta.json`; and the CSP is the exact
  string `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; object-src 'none'; base-uri 'none'` (never `'unsafe-eval'`; do not add a
  source to `connect-src`: it is what keeps every request inside the extension, `fetch` of a `data:` URL included - use `src/shared/data-url.ts`). Any other `.wasm`/`.onnx`, other bytes under these
  names, another CSP source or a missing COEP/COOP fails `verify-dist` and the tests. Changing the runtime or the
  model means editing the table AND its second copy in `tests/unit/vendor.test.ts` in the same commit, with a reason.
  onnxruntime-web is imported and configured ONLY in `src/result/model.ts` (lint refuses `env`, `wasmPaths`, `wasmBinary` and the
  import elsewhere; `model.test.ts` pins that file as an allowlist; `assertPinnedRuntime` checks the VALUE of `wasmPaths` at start-up;
  `verify-dist` scans built scripts for WebAssembly bytes, foreign hosts and those settings): never set `wasmBinary`, never give
  `wasmPaths` anything but exactly `chrome.runtime.getURL('ort/')`, and never write to `globalThis`/`window`/`self`, `chrome`, `navigator`,
  a prototype. `src/` reaches the environment through an allowlist (`GLOBAL_ACCESS` in `eslint.config.js`): a new global, or a new member of
  `chrome`/`navigator`/`performance`/`Object`/`String`, is a deliberate edit of that list, like a permission. The runtime runs in its own
  worker (`env.wasm.proxy = true`, checked at start-up and in `verify-dist`); do not turn that off.
  All of `src/select/` (by glob: a new file there is under the rules at once) and `src/background/measure.ts` run in the web page's process,
  outside the CSP: they are held to `PAGE_PROCESS_GLOBS` in `eslint.config.js` (the Window is the first parameter of `startSelection` and
  only its listed members are used; no computed key, no cast, no `Object.*` but `Object.assign(el.style, { key: value })` with the keys of `STYLE_KEYS`: a style can load a file with `url()`, so no other way to write one). Every member of every DOM object used there is on `DOM_MEMBERS` (allowlist by type, rule `fontsnap/dom-members`): a new DOM member is a deliberate edit of that list. `src/select` imports values
  from itself only (everything else as `import type`) and `tests/unit/select-bundle.test.ts` checks the real `select.js`; do not import a
  shared module there, write the few lines in `src/select/` (see `chrome.ts`). `measureImage` is the only function lint accepts as `func`
  of `executeScript`; `fetch` is on no file's allowlist, and `this` is only for class constructors.
  The Python reference (`python/`), `data/`, `store/` and `scripts/i18n/` are outside the Node toolchain and are
  never formatted or linted by it; `store/` is not touched at all (the Web Store texts and privacy policy).
- **Allowlists are `Map`/`Set` (or arrays searched by value), or checked with `Object.hasOwn`; never `obj[key]` or
  `key in obj` on a plain object.** A plain object also answers for `constructor`, `toString` and `__proto__`
  (`ALLOWED_MEDIA['constructor']` once let `evil.constructor` into the popup). Every list has a test that feeds it
  all names of `Object.prototype` (`PROTOTYPE_NAMES` in `tests/unit/helpers/media.ts`); lint refuses `in` with a
  dynamic key in `src/` and `scripts/`.
- **Dependencies come from the npm registry only** (semver ranges or dist-tags; the lockfile resolves from
  `https://registry.npmjs.org/`): no `file:`, `link:`, git, URL, `npm:` or tarball dependencies.
- **Behavior changes need a test** that fails without the change (unit for logic, e2e for user-visible flows).
- **User-visible text comes from `_locales`** in every locale (the 55 Chrome Web Store ones), written for that
  language; the texts were edited by hand and `scripts/i18n/*.txt` + `build-locales.py` regenerate them byte for
  byte. Machine translation copied in without reading it does not count. Numbers and percents are formatted in
  code, never typed into translations (the one exception is the fixed number of results, `FIXED_NUMBERS` in
  `scripts/lib/locales.ts`).
- **Keep `src/*/index.ts` thin.** They only wire things together; logic lives in testable modules.
- **The recognition pipeline is a contract.** `src/shared/core` mirrors `python/fontsnap_ref` (textcrop,
  preprocessing, TTA, family aggregation, popularity prior `rank^-0.5`, family merge, top-5); the metrics of
  `npm run test:regression` (thresholds in `tests/thresholds.json`) and the 24-image browser check
  (`tests/e2e/identify.spec.ts`) must not move. Do not change the arithmetic to "clean it up".
- **Git LFS holds the model and the test images.** `git lfs pull` before building; CI pulls only what a job needs.
- **Docs follow code.** If you change a command, the structure or the release flow, update `README.md`.
