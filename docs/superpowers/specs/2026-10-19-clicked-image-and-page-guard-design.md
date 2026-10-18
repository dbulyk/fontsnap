# Clicked image recognition and page-code guard closure — design

Date: 2026-10-19. One PR, two parts. Baseline: `main` (`df6c4c1`), which already contains the `fontsnap/dom-members`
rule and the strict `injectedFunctions` check of verify-dist (the `wip/fontsnap-guard-allowlist` work).

## 1. Understanding (what was asked, what is assumed)

**Asked (the brief, in short).**

- Part I: "Identify font in this image" (context menu) must analyse the _clicked image_, not the whole window. Order of
  attempts, from the 18.10.2026 decision:
  1. load/draw the image **in the page (frame) where the click happened** (`chrome.scripting.executeScript`,
     `frameIds: [info.frameId]`), return PNG pixels to the extension;
  2. if the canvas is tainted or loading fails: scroll to the element, `captureVisibleTab`, crop by
     `getBoundingClientRect × devicePixelRatio`, restore the scroll position; add the frame offset for an iframe; if the
     offset cannot be known, go to 3;
  3. screenshot of the whole visible area with a hint to select the area.
- Part II: close the _class_ of bypasses of the page-code guard (lint + verify-dist), in particular r4308642691: a DOM value
  passed to a variable/parameter/return/`satisfies` with an own `interface` or object type escapes `fontsnap/dom-members`.
  One fixture per form of bypass. The new image-loading function passes the guard through one explicit, narrow exception.
  Choose one of the two proposed ways and justify it in `DECISIONS.md`.
- Hard limits: CSP unchanged; no new permission; no foreign code/WASM in the page; pixels go nowhere but the extension; no
  dependency changes; no version bump; recognition core untouched (realset3 and the 263 images must not move).

**Assumptions** (each is also one line in `DECISIONS.md`):

- No human is available, so approvals of this spec and of the plan are given by me, as the run rules require.
- The wip branch is not in this repository; its content is on `main` (verified by reading `eslint.config.js`,
  `scripts/lib/wasm-scan.ts` and the fixtures `E1…O81` of `tests/unit/eslint-rules.test.ts`). Part II therefore adds only
  what is still open.
- "Exactly one new function in the allowlist" = the set of functions handed to `executeScript` grows from `{measureImage}` to
  `{measureImage, loadImagePixels}`. The scroll/measure/restore/frame-offset work of step 2 is done by the _existing_
  `measureImage`, called with different arguments, so no third function appears.
- Success = the acceptance criteria listed in the brief; e2e uses the e2e build's `http://127.0.0.1/*` host permission as
  the stand-in for the `activeTab` grant of a context-menu click, like every existing e2e test does.

## 2. Classification

Architectural: it changes the service-worker flow, the contract of what may be injected into a page, the guard rules,
`verify-dist`, the result page and 55 locales.

## 3. Part I — design

### 3.1 Flow (service worker, `src/background/clicked.ts`, new)

```
clickedImage(info, tab) → CaptureEntry          // never throws: errors become entries
  0. data: srcUrl, decodable image            → decoded in the worker (unchanged)
  1. executeScript({ target:{tabId, frameIds:[frameId]}, args:[srcUrl], func: loadImagePixels })
        → PNG data URL | null            → re-encode within the session quota (existing encodeWithinSessionQuota)
  2. screenshot crop (measureImage 'image' [+ 'frame' for frameId ≠ 0], captureVisibleTab, crop, always restore)
  3. captureVisibleTab of the tab, no crop, entry.note = 'whole-view'   (result page shows the hint)
```

Each step is entered only when the previous one _returned no pixels or threw_ (injection refused, tainted canvas, element
not found, image failed to decode, frame offset unknown, empty rect). Step 3 failing too (no `activeTab`, restricted
page) yields `{ error }` as today.

### 3.2 Step 1 — `loadImagePixels(src)` in `src/background/load-image.ts` (the one new injected function)

Runs in the isolated world of the clicked frame. Algorithm:

1. Find the element: `[...document.images].find(i => i.currentSrc === src || i.src === src)` (covers `<picture>`/`srcset`
   through `currentSrc`). If it is `complete` with a natural size, draw it on an `OffscreenCanvas` at natural size
   (downscaled so that the longest side ≤ `MAX_CROP_SIDE`, 2400); a same-origin image is read as it is.
2. If reading the pixels throws `SecurityError` (tainted) or there is no such element: `const im = new Image();
im.crossOrigin = 'anonymous'; im.src = src; await im.decode()` — a CORS-enabled foreign image loads untainted, a
   non-CORS one fails → return `null`.
3. `canvas.convertToBlob({type:'image/png'})` → base64 → `data:image/png;base64,…` (the only value returned).

The page never receives a pixel and never sends one anywhere; the string goes back through the
`executeScript` result into the worker. DPR does not matter on this path (natural pixels).

### 3.3 Step 2 — `measureImage(target, kind, saved)` (existing function, widened)

`measureImage(target: string, kind: 'image' | 'frame', saved: readonly number[] | null): Promise<MeasuredImage | null>`.

- `saved === null` — measure. `kind 'image'`: find the image by URL, record `scrollLeft/scrollTop` of its ancestor chain
  (`parentElement` up to the root) as a flat list, `scrollIntoView({block:'nearest', inline:'nearest'})`, wait two animation
  frames, return `{ rect, dpr, saved, box }`. `kind 'frame'` (run in the top frame): find the `<iframe>` whose `src` equals
  the clicked `frameUrl`; no scrolling; same fields (`box` = `clientLeft/Top/Width/Height`).
- `saved !== null` — restore: find the same element, write the recorded scroll positions back, return `null`.
- Worker order for a frame click (`frameId ≠ 0`): `frame`(record top baseline) → `image`(scrolls frame and, by propagation,
  its ancestors) → `frame`(rect after the scroll) → `captureVisibleTab` → crop → **always** (`finally`) `restore` for both.
  Unknown/ambiguous iframe (zero or several `src` matches), a frame that is not a direct child of the top frame, or a refused
  injection into either frame → step 3.
- Pure, unit-tested composition in `src/shared/capture.ts`: `frameRect(imageRect, frameView, iframeRect, iframeBox)` maps a
  rect from the frame viewport to the top viewport (iframe border and CSS scale) and clips it to the frame's visible box;
  `clipCropRect` then clips to the screenshot. An image larger than the viewport yields its visible part.

### 3.4 Result page and i18n

`CaptureEntry` gets `note?: 'whole-view'`. `result.html` gets `<p id="wholeNote" class="tip" data-i18n="wholeNote" hidden>`;
`app.ts` unhides it when the entry carries the note. One new message key `wholeNote` in all 55 locales (52 `.txt` sources +
3 aliases of `en`), hand-written per language, no digits (`check-locales`), added to `KEYS` in `build-locales.py`.

### 3.5 What does not change

`manifest.ts` (permissions, CSP), `messages.ts` (no new message type: everything stays inside the worker), `src/shared/core`,
`python/`, `store/`, `package.json`, version.

## 4. Part II — design

### 4.1 The open bypass and the choice

`fontsnap/dom-members` judges a member by where its symbol is declared. A DOM value stored in something typed by a
non-`lib.dom` type loses that: `interface A { host: string; click(): void }  const a: A = doc.querySelector('a')!;`.
Two ways were proposed. **Chosen: the second — in page code there are no types of its own**, made precise as "the
_definition sites_ of a non-library object type are closed" (new type-aware rule `fontsnap/page-types`, same files as
`dom-members`):

| closed site                                                                   | rule                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interface`                                                                   | only the names in the file's table (`MeasuredImage`) and only with the property names listed there, properties only (no methods, call or index signatures)                                                          |
| type literal, mapped type, `class` declaration/expression, `enum`             | refused                                                                                                                                                                                                             |
| type reference                                                                | must resolve to a library type (`lib.*.d.ts`), a type parameter, a name of the file's table, or an `import type` name of the file's table that resolves to the file listed there (`Rect` → `src/shared/capture.ts`) |
| object literal (this is how a type is _inferred_: default parameter, `[{…}]`) | only as the 2nd argument of `Object.assign(el.style, …)`, or when its contextual type is a library type or a table type; otherwise refused                                                                          |

Why not the first way (flow check "DOM value → non-DOM type" on annotation/argument/return/`satisfies`): it must model every
assignability site, including the ones with no annotation at all (a default parameter `f(a = {host:'', click(){}})` then
`f(el)`; `list.push(el)` on an array inferred from a literal; callback parameters, which are contravariant). Closing the places
where such a type can be _born_ closes all of those by construction, and the code of the page needs only `MeasuredImage` and
`Rect` (the brief's own count) plus library types. The cost — writing an own type in page code is a deliberate edit of one
table in `eslint.config.js` — is the same deliberate-edit contract as `DOM_MEMBERS`.

### 4.2 The exception for Part I (explicit and narrow)

- `PAGE_PROCESS_GLOBS` and the guard-context list (`scripts/lib/guards.ts`) gain `src/background/load-image.ts`.
- Lint: in that file, and only there, `new Image()` (no arguments, `NewExpression` only), `<x>.crossOrigin = 'anonymous'`
  (literal) and **one** `<x>.src = <first parameter of loadImagePixels>` are allowed. The `src` write is checked by
  `dom-members` (a new per-file option: a member written only from the first parameter of the named function, at most once, as
  an expression statement); every other page-process selector (`LOADING_NAMES`, `setAttribute`, `createElement` = `div` only,
  computed access, casts, …) stays. `GLOBAL_ACCESS` gets `Image`, `OffscreenCanvas` (already global), `btoa`,
  `String.fromCharCode` for this file only.
- `INJECTED_FUNCTIONS = ['measureImage', 'loadImagePixels']`; `func` must be one of those identifiers; `world` stays refused;
  `frameIds` is allowed inside `target`.
- verify-dist: `injectedFunctions` entries are de-duplicated by text; the build must hand over **exactly two distinct**
  functions. A body may contain `new Image`, `.crossOrigin = "anonymous"` and `.src = <its first parameter>` at most once each
  and only the one body that has them is the loader; _every other_ forbidden pattern (`fetch`, `Request`, `location`,
  `setAttribute`, further `.src =`, …) fails for both bodies; two loaders, or a loader with a second `Image`, fail.

### 4.3 The other forms listed in the brief

Blocks E and F and the two nits of the Tester @ `0fe04ad` are verified on `main` by the existing fixtures `E1…F4`, `T1`, `T2`,
`O1…O81` and the `injectedFunctions` tests (destructured alias, reassigned `func`, `.call/.apply`). They are re-run, not
rewritten. New fixtures for the r4308642691 forms and their relatives (one per form, each must fail in `OVERLAY`, in a new
`src/select/` file, and in `measure.ts`/`load-image.ts` where it applies): own `interface` + `querySelector('a')` host/click;
own type literal as parameter annotation; `createElementNS('style')` through an own type with runtime text; `ownerDocument.createElementNS`
in `measure.ts` through an own type; own type as return type; `satisfies`; default-parameter inference; array inferred from
a literal + `push`; class with the members of an element; mapped type; `import type` of a name not on the table; an
interface declared with a method or a non-listed property. Plus accept fixtures: the real `measure.ts`, `load-image.ts`
and `overlay.ts`.

### 4.4 Snapshots and docs

`tests/guard-snapshots/*.json` are regenerated with `npm run guards:update` once, at the end, and the diff is read and
explained (expected: `eslint.json` — new rule, new file in the page-process list, new selectors; maybe `tooling.json`
unchanged). `README.md` ("Recipes"/page-code section) and `AGENTS.md` are updated where they describe
the one injected function.

## 5. Tests (behaviour changes need a test that fails without the change)

- Unit (`tests/unit/background.test.ts`, new `clicked.test.ts`, `capture.test.ts`): the three-step ladder with stubs (each
  fallback trigger), `frameIds` of the injection, restore called in `finally`, data: unchanged, entry `note`.
- Unit for the page functions with fake `document`/`Image`/`OffscreenCanvas` (`measureImage` kinds; `loadImagePixels`
  tainted → CORS reload → null).
- Unit for `frameRect` (scale, border, clipping), DPR 1 and 2 through `clipCropRect`.
- Lint fixtures (4.3), `wasm-scan` tests for two-function/loader exception cases, `dist.test` build cases, locale tests.
- e2e `tests/e2e/clicked-image.spec.ts` (context-menu click through the undocumented `onClicked.dispatch`, as
  `transparent.spec.ts` does): same site, image taller than the viewport, other origin with CORS (step 1) and without CORS
  (step 2, proves only the image reached the analysis and top-1 equals the upload of the same file), below the fold with text
  around, same-origin and cross-origin iframe (image served by the iframe's origin, and a non-CORS image inside the
  frame), DPR 1 and 2 (`deviceScaleFactor` via CDP emulation), scroll position restored, fallback to step 3 with the hint.
- Regression: `npm run test:regression` and `tests/e2e/identify.spec.ts` unchanged.

## 6. Known limits, to state in the report

- With the `activeTab` grant alone, Chrome gives script access to the origin of the tab; a **cross-origin** frame is likely
  _not_ scriptable without a host permission, so in production steps 1–2 are expected to fall through to step 3 for such a
  frame. The e2e build has the loopback host permission, so e2e proves the logic, not the grant. Reported as a deviation/risk.
- Frame offset is computed for direct children of the top frame only; deeper nesting → step 3.
- Page zoom handled through `devicePixelRatio`; CSS transforms on the iframe only as a uniform scale.
