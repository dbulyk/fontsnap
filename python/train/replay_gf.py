"""Google Fonts replay bytes for old classifier rows (ofl-v1 negatives).

meta.json maps each of the 3665 shipped classes to a family; most are in Google
Fonts. We pull a static latin-400 cut from the Fontsource jsDelivr CDN (same host
pattern as phase-1 downloads) and cache it under out/font-cache by content sha256.
One regular cut per family is enough: old head rows stay frozen, and CE on these
images only has to push *new* rows down on old-looking features.

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

from train.cache import HashMismatch, cache_root, read_verified, store_bytes
from train.model import BASE_CLASSES
from train.paths import MODEL_DIR, assert_under_out
from train.registry import sha256_hex

_CDN = "https://cdn.jsdelivr.net/fontsource/fonts/{family}@latest/latin-400-normal.ttf"
_UA = "fontsnap-train/0 (ofl-v1 replay; +https://github.com/dbulyk/fontsnap)"
_SLUG = re.compile(r"[^a-z0-9]+")
# Parallel fetch keeps cold calibrate/train setup inside the pod watchdog.
_FETCH_WORKERS = 8
_FETCH_TIMEOUT_SECONDS = 20


@lru_cache(maxsize=1)
def _meta() -> dict:
    path = MODEL_DIR / "meta.json"
    return json.loads(path.read_text(encoding="utf-8"))


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
    """Map old class index → font bytes for every in-GF class that downloads."""
    indices = range(BASE_CLASSES) if class_indices is None else class_indices
    class_to_family: dict[int, str] = {}
    families: list[str] = []
    seen: set[str] = set()
    for class_index in indices:
        family = family_for_class(class_index)
        if family is None:
            continue
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
