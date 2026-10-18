"""Build model/meta.json (families, display names, popularity ranks, merge rules) from python/data."""

import json

from .pipeline import DATA, KEEP_NOTO, MERGE, ROOT, Families, nz


def build():
    f = Families()
    extra = json.load(open(DATA / "gf_extra.json"))  # families served by Google Fonts but absent from gf_meta.json

    def name(x):
        if x in f.gf:
            return f.gf[x]["family"]
        return extra[x]["family"] if x in extra else disp.get(x, x)

    disp = {}
    for c in f.classnames:
        raw = f.raw.get(c, c.split("-")[0].split("[")[0])
        disp.setdefault(nz(raw), raw)
    return {
        "fams": f.fams,
        "display": [name(x) for x in f.fams],
        "inGF": [x in f.gf or extra.get(x, {}).get("inGF", False) for x in f.fams],
        "category": [f.gf[x]["category"] if x in f.gf else extra.get(x, {}).get("category", "") for x in f.fams],
        "rank": [int(r) for r in f.rank],
        "classFam": f.class_fam.tolist(),
        "merge": MERGE,
        "keepNoto": list(KEEP_NOTO),
    }


if __name__ == "__main__":
    json.dump(build(), open(ROOT / "model" / "meta.json", "w"), separators=(",", ":"))
