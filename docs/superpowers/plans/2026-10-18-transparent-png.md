# Transparent PNG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transparent pixels are composited over white in JS and Python so black-on-transparent PNGs are recognised like black-on-white.

**Architecture:** `fromRGBA` and a new Python `to_rgb` apply the same integer rule; canvases at the two capture sites are filled white before `drawImage`. Nothing else in the pipeline changes.

**Tech Stack:** TypeScript, vitest, Playwright, pngjs, Python (numpy, Pillow, pytest).

**Spec:** `docs/superpowers/specs/2026-10-18-transparent-png-design.md`

## Global Constraints

- `c' = round((c*a + 255*(255-a))/255)`, computed as `floor((c*a + 255*(255-a) + 127)/255)`; a=255 leaves bytes unchanged.
- No new permissions, no locale texts, no change to model, pipeline arithmetic, `store/`, guard snapshots.
- `src/` globals go through the `GLOBAL_ACCESS` allowlist in `eslint.config.js`; do not add globals.
- Python venv: `/tmp/pyenv-fs/bin/python` (deps from `python/requirements.txt`).
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. No push.

## Review Focus

- Semi-transparent edge pixels (antialiased glyphs, 0<a<255) blend, not snap to black/white → exact table test over all (c, a).
- Opaque images unchanged byte for byte → identity test (JS) and `to_rgb == convert("RGB")` (Python); realset3 regression.
- Palette PNG with `tRNS` / grayscale+alpha in Python → `to_rgb` test with `P`+transparency and `LA`.
- A fully transparent image (all a=0) → white image, "no text" status, no crash.
- Downscaled big transparent image (> MAX_SIDE) still composites on white → white fill precedes `drawImage`.

---

### Task 1: `fromRGBA` composites over white

**Files:**

- Modify: `src/shared/core/image.ts:13-21`
- Test: `tests/unit/core.test.ts` (next to the existing `fromRGBA` test, line ~115)

**Interfaces:** Produces `fromRGBA(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Img` (signature unchanged).

- [ ] **Step 1: Write failing tests** in `core.test.ts`, describe `fromRGBA alpha`:
      `(0,0,0,0)→[255,255,255]`; `(0,0,0,255)→[0,0,0]`; `(10,20,30,255)→[10,20,30]`; `(0,0,0,128)→[127,127,127]`; `(255,0,0,64)→[255,191,191]`; a loop over all c in 0..255 and a in 0..255 asserting equality with `Math.round((c*a + 255*(255-a))/255)`.
- [ ] **Step 2:** `npx vitest run tests/unit/core.test.ts` → the new tests FAIL.
- [ ] **Step 3:** In `fromRGBA`, read alpha at `j+3`; when 255 copy as before, otherwise apply the integer rule per channel (`Math.floor((c*a + 255*(255-a) + 127)/255)`). Keep `atU8` accessors.
- [ ] **Step 4:** same command → PASS. Also `npx vitest run tests/unit/regression.test.ts`.
- [ ] **Step 5:** commit `fix: composite RGBA over white in fromRGBA`.

### Task 2: White fill at the capture sites

**Files:**

- Modify: `src/result/app.ts` (`fromBlob`, ~line 98), `src/background/shot.ts` (`cropToDataUrl`, ~line 38)
- Test: `tests/unit/result-app.test.ts` (canvas stub at ~line 87), `tests/unit/background.test.ts` + `tests/unit/helpers/image-apis.ts` (`FakeOffscreenCanvas.getContext`)

**Interfaces:** Consumes nothing new. Produces: both sites call `ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height)` before `drawImage`.

- [ ] **Step 1: Write failing tests.** Stubs record an ordered call log: add `fillRect` and a `fillStyle` setter to the `getContext` stub in `result-app.test.ts` and to `FakeOffscreenCanvas` (log `fill` entries in a `fills` array returned by `installImageApis`, ordered with `draws`). Assertions: after a file pick, the canvas log is `[fill #ffffff 0,0,W,H, draw]` in that order; same for `cropToDataUrl` (fill covers `sized.width × sized.height`).
- [ ] **Step 2:** `npx vitest run tests/unit/result-app.test.ts tests/unit/background.test.ts` → FAIL.
- [ ] **Step 3:** In both sites get the 2D context once (`if (!ctx) …` keeping the current optional style), fill white over the full canvas, then draw.
- [ ] **Step 4:** same command → PASS; then `npx vitest run` for the whole unit suite.
- [ ] **Step 5:** commit `fix: fill capture canvases with white before drawImage`.

### Task 3: Python `to_rgb`

**Files:**

- Modify: `python/fontsnap_ref/pipeline.py` (new `to_rgb`, used in `prep` line 88), `python/fontsnap_ref/textcrop.py` (lines 38 `text_lines`), `python/fontsnap_ref/evaluate.py:47`, `tests/make_fixtures.py:22`
- Test: `tests/python/test_reference.py`

**Interfaces:** Produces `to_rgb(pil: Image.Image) -> Image.Image` (mode `RGB`). Alpha modes (`RGBA`, `LA`, `PA`, `RGBa`, `La`, `P`/`L`/`RGB` with `"transparency"` in `info`) → `convert("RGBA")`, integer rule in numpy (int32), `Image.fromarray(..., "RGB")`; any other image → `pil.convert("RGB")`.

- [ ] **Step 1: Write failing tests:** RGBA `(0,0,0,0)`→white, `(0,0,0,255)`→black, `(0,0,0,128)`→127, `(255,0,0,64)`→`(255,191,191)`; full table equality vs `round((c*a+255*(255-a))/255)` via an RGBA image holding all (c,a) pairs; opaque RGBA equals `convert("RGB")`; `P` image with `info["transparency"]` and an `LA` image; black text on transparent RGBA gives `len(text_lines(img)[1]) == len(text_lines(same_on_white)[1])` and identical `prep` output.
- [ ] **Step 2:** `/tmp/pyenv-fs/bin/python -m pytest tests/python/test_reference.py -q` (cwd `python`-aware via `tests/python/conftest.py`) → FAIL.
- [ ] **Step 3:** implement `to_rgb`; replace `pil.convert("RGB")` in `prep` and `img.convert("RGB")` at `textcrop.py:38` (import from `.pipeline` only if no circular import, else define in `textcrop.py` and import it in `pipeline.py`); `evaluate.py` and `make_fixtures.py` use it too.
- [ ] **Step 4:** pytest → PASS; `ruff check python tests` clean.
- [ ] **Step 5:** commit `fix(python): composite alpha over white in the reference loader`.

### Task 4: E2E and full verification

**Files:**

- Create: `tests/e2e/transparent.spec.ts`
- Modify: `README.md` (one line in the Tests section: transparent PNGs are composited over white; list the new spec)

- [ ] **Step 1: Write the e2e test.** Helper builds with `pngjs` a PNG of black text on transparent (draw glyph-like blocks big enough for `textLines`, or render text on a page canvas via `page.evaluate` + `OffscreenCanvas.convertToBlob`) and the same picture on white. Tests: (a) file input: transparent and white give no `.err` status, ≥1 result card, and equal first `.name`; (b) handoff: `serviceWorker.evaluate` stores `{dataUrl}` under a `cap_<uuid>` key, open `openResultPage(context, extensionId, '#'+id)`, same assertions; (c) fully transparent image: status is the "no lines" text, no crash.
- [ ] **Step 2:** Run against the unfixed code first via `git stash`-free way: temporarily `git checkout 877f8a8 -- src` is not needed; instead run the test now to confirm it FAILs on the transparent case only if Tasks 1-2 are reverted — verify by running `npx playwright test tests/e2e/transparent.spec.ts` after `npm run build:e2e` on a scratch commit of the pre-fix tree is too costly; accept the unit tests as the red/green evidence and run the e2e green here.
- [ ] **Step 3:** `npm run build:e2e && npx playwright test tests/e2e/transparent.spec.ts` (under `xvfb-run -a`) → PASS.
- [ ] **Step 4: Full verification:** `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e:auto`; Python: `python -m fontsnap_ref.evaluate` (venv) then `npm run test:regression` → metrics 59.3/77.9 and 45.6/69.6, parity ≥ threshold, 263 images; compare `out/js_node_realset3.json` preds with a pre-change run for identity.
- [ ] **Step 5:** commit `test(e2e): transparent PNG gives the same top-1 as on white` (+ README).
