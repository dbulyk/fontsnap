"""Build extension/model/meta.json (families, display names, popularity ranks, merge rules) from python/data."""

import json

from .pipeline import KEEP_NOTO, MERGE, ROOT, Families, nz


def build():
    f = Families()
    disp = {}
    for c in f.classnames:
        raw = f.raw.get(c, c.split("-")[0].split("[")[0])
        disp.setdefault(nz(raw), raw)
    return {
        "fams": f.fams,
        "display": [f.gf[x]["family"] if x in f.gf else disp.get(x, x) for x in f.fams],
        "inGF": [x in f.gf for x in f.fams],
        "category": [f.gf[x]["category"] if x in f.gf else "" for x in f.fams],
        "rank": [int(r) for r in f.rank],
        "classFam": f.class_fam.tolist(),
        "merge": MERGE,
        "keepNoto": list(KEEP_NOTO),
    }


if __name__ == "__main__":
    json.dump(build(), open(ROOT / "extension" / "model" / "meta.json", "w"), separators=(",", ":"))
