# Clicked image recognition and page-code type guard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Identify font in this image" analyses the clicked image (page-context load → screenshot crop with scroll restore → whole-view screenshot with a hint), and the page-code guard closes the class "DOM value typed by an own type".

**Architecture:** The service worker runs a three-step ladder (`src/background/clicked.ts`). Two functions may be injected into a page: the existing `measureImage` (widened: measure/restore, image/frame) and the new `loadImagePixels`. A new type-aware lint rule `fontsnap/page-types` closes every place where a non-library object type can be defined in page code; one narrow exception lets `loadImagePixels` write `src` from its first parameter. verify-dist accepts exactly two distinct injected functions.

**Tech Stack:** TypeScript strict, ESLint 10 (local rules in `eslint.config.js`), Vitest, Playwright (headed under xvfb), Vite. No dependency changes.

**Spec:** `docs/superpowers/specs/2026-10-19-clicked-image-and-page-guard-design.md` (read it first; section numbers below refer to it).

## Global Constraints

- CSP stays exactly `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; object-src 'none'; base-uri 'none'`.
- `permissions` stay `['activeTab','scripting','storage','contextMenus']`; no `host_permissions` outside the e2e build.
- `package.json` (deps, version) untouched; `src/shared/core`, `python/`, `store/` untouched.
- Pixels leave the page only as the `executeScript` return value to the worker; nothing else loads a URL but `info.srcUrl`.
- `tests/guard-snapshots` change only through `npm run guards:update`, once, in Task 9, with the diff read.
- No `eslint-disable`, skipped/retried tests, sleeps; allowlists as `Map`/`Set`/`Object.hasOwn`.
- New UI text: key `wholeNote` in all 55 locales via `scripts/i18n/*.txt` + `build-locales.py`, hand-written, no digits.
- Commits are small, end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. No push.

## Review Focus

- Image with `srcset`/`<picture>`: `currentSrc` differs from the clicked `srcUrl`'s attribute → still found (Task 3/4 tests).
- Image taller/wider than the viewport: visible part only, never an error (Task 2 clip test, Task 8 e2e).
- Page already scrolled, nested scroll container: positions restored even when the capture throws (Task 6 `finally` test, Task 8 e2e).
- Tainted canvas / failed decode / missing element: ladder falls through, never surfaces `Could not access this image` while step 3 can work (Task 6).
- Huge image (natural side > 2400 or PNG over the session quota): downscaled in the page, re-encoded in the worker (Task 4/6 tests).
- Two iframes with the same `src`, or a frame deeper than one level: step 3, no wrong crop (Task 3/6 tests).

## File Structure

| File                                                                                                                                                                                                                                       | Responsibility                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `eslint.config.js`                                                                                                                                                                                                                         | rule `fontsnap/page-types`, table `PAGE_TYPES`, load-image exception, `INJECTED_FUNCTIONS`, `DOM_MEMBERS`  |
| `src/background/measure.ts`                                                                                                                                                                                                                | `measureImage(target, kind, saved)` (page process)                                                         |
| `src/background/load-image.ts` (new)                                                                                                                                                                                                       | `loadImagePixels(src)` (page process, the exception)                                                       |
| `src/background/clicked.ts` (new)                                                                                                                                                                                                          | the ladder `clickedImage(info, tab): Promise<CaptureEntry>`                                                |
| `src/background/shot.ts`, `handlers.ts`                                                                                                                                                                                                    | keep `cropToDataUrl`, `openResult`; `imageToDataUrl` moves into `clicked.ts`; handler calls `clickedImage` |
| `src/shared/capture.ts`                                                                                                                                                                                                                    | `CaptureEntry.note`, `frameRect`                                                                           |
| `src/result/{app.ts,result.html,result.css}`                                                                                                                                                                                               | shows `#wholeNote`                                                                                         |
| `scripts/lib/wasm-scan.ts`, `scripts/lib/guards.ts`                                                                                                                                                                                        | two distinct injected functions + loader exception; guard context for `load-image.ts`                      |
| `scripts/i18n/*.txt`, `build-locales.py`                                                                                                                                                                                                   | `wholeNote`                                                                                                |
| tests: `eslint-rules.test.ts`, `helpers/typed-lint.ts`, `wasm-scan.test.ts`, `dist.test.ts`, `background.test.ts`, `clicked.test.ts`, `capture.test.ts`, `page-functions.test.ts`, `guards-lib.test.ts`, `tests/e2e/clicked-image.spec.ts` | see tasks                                                                                                  |
| `README.md`, `AGENTS.md`, `DECISIONS.md` (not committed)                                                                                                                                                                                   | docs                                                                                                       |

---

### Task 1: Rule `fontsnap/page-types` (Part II core)

**Files:** Modify `eslint.config.js` (add `PAGE_TYPES`, `pageTypesRule`, register in `fontsnapPlugin.rules`, enable for `PAGE_PROCESS_GLOBS`); Modify `tests/unit/helpers/typed-lint.ts`; Test `tests/unit/eslint-rules.test.ts`.

**Interfaces:**

- Produces: `export const pageTypesRule` (type-aware, option = array of entries `{ match: string, interfaces: Record<string,string[]>, imports: Record<string,string> }`); `PAGE_TYPES` entries: `src/select/` → `{ interfaces: {}, imports: { Rect: 'src/shared/capture.ts', RequestOf: 'src/shared/messages.ts', MessageKey: 'src/shared/i18n.ts' } }`; `src/background/measure.ts` → `{ interfaces: { MeasuredImage: ['rect','dpr','saved','box'] }, imports: { Rect: 'src/shared/capture.ts' } }`.
- Produces: test helper `pageTypes(file: string, code: string): Promise<string[]>` in `typed-lint.ts` (same mechanism as `domMembers`, rule `fontsnap/page-types`; generalise the helper's internals so both use one function).

Rule semantics (spec §4.1), reported with one message mentioning `PAGE_TYPES in eslint.config.js`:

1. `TSInterfaceDeclaration`: name must be a key of `entry.interfaces`; body must be only `TSPropertySignature` whose key names ⊆ the listed names (no methods, call/index/construct signatures, no `extends`); a table name declared twice is refused.
2. `TSTypeLiteral`, `TSMappedType`, `ClassDeclaration`, `ClassExpression`, `TSEnumDeclaration`: refused.
3. `TSTypeReference` (and `TSTypeQuery` is already refused by existing selectors): resolve the symbol of `typeName` (follow `Alias` via `checker.getAliasedSymbol`); allowed when every declaration is in a default-library file (`program.isSourceFileDefaultLibrary`), or the symbol is a `TypeParameter`, or its name is a key of `entry.interfaces` and declared in the checked file, or its name is a key of `entry.imports` and every declaration's file path ends with the mapped path.
4. `ObjectExpression`: allowed when it is argument 1 of `Object.assign(…)`, or `checker.getContextualType` exists and each constituent is a library type, a table interface, or declared in a file named by `entry.imports` values; otherwise refused.

- [ ] **Step 1: Write failing fixtures** in a new `describe('page code has no types of its own')` of `eslint-rules.test.ts`, reusing the `FORMS`/`verdict` style of the existing DOM block (each form must be refused in `src/select/overlay.ts` _and_ `src/select/a-new-file.ts` _and_ `src/background/measure.ts` unless noted). Forms (name → code): `P1 own interface + querySelector('a') host/click` (`interface A { host: string; click(): void }; const a: A = doc.querySelector('a')!; a.host='x'; a.click();`), `P2 type literal annotation on a parameter`, `P3 own type as return type`, `P4 satisfies an own type` (`doc.querySelector('a') satisfies {host:string}`), `P5 createElementNS('style') typed through own interface with runtime text`, `P6 ownerDocument.createElementNS('style') through an own type in measure.ts`, `P7 default-parameter inference` (`const f = (a = { host: '', click() {} }) => a.host; f(doc.createElement('div'))`), `P8 array inferred from a literal + push`, `P9 class with element members`, `P10 mapped type`, `P11 interface with a method`, `P12 interface with an unlisted property` (declared `MeasuredImage` with `host`), `P13 import type of an unlisted name` (`import type { Request } from '../shared/messages'` referenced as an annotation), `P14 enum`, `P15 generic with own constraint` (`<T extends {host:string}>`), `P16 type alias to a type literal`. Accept fixtures: the real `measure.ts` text, the real `overlay.ts` (read from disk), a `Rect`-typed object literal, `scrollIntoView({ block: 'nearest' })`, `Object.assign(box.style, {…})`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/eslint-rules.test.ts -t "no types of its own"` — Expected: FAIL (rule missing / helper missing).
- [ ] **Step 3: Implement** `pageTypesRule` and `pageTypes` helper as specified; wire `files: PAGE_PROCESS_GLOBS, rules: { 'fontsnap/page-types': ['error', PAGE_TYPES] }`; extend the existing `verdict` helper to include `pageTypes`.
- [ ] **Step 4: Run** the new block plus `npx vitest run tests/unit/eslint-rules.test.ts` — Expected: PASS (existing `E1…O81` still refused, accept cases clean); then `npx eslint src` — Expected: no errors on current sources.
- [ ] **Step 5: Commit** `feat(lint): page code has no types of its own (fontsnap/page-types)`.

---

### Task 2: Pure helpers and the entry note

**Files:** Modify `src/shared/capture.ts`; Test `tests/unit/capture.test.ts`.

**Interfaces:**

- Produces: `CaptureEntry.note?: 'whole-view'`; `export function frameRect(image: Rect, view: Rect, iframe: Rect, box: Rect): Rect` — `image` in the frame viewport; `view = {x:0,y:0,w:innerWidth,h:innerHeight}`; `iframe` = border box in the top viewport; `box` = `{x:clientLeft,y:clientTop,w:clientWidth,h:clientHeight}`. First clip `image` to `view`; map with `sx = iframe.w / (box.w + 2*box.x)`, `kx = box.w / view.w` (same for y): `x = iframe.x + (box.x + image.x*kx) * sx`, `w = image.w*kx*sx`. Throws `Error('Selection is outside the visible area')` when the clipped width or height is `< MIN_CROP_PX`... (use `validRect`-style check: `<= 0`).

- [ ] **Step 1: Tests** (`describe('frameRect')`): identity frame (`iframe={10,20,300,200}`, `box={1,1,298,198}`, `view={0,0,298,198}`, image `{5,6,40,30}` → `{16,27,40,30}`); CSS scale 0.5 (`iframe.w` half) halves the size and offset; image partly outside the view is clipped (`image={-10,-10,50,50}` → `40×40` at the frame origin); fully outside throws. DPR check: `clipCropRect(frameRect(...), 2, bw, bh)` doubles all numbers (DPR 1 and 2).
- [ ] **Step 2: Run** `npx vitest run tests/unit/capture.test.ts` — FAIL (not exported).
- [ ] **Step 3: Implement** `frameRect` and the `note` field.
- [ ] **Step 4: Run** same command — PASS.
- [ ] **Step 5: Commit** `feat: frameRect maps an image rect of an iframe to the tab viewport`.

---

### Task 3: `measureImage` widened (step 2 in the page)

**Files:** Modify `src/background/measure.ts`, `eslint.config.js` (`DOM_MEMBERS` entry for `MEASURE_FILE`: add `parentElement:'r'`, `scrollLeft:'rw'`, `scrollTop:'rw'`, `clientLeft:'r'`, `clientTop:'r'`, `clientWidth:'r'`, `clientHeight:'r'`, `getElementsByTagName:'c'`; `GLOBAL_ACCESS.files['src/background/measure.ts'].window` add `innerWidth`, `innerHeight`); Test `tests/unit/page-functions.test.ts` (new), update the fixture in `eslint-rules.test.ts` ("accepts measureImage as it is") to the new text.

**Interfaces:**

- Produces: `measureImage(target: string, kind: 'image' | 'frame', saved: readonly number[] | null): Promise<MeasuredImage | null>`; `interface MeasuredImage { rect: Rect; dpr: number; saved: number[]; box: Rect }` (property names equal the `PAGE_TYPES` table of Task 1). `box` for `'image'` = `{x:0,y:0,w:innerWidth,h:innerHeight}`; for `'frame'` = `{x:clientLeft,y:clientTop,w:clientWidth,h:clientHeight}`. `saved` = flat `[scrollLeft, scrollTop, …]` of the element's ancestors (`parentElement` chain, nearest first). Restore (`saved !== null`) returns `null` after writing the values back by walking the same chain.
- Behaviour: `'image'` finds `document.images` entry with `currentSrc === target || src === target`, records, `scrollIntoView({block:'nearest',inline:'nearest'})`, two `requestAnimationFrame`s, measures. `'frame'` finds the `<iframe>`s from `document.getElementsByTagName('iframe')` with `src === target`; exactly one match else `null`; no scrolling. Not found → `null`.
- Note: `kind`'s `'frame'` branch reads `src` of an element from `getElementsByTagName`; it is typed `HTMLIFrameElement`, so `dom-members` (`src: 'r'`) applies.

- [ ] **Step 1: Tests** in `page-functions.test.ts` using a hand-made fake `document`/`window` (assign `globalThis.document`, `window`, `requestAnimationFrame` with `vi.stubGlobal`): image found by `currentSrc` (a `<picture>` case) → `scrollIntoView` called with the options, rect/dpr/box/saved returned; ancestors' scroll recorded nearest-first; restore writes values back and returns `null`; image absent → `null`; `'frame'` with two matching iframes → `null`, with one → rect+box, `scrollIntoView` not called.
- [ ] **Step 2: Run** `npx vitest run tests/unit/page-functions.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `measure.ts`; update `DOM_MEMBERS`/`GLOBAL_ACCESS`; keep the header comment true (it names the allowed members).
- [ ] **Step 4: Run** `npx vitest run tests/unit/page-functions.test.ts tests/unit/eslint-rules.test.ts` and `npx eslint src/background/measure.ts` — PASS / clean.
- [ ] **Step 5: Commit** `feat: measureImage measures and restores an image or an iframe`.

---

### Task 4: `loadImagePixels` and its lint exception (step 1 in the page)

**Files:** Create `src/background/load-image.ts`; Modify `eslint.config.js` (`LOAD_IMAGE_FILE`, add to `PAGE_PROCESS_GLOBS`, `DOM_MEMBERS` entry, `PAGE_TYPES` entry `{interfaces:{}, imports:{}}`, selector set for the file, `INJECTED_FUNCTIONS`, `GLOBAL_ACCESS.files`, `dom-members` option `fromParameter`), `scripts/lib/guards.ts` (`PAGE_PROCESS_LOAD`, `contextOf`), `tests/unit/guards-lib.test.ts` (context expectation), `tests/unit/select-bundle.test.ts` (loader imports no value); Test `tests/unit/page-functions.test.ts`, `tests/unit/eslint-rules.test.ts`.

**Interfaces:**

- Produces: `export async function loadImagePixels(src: string): Promise<string | null>` — PNG data URL of the image at natural size scaled so the longest side ≤ 2400 (constant written as the literal `2400` — the file imports no value), or `null`.
- `dom-members` entry option `fromParameter: { member: 'src', fn: 'loadImagePixels' }`: a write to that member is accepted only as an `ExpressionStatement` `X.src = <Identifier>` whose identifier resolves (scope manager) to the first parameter of the top-level function `fn`, and at most once per file.
- Selector set for this file = `pageProcessSelectors` with the `AssignmentExpression > MemberExpression.left[property.name=LOADING_NAMES]` selector replaced by one that exempts property names `src` and `crossOrigin`, plus: `NewExpression[callee.name='Image']:not([arguments.length=0])`, `Identifier[name='Image']:not(NewExpression > Identifier.callee)`, `AssignmentExpression[left.property.name='crossOrigin']:not([right.value='anonymous'])`, `NewExpression[callee.name='Image']` limited to one occurrence (checked in the rule via counting, same place as `fromParameter`). `noStyleSelectors` apply (no style).
- `DOM_MEMBERS` for the file: `images:r currentSrc:r src:r complete:r naturalWidth:r naturalHeight:r crossOrigin:w decode:c getContext:c drawImage:c convertToBlob:c arrayBuffer:c` plus `src:w` (only through `fromParameter`). `GLOBAL_ACCESS.files`: `Image: true, btoa: true, String: ['fromCharCode'], document: ['images']`.
- Behaviour per spec §3.2: draw the existing element (if `complete && naturalWidth > 0`) on an `OffscreenCanvas`, `convertToBlob` inside `try`; on any throw or missing element: `new Image()`, `crossOrigin = 'anonymous'`, `src = src`, `await decode()`, draw, convert; any failure → `null`. Base64 by 0x8000-byte chunks.

- [ ] **Step 1: Tests.** Unit (`page-functions.test.ts`, fakes for `document.images`, `Image`, `OffscreenCanvas`): same-origin element drawn directly, `Image` never constructed; element whose `convertToBlob` throws `SecurityError` → `Image` constructed with `crossOrigin === 'anonymous'` and `src === <argument>`; decode rejection → `null`; no element → loader path; side 5000×1000 → canvas 2400×480. Lint fixtures (`eslint-rules.test.ts`, file `src/background/load-image.ts`): the real file accepted; refused: second `.src =`, `.src = 'https://x'`, `.src = src + '#'`, `.src = <other variable>`, `img.src = src` inside a nested function, `new Image('x')`, `new Image()` twice, `crossOrigin = 'use-credentials'`, `crossOrigin = u`, `fetch`, `createElement('img')`, `setAttribute('src', src)`, `href = src`, `document.createElement('canvas')`, `import { x } from '../shared/capture'`, and a second exported function; plus the same forms in `measure.ts` (the exception does not leak: `new Image()` and `.src = src` refused there and in `src/select/`).
- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement** the file, the lint changes, the `fromParameter` support in `domMembersRule`, `guards.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/page-functions.test.ts tests/unit/eslint-rules.test.ts tests/unit/guards-lib.test.ts tests/unit/select-bundle.test.ts` and `npx eslint src` — PASS / clean (`guards-lib` writeGuards-vs-snapshot test fails until Task 9: note it, do not regenerate yet).
- [ ] **Step 5: Commit** `feat: loadImagePixels, the one page function that may load a URL (srcUrl only)`.

---

### Task 5: verify-dist — two distinct functions, one loader

**Files:** Modify `scripts/lib/wasm-scan.ts` (`scriptProblems`, a new exported `loaderProblems`), Test `tests/unit/wasm-scan.test.ts`, `tests/unit/dist.test.ts`.

**Interfaces:**

- `scriptProblems` for `background.js`: bodies from `injectedFunctions` de-duplicated by text; must be **exactly 2** distinct and no `undefined`; message `exactly two functions must be handed to executeScript (found N)`. Per body: if the body contains `new Image` it is the loader: remove from the text, once each, `new Image`/`new Image()`, `.crossOrigin="anonymous"` (spacing-insensitive, terser writes `.crossOrigin="anonymous"`), and `.src=<P>` where `<P>` is the name of the function's first parameter (read with the TS AST in `injectedFunctions`' program — export a helper returning `{ text, firstParam }` entries instead of strings), then run `pagePlatformProblems` on the rest; more than one loader, or a loader with a second `new Image`/`.src =`/`.crossOrigin =`, fails; a body without `new Image` gets the unchanged `pagePlatformProblems`.
- Keep `injectedFunctions(file, text)` signature working for its existing tests (add a sibling `injectedFunctionDetails`).

- [ ] **Step 1: Tests**: minified fixtures for the real shape (`async function m(t){…}`, `async function l(t){const i=new Image;i.crossOrigin="anonymous";i.src=t;await i.decode();…}` + two `executeScript` calls, and the measure called three times with the same `func`) → no problems; refused: one function only, three distinct, loader with `i.src=u` (non-param), second `.src=`, `fetch` in the loader, `new Image` in the measure body, two loaders, a loader reached through an alias (`undefined` entry), `crossOrigin="use-credentials"`. Update the existing `dist.test.ts` fixtures (lines ~64, ~906–912, ~1086) to two functions.
- [ ] **Step 2: Run** `npx vitest run tests/unit/wasm-scan.test.ts tests/unit/dist.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** same — PASS.
- [ ] **Step 5: Commit** `feat(verify-dist): exactly two injected functions, the loader's one narrow exception`.

---

### Task 6: The ladder in the worker

**Files:** Create `src/background/clicked.ts`; Modify `src/background/shot.ts` (remove `imageToDataUrl`, export what `clicked.ts` needs: `bytesToDataUrl`, `cropToDataUrl`, plus new `reencodeWithinQuota(dataUrl): Promise<string>` using `encodeWithinSessionQuota` after `createImageBitmap(dataUrlToBlob(..))`), `src/background/handlers.ts`; Test `tests/unit/clicked.test.ts` (new) + migrate the `right-click on an image` and `measuring an image inside the page` blocks of `tests/unit/background.test.ts` (keep behaviours, change expectations to the ladder).

**Interfaces:**

- Produces: `export async function clickedImage(info: Pick<chrome.contextMenus.OnClickData, 'srcUrl' | 'frameId' | 'frameUrl'>, tab: chrome.tabs.Tab | undefined): Promise<CaptureEntry>` — never throws. `handlers.ts`: `void clickedImage(info, tab).then((entry) => openResult(entry, tab))` (text `''` stays in the entry for decoded/cropped results).
- Ladder (spec §3.1): data: path unchanged; step 1 `chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId ?? 0] }, args: [srcUrl], func: loadImagePixels })` → `results[0]?.result` string starting `data:image/png;base64,` → `{ dataUrl: await reencodeWithinQuota(pixels), text: '' }`; any throw/`null`/invalid → step 2: record top baseline (`frame`, only when `frameId > 0` and `frameUrl` given), `image` measure in `frameId`, `frame` measure again, compose rect (`frameRect` for frames), `captureVisibleTab(tab.windowId,{format:'png'})`, `cropToDataUrl`, and **in `finally`** two `restore` injections (each failure swallowed); any throw/`null`/invalid rect → step 3: `captureVisibleTab` whole, `reencodeWithinQuota`, `{ dataUrl, text: '', note: 'whole-view' }`; if that throws → `{ error: errorMessage(e) }`. No tab id → `{ error: 'Could not access this image' }`.
- All `executeScript` calls are object literals written in place with `func: measureImage | loadImagePixels` (lint contract).

- [ ] **Step 1: Tests** (`clicked.test.ts`, chrome stub + image-apis helpers from `background.test.ts`): step 1 success (no screenshot taken, `frameIds:[7]` for `frameId: 7`, entry has `dataUrl`, no `note`); step 1 `null` → step 2 (screenshot cropped with `dpr 2` → draws `[60,80,200,100,…]` as in the old test; restore injected with the saved list, also when `captureVisibleTab` rejects); iframe click composes `frameRect` (assert the crop rectangle) and a missing/ambiguous iframe (`measure('frame')` → `null`) → step 3; step 1 and 2 injection refused (`mockRejectedValue`) → step 3 with `note: 'whole-view'`; step 3 refused → `{ error }`; empty rect → step 3; data: cases of the old test file unchanged; the `args` of each injection never contain anything but `srcUrl`/`frameUrl`/saved numbers.
- [ ] **Step 2: Run** `npx vitest run tests/unit/clicked.test.ts tests/unit/background.test.ts` — FAIL.
- [ ] **Step 3: Implement** `clicked.ts`, move/adjust `shot.ts`, wire `handlers.ts`.
- [ ] **Step 4: Run** same plus `npx eslint src tests/unit` and `npx tsc -p tsconfig.src.json` — PASS / clean.
- [ ] **Step 5: Commit** `feat: the clicked image is read in its own frame, from a screenshot crop, or as a whole view`.

---

### Task 7: Result-page note and the 55 locales

**Files:** Modify `src/result/result.html` (`<p id="wholeNote" class="tip" data-i18n="wholeNote" hidden>…English text…</p>` below `#status`), `src/result/app.ts` (unhide when `stored.note === 'whole-view'`; `isEntry` stays), `src/result/result.css` if needed, `scripts/i18n/build-locales.py` (`KEYS` + `wholeNote`, appended last), all 52 `scripts/i18n/<lang>.txt` (one appended line each), regenerated `public/_locales/*/messages.json`; Test `tests/unit/result-app.test.ts`, `tests/unit/html-i18n.test.ts` (existing guard picks the key up), `check:locales`.

English text: "The clicked image could not be isolated, so the whole visible area was analysed. For a better result click the FontSnap icon and drag over the text." No digits. Every other language written by hand (no copy of English); RTL ones (`ar fa he`) as usual.

- [ ] **Step 1: Test** in `result-app.test.ts`: an entry `{dataUrl, text:'', note:'whole-view'}` shows `#wholeNote`; without `note` it stays hidden.
- [ ] **Step 2: Run** `npx vitest run tests/unit/result-app.test.ts` — FAIL.
- [ ] **Step 3: Implement** markup + app; add the 52 lines; `python3 scripts/i18n/build-locales.py`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/result-app.test.ts tests/unit/locales.test.ts tests/unit/html-i18n.test.ts tests/unit/i18n.test.ts && npm run check:locales` — PASS, and `git status` shows only intended locale changes.
- [ ] **Step 5: Commit** `feat(i18n): hint for the whole-view fallback in 55 locales`.

---

### Task 8: e2e

**Files:** Create `tests/e2e/clicked-image.spec.ts`; Modify `tests/e2e/fixtures.ts` only to add helpers if needed (e.g. `extraServer(handler)` returning an origin on another 127.0.0.1 port).

Test content (each opens the result tab through `serviceWorker.evaluate(... onClicked.dispatch({menuItemId: MENU_IMAGE, srcUrl, frameId, frameUrl}, tab))` exactly like `transparent.spec.ts`): the site page has long text above and below and a rendered-text PNG (`SAMPLE_TEXT`, generated in the browser like `renderSample`) far below the fold; assert only the image reached the analysis (`#shot` canvas size equals the image's natural size for step 1; equals the CSS box × DPR for step 2) and top-1 equals the top-1 of uploading the same PNG.

Cases: (a) same site, image far below the fold, step 1; (b) image larger than the viewport (taller than 1024) step 1 whole image; (c) other origin with `Access-Control-Allow-Origin: *` → step 1 (`#wholeNote` hidden, `#shot` natural size); (d) other origin without CORS → step 2 (scroll restored: `window.scrollY` before == after; `#shot` size = box×DPR); (e) same-origin iframe, image inside; (f) cross-origin iframe (other port) with its own image; (g) non-CORS image inside an iframe → step 2 with offset; (h) DPR 1 and 2 for (d) via `page.emulateMedia`… use CDP `Emulation.setDeviceMetricsOverride` with `deviceScaleFactor` 1 and 2; (i) unscriptable target (`chrome://version/` tab or a non-existent image URL on a tab where injection works) → step 3, `#wholeNote` visible, error text absent; (j) image removed from the DOM → step 3.

- [ ] **Step 1: Write the spec** (it fails first because `clicked.ts` is not built into `dist-e2e` only if Tasks 1–7 are absent; here they exist — run to observe real failures and fix the _code_ if any).
- [ ] **Step 2: Run** `npx tsx scripts/e2e.ts` or `npm run build:e2e && npx playwright test tests/e2e/clicked-image.spec.ts` under `xvfb-run` (`npm run test:e2e:xvfb` runs everything) — Expected: PASS for all cases.
- [ ] **Step 3: Fix** whatever the real browser shows (scroll restore, iframe offset, CORS reload); each fix in code gets its unit test from Task 3/6 extended.
- [ ] **Step 4: Run** the whole e2e suite (`npm run test:e2e:auto`) — all green, `reports/playwright.json` accepted by `check-reports`.
- [ ] **Step 5: Commit** `test(e2e): clicked image, step by step`.

---

### Task 9: Docs, snapshots, final checks

**Files:** Modify `README.md` (page-process section: two functions, `page-types`, the loader exception; "The right-clicked image of another origin cannot be downloaded any more…" sentence: now read in its page/frame, screenshot as the second step), `AGENTS.md` ("`measureImage` is the only function lint accepts as `func`" → both functions; the types rule); `tests/guard-snapshots/*.json` via `npm run guards:update`; `DECISIONS.md` (uncommitted).

- [ ] **Step 1: Update docs.**
- [ ] **Step 2: Run** `npm run guards:update`, then `git diff tests/guard-snapshots`; read it: expected changes only in `eslint.json` (new rule, new file in the page-process context list, new selectors) — anything else is investigated. Note each change in the commit body.
- [ ] **Step 3: Run** the full gate: `npm run lint && npm run format:check && npm run typecheck && npm test && npm run check:locales && npm run build && npm run check:version && npm run test:e2e:auto` and `npm run test:regression` — Expected: all exit 0; regression numbers equal `tests/thresholds.json` baseline.
- [ ] **Step 4: Commit** `docs: README/AGENTS for the clicked-image ladder; guards: update snapshots` (two commits if cleaner).
- [ ] **Step 5: Final review** with superpowers:verification-before-completion before any claim; report "Skipped: PR is opened by the operator".
