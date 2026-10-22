"""ofl-v1 step B: which old classes get GF replay bytes, and how the fonts arrive."""

from __future__ import annotations

import hashlib
import io
import json
import threading
import time
import urllib.error
from pathlib import Path

import pytest
import yaml

from train.paths import MODEL_DIR, ROOT
from train.recipe_defs import FONT_FETCH_SLACK_SECONDS
from train.replay_gf import fontsource_slug, load_replay_fonts, selected_replay_classes

META = json.loads((MODEL_DIR / "meta.json").read_text(encoding="utf-8"))
NAMES = yaml.safe_load((ROOT / "python" / "data" / "classes_v2.yaml").read_text(encoding="utf-8"))["classnames"]
GF_META = json.loads((ROOT / "python" / "data" / "gf_meta.json").read_text(encoding="utf-8"))["familyMetadataList"]
CDN_PREFIX = "https://cdn.jsdelivr.net/fontsource/fonts/"


def _sfnt(tag: str) -> bytes:
    # The replay fetch refuses anything shorter than 100 bytes or without sfnt magic.
    return b"\x00\x01\x00\x00" + tag.encode().ljust(120, b".")


def _slug_of(url: str) -> str:
    assert url.startswith(CDN_PREFIX), url
    return url[len(CDN_PREFIX) :].split("@", 1)[0]


def _slug_of_class(class_index: int) -> str:
    return fontsource_slug(str(META["display"][int(META["classFam"][class_index])]))


def _family_members(display: str) -> list[int]:
    fam = META["display"].index(display)
    return [i for i, f in enumerate(META["classFam"]) if f == fam]


class _Body:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self, *_args) -> bytes:
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeCdn:
    """Stands in for urlopen in train.replay_gf; records every request."""

    def __init__(self, failures: dict[str, BaseException | bytes] | None = None, delay=None) -> None:
        self.failures = failures or {}
        self.delay = delay
        self.calls: list[tuple[str, object]] = []
        self.headers: list[dict[str, str]] = []
        self._lock = threading.Lock()

    def __call__(self, request, timeout=None):
        url = request.full_url
        with self._lock:
            self.calls.append((url, timeout))
            self.headers.append(dict(request.header_items()))
        slug = _slug_of(url)
        if self.delay is not None:
            time.sleep(self.delay(slug))
        outcome = self.failures.get(slug)
        if isinstance(outcome, BaseException):
            raise outcome
        if isinstance(outcome, bytes):
            return _Body(outcome)
        return _Body(_sfnt(slug))


@pytest.fixture
def out_dir(tmp_path, monkeypatch):
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    return tmp_path


@pytest.mark.parametrize(
    ("display", "base", "sibling"),
    [
        # A sibling family's -Regular must not beat the base family's upright variable face.
        ("Yaldevi", "Yaldevi[wght]", "YaldeviColombo-Regular"),
        # UI cuts of Noto ship their own -Regular; the latin-400 file is the base face.
        ("Noto Sans Devanagari", "NotoSansDevanagari[wdth,wght]", "NotoSansDevanagariUI-Regular"),
        ("Noto Sans Gujarati", "NotoSansGujarati[wdth,wght]", "NotoSansGujaratiUI-Regular"),
        # Static Regular wins over the italic variable face of the same family.
        ("Roboto", "Roboto-Regular", "Roboto-Italic[wdth,wght]"),
    ],
)
def test_selection_keeps_the_base_face_of_each_family(display, base, sibling):
    members = _family_members(display)
    assert sibling in [NAMES[i] for i in members]
    picked = [NAMES[i] for i in members if i in set(selected_replay_classes())]
    assert picked == [base]


def test_selection_gives_each_in_gf_family_at_most_one_class_and_skips_unclear_ones():
    chosen = selected_replay_classes()
    per_family: dict[int, int] = {}
    for class_index in chosen:
        fam = int(META["classFam"][class_index])
        assert META["inGF"][fam], NAMES[class_index]
        per_family[fam] = per_family.get(fam, 0) + 1
    assert set(per_family.values()) == {1}
    # Several cuts, none -Regular and none upright variable: no replay class.
    for display in ("Sunflower", "Thabit", "GFS Neohellenic"):
        members = _family_members(display)
        assert len(members) > 1
        assert not set(members) & set(chosen), display
    # A family that ships one cut keeps it even when it is not Regular.
    (buda,) = _family_members("Buda")
    assert NAMES[buda] == "Buda-Light"
    assert buda in chosen


def test_loader_drops_families_whose_latin_400_file_cannot_be_fetched(out_dir, monkeypatch):
    by_name = {entry["family"]: entry for entry in GF_META}
    failures: dict[str, BaseException | bytes] = {}
    for class_index in selected_replay_classes():
        entry = by_name.get(str(META["display"][int(META["classFam"][class_index])]))
        if entry is None or "latin" not in entry["subsets"] or "400" not in entry["fonts"]:
            slug = _slug_of_class(class_index)
            failures[slug] = urllib.error.HTTPError(f"{CDN_PREFIX}{slug}", 404, "Not Found", hdrs=None, fp=io.BytesIO())
    assert "buda" in failures  # only a 300 cut on Google Fonts
    assert "unifrakturcook" in failures  # only a 700 cut
    healthy = [slug for slug in map(_slug_of_class, selected_replay_classes()) if slug not in failures]
    failures[healthy[0]] = TimeoutError("read timed out")
    failures[healthy[1]] = b"<!doctype html>" + b" " * 200
    failures[healthy[2]] = urllib.error.URLError("connection reset")
    cdn = FakeCdn(failures)
    monkeypatch.setattr("train.replay_gf.urlopen", cdn)

    fonts = load_replay_fonts(fetch=True, root=out_dir / "cache")

    expected = {}
    for class_index in selected_replay_classes():
        slug = _slug_of_class(class_index)
        if slug not in failures:
            expected[class_index] = _sfnt(slug)
    assert fonts == expected
    assert len(fonts) == len(selected_replay_classes()) - len(failures)


def test_parallel_fetch_result_does_not_depend_on_completion_order(out_dir, monkeypatch):
    subset = range(0, 600)

    def uneven(slug: str) -> float:
        # Per-family delays so threads finish out of submission order.
        return 0.004 * (1.0 - (hashlib.sha256(slug.encode()).digest()[0] / 255.0))

    serial = FakeCdn()
    monkeypatch.setattr("train.replay_gf.urlopen", serial)
    one_worker = load_replay_fonts(fetch=True, root=out_dir / "serial", class_indices=subset, workers=1)

    parallel = FakeCdn(delay=uneven)
    monkeypatch.setattr("train.replay_gf.urlopen", parallel)
    eight_workers = load_replay_fonts(fetch=True, root=out_dir / "parallel", class_indices=subset, workers=8)

    assert eight_workers == one_worker
    assert list(eight_workers) == sorted(eight_workers)
    assert set(eight_workers) == set(selected_replay_classes(subset))
    # One request per family, never one per class.
    urls = [url for url, _timeout in parallel.calls]
    assert len(urls) == len(set(urls)) == len(eight_workers)


def test_every_fetch_has_a_bounded_timeout_inside_the_setup_slack(out_dir, monkeypatch):
    cdn = FakeCdn()
    monkeypatch.setattr("train.replay_gf.urlopen", cdn)
    fonts = load_replay_fonts(fetch=True, root=out_dir / "cache", class_indices=range(0, 80))
    assert fonts
    assert cdn.calls
    for url, timeout in cdn.calls:
        assert url.endswith("@latest/latin-400-normal.ttf"), url
        assert isinstance(timeout, (int, float))
        assert 0 < timeout <= FONT_FETCH_SLACK_SECONDS
    assert all(any(k.lower() == "user-agent" for k in headers) for headers in cdn.headers)


def test_cached_replay_fonts_load_again_without_network(out_dir, monkeypatch):
    subset = range(0, 120)
    monkeypatch.setattr("train.replay_gf.urlopen", FakeCdn())
    first = load_replay_fonts(fetch=True, root=out_dir / "cache", class_indices=subset)
    assert first

    def offline(*_args, **_kwargs):
        raise AssertionError("network")

    monkeypatch.setattr("train.replay_gf.urlopen", offline)
    assert load_replay_fonts(fetch=False, root=out_dir / "cache", class_indices=subset) == first
    assert load_replay_fonts(fetch=True, root=out_dir / "cache", class_indices=subset) == first
    # Nothing cached for a fresh root and no network: every family is dropped, no crash.
    assert load_replay_fonts(fetch=False, root=out_dir / "empty", class_indices=subset) == {}


def _ofl_records(count: int):
    from dataclasses import replace

    from train.registry import load_manifest

    picked = []
    urls: set[str] = set()
    for rec in load_manifest():
        if rec.download is None or "#" in rec.download.url or rec.download.url in urls:
            continue
        urls.add(rec.download.url)
        picked.append(rec)
        if len(picked) == count:
            break
    assert len(picked) == count
    stamped = [replace(rec, file_sha256=hashlib.sha256(_sfnt(rec.download.url)).hexdigest()) for rec in picked]
    # Two classes that share one file: fetched once.
    stamped[1] = replace(stamped[1], file_sha256=stamped[0].file_sha256)
    return tuple(stamped)


class FakeOrigin:
    """Stands in for urllib.request.urlopen used by train.inventory.read_url."""

    def __init__(self, missing: frozenset[str] = frozenset()) -> None:
        self.missing = missing
        self.calls: list[tuple[str, object]] = []
        self._lock = threading.Lock()

    def __call__(self, request, timeout=None):
        url = request.full_url
        with self._lock:
            self.calls.append((url, timeout))
        # Uneven delays so threads finish out of submission order.
        time.sleep(0.002 * (len(url) % 7))
        if url in self.missing:
            raise urllib.error.HTTPError(url, 404, "Not Found", hdrs=None, fp=io.BytesIO())
        return _Body(_sfnt(url))


def _ofl_env(tmp_path: Path, monkeypatch, records) -> Path:
    cache = tmp_path / "font-cache"
    cache.mkdir()
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(cache))
    monkeypatch.setattr("train.registry.load_manifest", lambda *_a, **_k: records)
    return cache


def test_ofl_fetch_downloads_each_unique_font_once_and_caches_it(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    from train.cache import read_verified
    from train.dataset import make_ofl_loader

    records = _ofl_records(12)
    cache = _ofl_env(tmp_path, monkeypatch, records)
    origin = FakeOrigin()
    monkeypatch.setattr("urllib.request.urlopen", origin)

    loader = make_ofl_loader(batch_size=4, per_class_new=1, per_class_replay=0, num_workers=0, shuffle=False, fetch_fonts=True)

    urls = sorted(url for url, _timeout in origin.calls)
    assert urls == sorted(rec.download.url for i, rec in enumerate(records) if i != 1)
    assert all(isinstance(t, (int, float)) and t > 0 for _url, t in origin.calls)
    for rec in records:
        assert read_verified(rec.file_sha256, cache)[:4] == b"\x00\x01\x00\x00"
    assert len(loader.dataset) == len(records)


def test_ofl_fetch_failure_stops_the_loader(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    from train.dataset import make_ofl_loader

    records = _ofl_records(6)
    _ofl_env(tmp_path, monkeypatch, records)
    gone = records[4].download.url
    monkeypatch.setattr("urllib.request.urlopen", FakeOrigin(missing=frozenset({gone})))

    with pytest.raises(RuntimeError, match="404"):
        make_ofl_loader(batch_size=4, per_class_new=1, per_class_replay=0, num_workers=0, shuffle=False, fetch_fonts=True)
