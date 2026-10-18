"""Reference inference pipeline: preprocessing, ONNX inference, family aggregation, popularity prior, family merge."""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path

import cv2
import numpy as np
import yaml

from .image import to_rgb
from .textcrop import crop_normalize

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "python" / "data"
MODEL = ROOT / "model" / "model_fp16.onnx"
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)

# near-duplicate families shown as one result (must match meta.json "merge"/"keepNoto")
MERGE = {
    "intertight": "inter",
    "ibmplexsanskr": "ibmplexsans",
    "ibmplexsanscondensed": "ibmplexsans",
    "robotoflex": "roboto",
    "robotocondensed": "roboto",
    "opensanscondensed": "opensans",
    "notosansdisplay": "notosans",
}
KEEP_NOTO = (
    "notosanssc",
    "notosanstc",
    "notosanshk",
    "notosansjp",
    "notosanskr",
    "notosansarabic",
    "notosansdevanagari",
    "notosansmono",
    "notosansthai",
    "notosanshebrew",
)


def nz(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def merge_family(f: str) -> str:
    if f.startswith("notosans") and not f.startswith(KEEP_NOTO):
        return "notosans"
    return MERGE.get(f, f)


class Families:
    """Class index -> family index (mapping v2b) and popularity ranks."""

    def __init__(self, data: Path = DATA):
        self.classnames = yaml.safe_load(open(data / "classes_v2.yaml"))["classnames"]
        with open(data / "google_fonts_mapping_v2b.tsv") as fh:
            rows = list(csv.reader(fh, delimiter="\t"))[1:]
        self.raw = {r[0]: r[1] for r in rows}
        fam = [nz(self.raw.get(c, c.split("-")[0].split("[")[0])) for c in self.classnames]
        self.fams = sorted(set(fam))
        idx = {f: i for i, f in enumerate(self.fams)}
        self.class_fam = np.array([idx[f] for f in fam])
        gf = json.load(open(data / "gf_meta.json"))["familyMetadataList"]
        self.gf = {nz(m["family"]): m for m in gf}
        self.rank = np.array([self.gf[f].get("popularity", 3000) if f in self.gf else 3000 for f in self.fams], float)

    def rank_families(self, probs_list, alpha=0.5, merge=True, k=5):
        p = np.mean(probs_list, 0)
        fp = np.bincount(self.class_fam, weights=p.astype(float), minlength=len(self.fams))
        if alpha:
            fp = fp * self.rank**-alpha
        top = [self.fams[i] for i in np.argsort(-fp, kind="stable")[:40]]
        if merge:
            out = []
            for f in map(merge_family, top):
                if f not in out:
                    out.append(f)
            top = out
        return top[:k]


def prep(pil, size=320):
    im = np.array(to_rgb(pil))[:1024, :1024]
    h, w = im.shape[:2]
    r = size / max(h, w)
    nw, nh = max(1, int(w * r)), max(1, int(h * r))
    im = cv2.resize(im, (nw, nh), interpolation=cv2.INTER_AREA if r < 1 else cv2.INTER_LINEAR)
    dw, dh = size - nw, size - nh
    im = cv2.copyMakeBorder(im, dh // 2, dh - dh // 2, dw // 2, dw - dw // 2, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    return ((im.astype(np.float32) / 255 - MEAN) / STD).transpose(2, 0, 1)[None]


def softmax(lg):
    lg = np.asarray(lg, np.float64)
    p = np.exp(lg - lg.max())
    return p / p.sum()


class Model:
    def __init__(self, path: Path = MODEL, threads: int = 0):
        import onnxruntime as ort

        so = ort.SessionOptions()
        if threads:
            so.intra_op_num_threads = threads
        self.s = ort.InferenceSession(str(path), so, providers=["CPUExecutionProvider"])
        self.name = self.s.get_inputs()[0].name

    def probs(self, x):
        return softmax(self.s.run(None, {self.name: x.astype(np.float32)})[0][0])


def predict_variants(model: Model, pil, variants=("pack", "crop")):
    return {v: model.probs(prep(crop_normalize(pil, v))).astype(np.float32) for v in variants}
