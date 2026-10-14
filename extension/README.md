# FontSnap: AI Font Identifier from Image — Chrome extension (MV3)
Load unpacked: chrome://extensions → Developer mode → Load unpacked → this folder.
Use: toolbar icon (Alt+Shift+F) or context menu → drag over text → result tab with top-5 Google Fonts families + live previews.
Restricted pages (chrome://, Web Store) open upload mode: paste / drop / choose an image.
- lib/fontsnap-core.js — JS port of textcrop.crop_normalize (pack/crop), prep (INTER_AREA, white pad 320, ImageNet norm), family
  aggregation (mapping v2b), popularity prior rank^-0.5, near-duplicate family merge, top-5. Pure JS, also runs in Node.
- model/model_fp16.onnx (round2, base storia/font-classify-onnx MIT), model/meta.json (families, display names, popularity ranks).
- ort/ — onnxruntime-web 1.30.0 WASM (MIT). Inference fully on-device; only font names go to fonts.googleapis.com for previews.
Parity tests: /workspace/fontsnap-ext-work (py_eval.py, py_score.py, js_eval.mjs [onnxruntime-node], js_eval_web.mjs [onnxruntime-web WASM], chrome_test.mjs [headless Chromium with the extension]).
