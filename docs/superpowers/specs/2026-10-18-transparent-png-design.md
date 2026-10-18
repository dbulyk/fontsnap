# Transparent PNGs: composite over white

## Problem

`fromRGBA` (`src/shared/core/image.ts`) copies R, G, B and drops alpha. Canvases in `src/result/app.ts` (file, paste, drop,
context-menu image) and `src/background/shot.ts` (crop) are not filled before `drawImage`, so transparent pixels are
(0,0,0,0) and become black. Black text on a transparent background turns into a solid black image: no text lines, a wrong top-1.
The Python reference does `convert("RGB")`, which also drops alpha (RGBA → RGB keeps the stored RGB of transparent pixels).

## Intent and success criteria (from the ТЗ)

1. Unit: (0,0,0,0) → (255,255,255); (0,0,0,255) → (0,0,0); semi-transparent → blended.
2. E2E: a PNG with black text on a transparent background (file upload and the context-menu handoff) yields text lines and
   the same top-1 as the same picture on white.
3. realset3 unchanged (59.3/77.9, 45.6/69.6), JS↔Python 100%, 263 images in the minified build give the same output.
4. CI green; no tag/release. Model, pipeline arithmetic, permissions, locales, `store/` untouched.

## Design

- **Compositing rule** (non-premultiplied input, as `getImageData` and pngjs return): `c' = round((c·a + 255·(255−a)) / 255)`,
  computed in integers as `floor((c·a + 255·(255−a) + 127) / 255)`. 255 is odd, so the quotient never has a fractional part of
  exactly .5: the rounding is unambiguous and identical in JS and numpy. For a = 255 it is `c` exactly (bytes unchanged);
  for a = 0 it is 255.
- **`fromRGBA`**: applies the rule, with a fast path when `a === 255`. Used by `result/app.ts`, `scripts/eval/evaljs.ts`, tests.
- **Canvas capture sites**: `result/app.ts#fromBlob` and `background/shot.ts#cropToDataUrl` fill the canvas white before
  `drawImage` (the second also keeps a JPEG fallback from turning transparency black). `fromRGBA` stays as the safety net.
- **Python**: `to_rgb(pil)` in `fontsnap_ref/pipeline.py`. Images with alpha (modes RGBA, LA, PA, RGBa, La, or `P` with
  `transparency`) go through `convert("RGBA")` and the same integer rule in numpy; everything else keeps `convert("RGB")`.
  Used by `prep`, `text_lines`, `evaluate`, `tests/make_fixtures.py`.
- Not changed: the context-menu path (`imageToDataUrl`) forwards the original image bytes; the white background is applied
  on the result page where the image is drawn.

## Testing

- Unit (vitest): `fromRGBA` cases above, exact formula against a brute-force table over all (c, a), opaque identity;
  `result-app` test: canvas is filled white before the draw; `background` test: same for the crop canvas.
- Python (pytest): `to_rgb` same cases, equals the JS table values for a sample, opaque identity vs `convert("RGB")`,
  RGBA text image == the same on white in `text_lines`.
- E2E (`tests/e2e/transparent.spec.ts`): a PNG with black text is rendered by pngjs twice (transparent and on white); both
  via the file input and via the handoff the context menu produces (`data:` URL in `chrome.storage.session`, `#cap_<id>`) the result has
  text lines (no "no text" status) and the same top-1 as the white version.
- Regression: `npm run test:regression` against fresh Python results; `identify.spec.ts` (24 images, minified build) unchanged.

## Out of scope

Colour management, premultiplied handling beyond the formula, SVG, animated formats, any change to the model or recognition arithmetic.
