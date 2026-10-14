"""Evaluate the reference pipeline on a labelled set; writes metrics + per-image top-5 as JSON.
python -m fontsnap_ref.evaluate --set data/realset3 --out out/py_realset3.json"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

from PIL import Image

from .pipeline import ROOT, Families, Model, merge_family, nz, predict_variants

CONFIGS = {"bare": (("pack",), 0.0, False), "best": (("pack", "crop"), 0.5, True)}


def score(preds, labels):
    m = {}
    for c in CONFIGS:
        n = a1 = a5 = 0
        for im, lab in labels:
            t = preds[im][c]
            lb = merge_family(nz(lab)) if CONFIGS[c][2] else nz(lab)
            n += 1
            a1 += t[0] == lb
            a5 += lb in t[:5]
        m[c] = {"n": n, "top1": round(100 * a1 / n, 1), "top5": round(100 * a5 / n, 1)}
    return m


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--set", default=str(ROOT / "data" / "realset3"))
    ap.add_argument("--model", default=None)
    ap.add_argument("--out", default=str(ROOT / "out" / "py_realset3.json"))
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args(argv)
    d = Path(a.set)
    with open(d / "labels.csv", newline="") as fh:
        labels = [(r["image"], r["label"]) for r in csv.DictReader(fh)]
    if a.limit:
        labels = labels[: a.limit]
    fam, model = Families(), Model(Path(a.model)) if a.model else Model()
    preds = {}
    for im, _ in labels:
        p = predict_variants(model, Image.open(d / "images" / im).convert("RGB"))
        preds[im] = {c: fam.rank_families([p[v] for v in vs], al, mg) for c, (vs, al, mg) in CONFIGS.items()}
    res = {"metrics": score(preds, labels), "preds": preds}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(res, open(a.out, "w"))
    print(json.dumps(res["metrics"]))
    return res


if __name__ == "__main__":
    main()
