"""Build model/meta.json (families, display names, popularity ranks, merge rules) from python/data."""

import json

from .pipeline import DATA, KEEP_NOTO, MERGE, ROOT, Families, nz

# Bit positions for family subset masks. Unknown families use subsets=-1 (not 0: 0 means "known, empty").
SUBSET_NAMES = [
    "latin",
    "latin-ext",
    "vietnamese",
    "cyrillic",
    "greek",
    "arabic",
    "hebrew",
    "devanagari",
    "bengali",
    "tamil",
    "telugu",
    "gujarati",
    "kannada",
    "malayalam",
    "thai",
    "ethiopic",
    "japanese",
    "korean",
    "chinese-simplified",
    "chinese-traditional",
    "chinese-hongkong",
]
UNKNOWN_SUBSETS = -1


def build():
    f = Families()
    extra = json.load(open(DATA / "gf_extra.json"))  # families served by Google Fonts but absent from gf_meta.json
    bit = {name: 1 << i for i, name in enumerate(SUBSET_NAMES)}

    def name(x):
        if x in f.gf:
            return f.gf[x]["family"]
        return extra[x]["family"] if x in extra else disp.get(x, x)

    def script_of(x):
        if x not in f.gf:
            return ""
        return f.gf[x].get("primaryScript") or ""

    def subsets_of(x):
        if x not in f.gf:
            return UNKNOWN_SUBSETS
        mask = 0
        for s in f.gf[x].get("subsets") or []:
            if s in bit:
                mask |= bit[s]
        return mask

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
        "subsetNames": list(SUBSET_NAMES),
        "script": [script_of(x) for x in f.fams],
        "subsets": [subsets_of(x) for x in f.fams],
    }


if __name__ == "__main__":
    json.dump(build(), open(ROOT / "model" / "meta.json", "w"), separators=(",", ":"))
