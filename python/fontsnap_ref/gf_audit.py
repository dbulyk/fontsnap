"""Audit families missing from gf_meta.json against Google Fonts and write python/data/gf_extra.json.

gf_meta.json (fonts.google.com/metadata/fonts snapshot) is also the popularity source for the ranker, so it is
kept frozen. Some families served by the Google Fonts CSS API are not listed there (e.g. Pushster, Thabit,
Big Shoulders *). For every model family absent from gf_meta.json this script looks up the family in the
google/fonts repo (METADATA.pb: name, category) and checks that fonts.googleapis.com/css2 serves it.
Only display name / category / inGF are taken from gf_extra.json; popularity rank is unchanged.

Usage: python -m fontsnap_ref.gf_audit  (needs network)
"""

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from .pipeline import DATA, Families, nz

TREE = "https://api.github.com/repos/google/fonts/git/trees/main?recursive=1"
RAW = "https://raw.githubusercontent.com/google/fonts/main/"
CSS = "https://fonts.googleapis.com/css2?family="
CATS = {"SANS_SERIF": "Sans Serif", "SERIF": "Serif", "DISPLAY": "Display", "HANDWRITING": "Handwriting", "MONOSPACE": "Monospace"}
NOT_A_FONT = {"adobeblank"}  # served, but renders nothing


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode()


def served(name):
    try:
        _get(CSS + urllib.parse.quote(name))
        return True
    except urllib.error.HTTPError:
        return False


def audit():
    f = Families()
    missing = [x for x in f.fams if x not in f.gf]
    tree = json.loads(_get(TREE))["tree"]
    bydir = {}
    for t in tree:
        if t["path"].endswith("/METADATA.pb"):
            bydir.setdefault(nz(t["path"].split("/")[-2]), t["path"])

    def one(fam):
        if fam not in bydir:
            return None
        pb = _get(RAW + bydir[fam])
        name = re.search(r'^name: "(.*)"', pb, re.M).group(1)
        cat = CATS.get(re.search(r'^category: "(.*)"', pb, re.M).group(1), "")
        ok = fam not in NOT_A_FONT and served(name)
        return fam, {"family": name, "category": cat if ok else "", "inGF": ok, "source": bydir[fam]}

    with ThreadPoolExecutor(16) as ex:
        res = dict(r for r in ex.map(one, missing) if r)
    return dict(sorted(res.items()))


if __name__ == "__main__":
    out = audit()
    json.dump(out, open(DATA / "gf_extra.json", "w"), indent=1, ensure_ascii=False)
    print(f"{sum(v['inGF'] for v in out.values())} served / {len(out)} found in google/fonts")
