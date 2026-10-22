"""Google Fonts replay bytes for old classifier rows (ofl-v1 negatives).

meta.json maps each of the 3665 shipped classes to a family; most are in Google
Fonts. We pull a static latin-400 cut from the Fontsource jsDelivr CDN (same host
pattern as phase-1 downloads) and cache it under out/font-cache by content sha256.

One latin-400 file matches one Regular (or upright variable) class per family.
Replay keeps that single class index so CE and softplus train the backbone toward
the cut that was actually rendered, not Bold/Light/Italic siblings.

Fontsource package ids are kebab-case (open-sans), not the compressed fam keys in
meta.json (opensans). Slugs come from meta display names.
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import yaml

from train.cache import HashMismatch, cache_root, read_verified, store_bytes
from train.model import BASE_CLASSES
from train.paths import MODEL_DIR, ROOT, assert_under_out
from train.registry import sha256_hex

_CDN = "https://cdn.jsdelivr.net/fontsource/fonts/{family}@latest/latin-400-normal.ttf"
_UA = "fontsnap-train/0 (ofl-v1 replay; +https://github.com/dbulyk/fontsnap)"
_SLUG = re.compile(r"[^a-z0-9]+")
_COMPACT = re.compile(r"[^a-z0-9]")
_CLASSES_YAML = ROOT / "python" / "data" / "classes_v2.yaml"
# Parallel fetch keeps cold calibrate/train setup inside the pod watchdog.
_FETCH_WORKERS = 8
_FETCH_TIMEOUT_SECONDS = 20


@lru_cache(maxsize=1)
def _meta() -> dict:
    path = MODEL_DIR / "meta.json"
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _classnames() -> tuple[str, ...]:
    blob = yaml.safe_load(_CLASSES_YAML.read_text(encoding="utf-8"))
    names = tuple(str(x) for x in blob["classnames"])
    if len(names) != BASE_CLASSES:
        raise RuntimeError(f"classnames length {len(names)} != BASE_CLASSES {BASE_CLASSES}")
    return names


def fontsource_slug(display_name: str) -> str:
    """Display 'Open Sans' → Fontsource package id 'open-sans'."""
    slug = _SLUG.sub("-", display_name.lower().strip()).strip("-")
    if not slug or not slug.replace("-", "").isalnum():
        raise ValueError(f"bad family display: {display_name!r}")
    return slug


def family_for_class(class_index: int) -> str | None:
    """Fontsource package id for a shipped class, or None when not in Google Fonts."""
    if not 0 <= class_index < BASE_CLASSES:
        raise ValueError(class_index)
    meta = _meta()
    fam_index = int(meta["classFam"][class_index])
    if not meta["inGF"][fam_index]:
        return None
    return fontsource_slug(str(meta["display"][fam_index]))


def _compact(name: str) -> str:
    return _COMPACT.sub("", name.lower())


def _face_stem(classname: str) -> str:
    """Family stem of a class id: strip -Regular or a variable-axis suffix."""
    if classname.endswith("-Regular"):
        return classname[: -len("-Regular")]
    if "[" in classname:
        return classname.split("[", 1)[0]
    return classname


def regular_class_for_family(fam_index: int, members: list[int]) -> int | None:
    """Class index whose face matches latin-400-normal, or None when none is clear.

    Prefer a cut whose compact stem equals the family key so SC/UI/Display
    siblings do not take the base family's latin-400 file.
    """
    if not members:
        return None
    names = _classnames()
    fam_key = _compact(str(_meta()["fams"][fam_index]))

    def stem_matches(class_index: int) -> bool:
        return _compact(_face_stem(names[class_index])) == fam_key

    def shortest(candidates: list[int]) -> int:
        return sorted(candidates, key=lambda i: (len(names[i]), i))[0]

    exact = [i for i in members if names[i].endswith("-Regular")]
    match_exact = [i for i in exact if stem_matches(i)]
    if match_exact:
        return shortest(match_exact)
    upright_var = [i for i in members if "[" in names[i] and "Italic" not in names[i] and "Oblique" not in names[i]]
    match_var = [i for i in upright_var if stem_matches(i)]
    if match_var:
        return shortest(match_var)
    if exact:
        return shortest(exact)
    if upright_var:
        return shortest(upright_var)
    if len(members) == 1:
        return members[0]
    return None


def selected_replay_classes(class_indices: range | None = None) -> tuple[int, ...]:
    """Old class indices that share the loader's one-Regular-per-family rule (pre-fetch)."""
    indices = range(BASE_CLASSES) if class_indices is None else class_indices
    meta = _meta()
    by_family: dict[int, list[int]] = {}
    for class_index in indices:
        if not 0 <= class_index < BASE_CLASSES:
            continue
        fam_index = int(meta["classFam"][class_index])
        if not meta["inGF"][fam_index]:
            continue
        by_family.setdefault(fam_index, []).append(class_index)
    chosen: list[int] = []
    for fam_index, members in by_family.items():
        class_index = regular_class_for_family(fam_index, members)
        if class_index is not None:
            chosen.append(class_index)
    return tuple(sorted(chosen))


def gf_font_url(family: str) -> str:
    if not family or "/" in family or ".." in family or not family.replace("-", "").isalnum():
        raise ValueError(f"bad family slug: {family!r}")
    return _CDN.format(family=family)


def _family_pointer(family: str, root: Path) -> Path:
    return assert_under_out(root) / "gf-family" / f"{family}.sha256"


def _download(url: str) -> bytes:
    req = Request(url, headers={"User-Agent": _UA})
    with urlopen(req, timeout=_FETCH_TIMEOUT_SECONDS) as resp:
        data = resp.read()
    if len(data) < 100 or data[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf"):
        raise RuntimeError(f"not an sfnt at {url}")
    return data


def load_gf_font(family: str, root: Path | None = None, *, fetch: bool = True) -> bytes:
    """Return cached font bytes for a GF family slug; fetch when missing."""
    cache = cache_root() if root is None else assert_under_out(root)
    ptr = _family_pointer(family, cache)
    if ptr.is_file():
        try:
            return read_verified(ptr.read_text(encoding="utf-8").strip(), cache)
        except (FileNotFoundError, HashMismatch, ValueError):
            ptr.unlink(missing_ok=True)
    if not fetch:
        raise FileNotFoundError(f"gf replay font missing for {family}")
    data = _download(gf_font_url(family))
    digest = sha256_hex(data)
    store_bytes(digest, data, cache)
    ptr.parent.mkdir(parents=True, exist_ok=True)
    ptr.write_text(digest + "\n", encoding="utf-8")
    return data


def load_replay_fonts(
    *,
    fetch: bool = True,
    root: Path | None = None,
    class_indices: range | None = None,
    workers: int = _FETCH_WORKERS,
) -> dict[int, bytes]:
    """Map one Regular-class index per in-GF family → latin-400 font bytes."""
    meta = _meta()
    class_to_family: dict[int, str] = {}
    families: list[str] = []
    seen: set[str] = set()
    for class_index in selected_replay_classes(class_indices):
        fam_index = int(meta["classFam"][class_index])
        family = fontsource_slug(str(meta["display"][fam_index]))
        class_to_family[class_index] = family
        if family not in seen:
            seen.add(family)
            families.append(family)

    family_bytes: dict[str, bytes] = {}
    if families:
        # Cached hits are cheap; misses download in parallel (B8 / N20).
        def one(family: str) -> tuple[str, bytes | None]:
            try:
                return family, load_gf_font(family, root, fetch=fetch)
            except (OSError, RuntimeError, ValueError, HTTPError, URLError, HashMismatch, FileNotFoundError):
                return family, None

        pool = max(1, min(workers, len(families)))
        with ThreadPoolExecutor(max_workers=pool) as executor:
            futs = [executor.submit(one, family) for family in families]
            for fut in as_completed(futs):
                family, payload = fut.result()
                if payload is not None:
                    family_bytes[family] = payload

    out: dict[int, bytes] = {}
    for class_index, family in class_to_family.items():
        payload = family_bytes.get(family)
        if payload is not None:
            out[class_index] = payload
    return out
