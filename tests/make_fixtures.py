"""Regenerate tests/fixtures/textcrop.json from the Python reference (cv2) for JS parity unit tests.
cd python && python ../tests/make_fixtures.py"""

import csv
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from fontsnap_ref.image import to_rgb  # noqa: E402
from fontsnap_ref.pipeline import prep  # noqa: E402
from fontsnap_ref.textcrop import _otsu, crop_normalize, text_lines  # noqa: E402

rows = list(csv.DictReader(open(ROOT / "data/realset3/labels.csv")))
imgs = [rows[i]["image"] for i in (0, 7, 42, 99, 150, 201, 262)]
out = {"images": [], "ellipse": {}, "otsu": []}
for im in imgs:
    pil = to_rgb(Image.open(ROOT / "data/realset3/images" / im))
    norm, lines = text_lines(pil)
    e = {"image": im, "lines": [list(map(int, b)) for b in lines]}
    for v in ("pack", "crop"):
        c = np.array(crop_normalize(pil, v).convert("L"))
        x = prep(crop_normalize(pil, v))
        e[v] = {"shape": list(c.shape), "mean": float(c.mean()), "prepMean": float(x.mean()), "prepStd": float(x.std())}
    out["images"].append(e)
for k in (9, 15, 31, 61):
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    out["ellipse"][k] = [int(r.sum() // 2) for r in ker]
rng = np.random.default_rng(0)
for _ in range(5):
    v = np.concatenate([rng.normal(60, 15, 500), rng.normal(190, 20, 800)]).clip(0, 255).astype(np.uint8)
    out["otsu"].append({"values": v.tolist(), "t": float(_otsu(v))})
json.dump(out, open(ROOT / "tests/fixtures/textcrop.json", "w"))
print("ok", len(out["images"]))
