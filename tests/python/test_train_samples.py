import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from train.cache import cache_path, catalog_digests, read_verified, store_bytes, verify
from train.cache import main as cache_main
from train.dataset import FontSnapSynth, prepared_chw
from train.paths import OUT
from train.render import render_sample
from train.samples import (
    BACKGROUNDS,
    BG_BY_ID,
    SHIPPED_CLASS_COUNT,
    SPLIT_SPAN,
    TEXT_BY_ID,
    TEXTS,
    Split,
    SyntheticSampleSpec,
    assert_disjoint,
    build_specs,
    head_index,
    spec_fits,
    specs_from_jsonl,
    specs_to_jsonl,
)
from train.samples import (
    main as samples_main,
)

ROOT = Path(__file__).resolve().parents[2]


class _Record:
    def __init__(self, subsets):
        self.subsets = subsets


def _groups(n_classes=3, per_class=2):
    return {split: build_specs(n_classes=n_classes, split=split, per_class=per_class) for split in Split}


def test_splits_are_disjoint_in_seed_text_and_background():
    groups = _groups()
    assert_disjoint(groups)
    seeds = {split: {spec.seed for spec in specs} for split, specs in groups.items()}
    text_ids = {split: {spec.text_id for spec in specs} for split, specs in groups.items()}
    bg_ids = {split: {spec.bg_id for spec in specs} for split, specs in groups.items()}
    strings = {
        split: {next(entry.text for entry in TEXTS if entry.text_id == spec.text_id) for spec in specs} for split, specs in groups.items()
    }
    names = list(groups)
    for i, left in enumerate(names):
        for right in names[i + 1 :]:
            assert seeds[left].isdisjoint(seeds[right])
            assert text_ids[left].isdisjoint(text_ids[right])
            assert bg_ids[left].isdisjoint(bg_ids[right])
            assert strings[left].isdisjoint(strings[right])
    for specs in groups.values():
        got = [spec.seed for spec in specs]
        assert len(got) == len(set(got))


def test_banks_keep_each_split_separate():
    for split in Split:
        assert any(entry.split == split and entry.script == "latin" for entry in TEXTS)
        assert any(bg.split == split for bg in BACKGROUNDS)
    text_ids = [entry.text_id for entry in TEXTS]
    assert len(text_ids) == len(set(text_ids))
    assert len({entry.text for entry in TEXTS}) == len(TEXTS)
    assert len({bg.bg_id for bg in BACKGROUNDS}) == len(BACKGROUNDS)


def test_build_specs_is_deterministic_and_uses_the_published_bases():
    train = build_specs(n_classes=2, split=Split.TRAIN, per_class=2)
    assert train == build_specs(n_classes=2, split="train", per_class=2)
    assert [spec.seed for spec in train] == [0, 1, 2, 3]
    assert [(spec.text_id, spec.bg_id) for spec in train] == [(0, 0), (1, 0), (0, 0), (1, 0)]
    hold = build_specs(n_classes=1, split=Split.SYNTH_HOLDOUT, per_class=1)
    replay = build_specs(n_classes=1, split=Split.REPLAY, per_class=1)
    assert hold[0].seed == 1_000_000_000
    assert hold[0].text_id == 100
    assert hold[0].bg_id == 10
    assert replay[0].seed == 2_000_000_000
    assert replay[0].text_id == 200
    assert replay[0].bg_id == 20
    assert head_index(train[0]) == SHIPPED_CLASS_COUNT
    assert head_index(train[2]) == SHIPPED_CLASS_COUNT + 1


def _is_dark(rgb: tuple[int, int, int]) -> bool:
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] < 128


def test_text_and_background_cycle_independently():
    specs = build_specs(n_classes=1, split=Split.TRAIN, per_class=4)
    text_ids = [entry.text_id for entry in TEXTS if entry.split == Split.TRAIN and entry.script == "latin"]
    bg_ids = [bg.bg_id for bg in BACKGROUNDS if bg.split == Split.TRAIN]
    pairs = [(spec.text_id, spec.bg_id) for spec in specs]
    assert pairs == [
        (text_ids[0], bg_ids[0]),
        (text_ids[1], bg_ids[0]),
        (text_ids[0], bg_ids[1]),
        (text_ids[1], bg_ids[1]),
    ]
    product = build_specs(n_classes=1, split=Split.TRAIN, per_class=len(text_ids) * len(bg_ids))
    assert {(spec.text_id, spec.bg_id) for spec in product} == {(text_id, bg_id) for text_id in text_ids for bg_id in bg_ids}


def test_train_and_holdout_mix_light_and_dark():
    for split in (Split.TRAIN, Split.SYNTH_HOLDOUT):
        bank = {_is_dark(bg.rgb) for bg in BACKGROUNDS if bg.split == split}
        assert bank == {True, False}
        specs = build_specs(n_classes=1, split=split, per_class=8)
        used = {_is_dark(BG_BY_ID[spec.bg_id].rgb) for spec in specs}
        assert used == {True, False}


def test_cyrillic_ids_are_used_when_subsets_allow():
    class _Cyr:
        subsets = ("latin", "cyrillic")

    specs = build_specs(n_classes=1, split=Split.TRAIN, per_class=6, records=(_Cyr(),))
    scripts = {TEXT_BY_ID[spec.text_id].script for spec in specs}
    assert "cyrillic" in scripts
    assert "latin" in scripts
    latin_only = build_specs(n_classes=1, split=Split.TRAIN, per_class=6, records=(_Record(("latin",)),))
    assert {TEXT_BY_ID[spec.text_id].script for spec in latin_only} == {"latin"}
    cjk = build_specs(n_classes=1, split=Split.TRAIN, per_class=8, records=(_Record(("latin", "cjk")),))
    assert "cjk" in {TEXT_BY_ID[spec.text_id].script for spec in cjk}
    hangul = build_specs(n_classes=1, split=Split.SYNTH_HOLDOUT, per_class=8, records=(_Record(("hangul", "latin")),))
    assert "hangul" in {TEXT_BY_ID[spec.text_id].script for spec in hangul}


def test_shared_text_id_is_rejected():
    train = build_specs(n_classes=1, split=Split.TRAIN, per_class=1)
    hold = build_specs(n_classes=1, split=Split.SYNTH_HOLDOUT, per_class=1)
    stolen = SyntheticSampleSpec(0, train[0].text_id, hold[0].bg_id, hold[0].seed, Split.SYNTH_HOLDOUT)
    with pytest.raises(ValueError):
        assert_disjoint({Split.TRAIN: train, Split.SYNTH_HOLDOUT: (stolen,)})


def test_seed_span_is_rejected_before_building():
    with pytest.raises(ValueError):
        build_specs(n_classes=SPLIT_SPAN, split=Split.TRAIN, per_class=2)
    with pytest.raises(ValueError):
        build_specs(n_classes=1, split=Split.TRAIN, per_class=0)


def test_spec_fits_checks_script_and_split():
    spec = build_specs(n_classes=1, split=Split.TRAIN, per_class=1)[0]
    assert spec_fits(_Record(("latin",)), spec) is True
    assert spec_fits(_Record(("cyrillic",)), spec) is False
    assert spec_fits(_Record("latin"), spec) is False
    cyr = SyntheticSampleSpec(0, 2, 0, 0, Split.TRAIN)
    assert spec_fits(_Record(("cyrillic",)), cyr) is True
    mixed = SyntheticSampleSpec(0, 100, 0, 1_000_000_000, Split.SYNTH_HOLDOUT)
    assert spec_fits(_Record(("latin",)), mixed) is False


def test_manifest_record_raises_when_font_bytes_are_missing(monkeypatch):
    from train.registry import load_manifest

    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(OUT / "font-cache-pytest-missing"))
    records = load_manifest()
    specs = build_specs(n_classes=1, split=Split.TRAIN, per_class=1, records=(records[0],))
    dataset = FontSnapSynth(specs, (records[0],))
    assert len(dataset) == 1
    with pytest.raises(FileNotFoundError, match="font bytes"):
        dataset[0]


def test_file_sha256_is_loaded_instead_of_the_default_font(monkeypatch):
    payload = b"not a font"
    digest = hashlib.sha256(payload).hexdigest()
    root = OUT / "font-cache-pytest" / f"wiring-{os.getpid()}"
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(root))
    try:
        store_bytes(digest, payload, root)

        class _Rec:
            class_id = "Demo-Regular"
            file_sha256 = digest
            download = object()
            subsets = ("latin",)

        specs = build_specs(n_classes=1, split=Split.TRAIN, per_class=1, records=(_Rec(),))
        dataset = FontSnapSynth(specs, (_Rec(),))
        with pytest.raises(OSError):
            dataset[0]
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_real_records_use_cjk_and_hangul_banks_and_construct():
    from train.registry import load_manifest

    records = load_manifest()
    lxgw = next(rec for rec in records if rec.family_id == "lxgw-wenkai")
    pretendard = next(rec for rec in records if rec.family_id == "pretendard")
    assert "cjk" in lxgw.subsets and "latin" in lxgw.subsets
    assert "hangul" in pretendard.subsets and "latin" in pretendard.subsets
    cjk_specs = build_specs(n_classes=1, split=Split.TRAIN, per_class=8, records=(lxgw,))
    hangul_specs = build_specs(n_classes=1, split=Split.TRAIN, per_class=8, records=(pretendard,))
    assert "cjk" in {TEXT_BY_ID[spec.text_id].script for spec in cjk_specs}
    assert "hangul" in {TEXT_BY_ID[spec.text_id].script for spec in hangul_specs}
    specs = build_specs(n_classes=len(records), split=Split.TRAIN, per_class=1, records=records)
    dataset = FontSnapSynth(specs, records)
    from train.registry import PHASE1_CLASSES

    assert len(dataset) == PHASE1_CLASSES


def test_dataset_rejects_a_record_whose_subsets_omit_latin():
    specs = build_specs(n_classes=1, split=Split.TRAIN, per_class=1)
    with pytest.raises(ValueError, match="does not fit"):
        FontSnapSynth(specs, records=(_Record(("cyrillic",)),))
    held = FontSnapSynth(specs, records=(_Record(("latin",)),))
    assert len(held) == 1
    with pytest.raises(ValueError, match="outside"):
        FontSnapSynth(build_specs(n_classes=2, split=Split.TRAIN, per_class=1), records=(_Record(("latin",)),))


def test_sample_keys_round_trip_through_jsonl():
    specs = build_specs(n_classes=2, split=Split.SYNTH_HOLDOUT, per_class=2)
    assert specs_from_jsonl(specs_to_jsonl(specs)) == specs
    key = specs[0].as_key()
    assert tuple(key) == (0, 100, 10, 1_000_000_000, "synth_holdout")
    with pytest.raises(ValueError):
        specs_from_jsonl('{"class_index": 0, "text_id": 0, "bg_id": 0, "seed": 0, "split": "nope"}\n')


def test_render_is_rgb_and_deterministic_without_a_font_file():
    specs = build_specs(n_classes=1, split=Split.TRAIN, per_class=2)
    first = render_sample(specs[0])
    second = render_sample(specs[1])
    assert first.mode == "RGB"
    assert first.tobytes() == render_sample(specs[0]).tobytes()
    assert first.tobytes() != second.tobytes()
    hold = render_sample(build_specs(n_classes=1, split=Split.SYNTH_HOLDOUT, per_class=1)[0])
    assert abs(int(np.asarray(first).mean()) - int(np.asarray(hold).mean())) > 20
    with pytest.raises(OSError):
        render_sample(specs[0], b"not a font")
    with pytest.raises(ValueError, match="font bytes"):
        render_sample(specs[0], instance=(("wght", 400.0),))


def test_prepared_chw_is_the_prep_tensor():
    spec = build_specs(n_classes=1, split=Split.TRAIN, per_class=1)[0]
    chw = prepared_chw(spec)
    other = prepared_chw(build_specs(n_classes=1, split=Split.SYNTH_HOLDOUT, per_class=1)[0])
    assert chw.shape == (3, 320, 320)
    assert chw.dtype == np.float32
    assert np.isfinite(chw).all()
    assert float(np.abs(chw - other).mean()) > 0.01
    assert np.array_equal(chw, prepared_chw(spec))


def test_prepared_chw_textcrop_pack_differs_from_raw():
    """Evaluate pack/crop views via prepared_chw(textcrop=...)."""
    spec = build_specs(n_classes=1, split=Split.REPLAY, per_class=1)[0]
    raw = prepared_chw(spec)
    packed = prepared_chw(spec, textcrop="pack")
    cropped = prepared_chw(spec, textcrop="crop")
    assert packed.shape == raw.shape == cropped.shape
    assert not np.array_equal(raw, packed)
    assert not np.array_equal(packed, cropped)
    with pytest.raises(ValueError, match="textcrop"):
        prepared_chw(spec, textcrop="nope")


def test_fontsnap_synth_stays_on_raw_synth_prep(monkeypatch):
    """Evidence (r6): pack/crop on CE pool hurt realset3; new-class stays raw."""
    pytest.importorskip("torch")
    seen: list[str | None] = []

    def _fake_prepared(s, font_bytes=None, *, instance=(), textcrop=None):
        seen.append(textcrop)
        return np.zeros((3, 320, 320), dtype=np.float32)

    monkeypatch.setattr("train.dataset.prepared_chw", _fake_prepared)
    dataset = FontSnapSynth(build_specs(n_classes=1, split=Split.TRAIN, per_class=1))
    _ = dataset[0]
    assert seen == [None]


def test_constructing_a_dataset_does_not_import_torch():
    script = """
import sys
from pathlib import Path
sys.path.insert(0, str(Path("python").resolve()))
import train.dataset
from train.samples import Split, build_specs
specs = build_specs(n_classes=1, split=Split.TRAIN, per_class=1)
ds = train.dataset.FontSnapSynth(specs)
assert len(ds) == 1
assert "torch" not in sys.modules
"""
    proc = subprocess.run([sys.executable, "-c", script], cwd=ROOT, capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr


def test_getitem_returns_a_tensor_when_torch_is_installed():
    torch = pytest.importorskip("torch")
    specs = build_specs(n_classes=2, split=Split.TRAIN, per_class=1)
    dataset = FontSnapSynth(specs)
    tensor, label = dataset[0]
    assert isinstance(tensor, torch.Tensor)
    assert tuple(tensor.shape) == (3, 320, 320)
    assert tensor.dtype == torch.float32
    assert label == SHIPPED_CLASS_COUNT
    from train.dataset import make_loader

    loader = make_loader(n_classes=2, split=Split.TRAIN, per_class=1, batch_size=2)
    batch, labels = next(iter(loader))
    assert loader.num_workers == 0
    assert tuple(batch.shape) == (2, 3, 320, 320)
    assert labels.tolist() == [SHIPPED_CLASS_COUNT, SHIPPED_CLASS_COUNT + 1]


def test_make_loader_passes_records_so_cyrillic_appears():
    pytest.importorskip("torch")
    from collections import Counter

    from train.dataset import make_loader
    from train.registry import load_manifest

    records = load_manifest()
    loader = make_loader(n_classes=len(records), split="train", per_class=50, batch_size=4, records=records)
    scripts = Counter(TEXT_BY_ID[spec.text_id].script for spec in loader.dataset.specs)
    assert scripts["cyrillic"] > 0
    assert scripts["latin"] > 0
    assert scripts["cjk"] > 0
    assert scripts["hangul"] > 0


def test_fetch_stores_cas_bytes_the_loader_can_read(monkeypatch):
    from dataclasses import replace

    from train.cache import cache_path
    from train.dataset import _font_of
    from train.fetch import _fetch_one
    from train.registry import load_manifest

    base = next(r for r in load_manifest() if r.class_id == "AMDAL-Regular")
    root = OUT / "font-cache-pytest" / f"fetch-{os.getpid()}"
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(root))
    payload = b"\x00\x01\x00\x00" + b"fake-sfnt-bytes"
    digest = hashlib.sha256(payload).hexdigest()
    rec = replace(base, file_sha256=digest)
    monkeypatch.setattr("train.fetch.read_font_bytes", lambda _url: payload)
    try:
        assert _fetch_one(rec, root) == digest
        assert cache_path(digest, root).is_file()
        assert read_verified(digest, root) == payload
        data, _instance = _font_of(rec)
        assert data == payload
        report = verify((digest,), root)
        assert report == {"catalog": 1, "missing": 0, "mismatched": 0}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_adwaita_weight_instances_render_distinct_glyphs(monkeypatch):
    pytest.importorskip("fontTools")
    from dataclasses import replace

    from train import render as render_mod
    from train.registry import load_manifest

    records = load_manifest()
    thin = next(r for r in records if r.class_id == "AdwaitaSans-Thin")
    black = next(r for r in records if r.class_id == "AdwaitaSans-Black")
    assert thin.file_sha256 == black.file_sha256
    assert thin.instance == (("wght", 100.0),)
    assert black.instance == (("wght", 900.0),)
    # Offline: one shared CAS payload; instantiate maps wght → different static faces.
    payload = _box_ttf(stem=10)
    digest = hashlib.sha256(payload).hexdigest()
    thin = replace(thin, file_sha256=digest)
    black = replace(black, file_sha256=digest)
    faces = {100.0: _box_ttf(stem=40), 900.0: _box_ttf(stem=400)}

    def instantiate(_data: bytes, instance: tuple[tuple[str, float], ...]) -> bytes:
        weight = dict(instance)["wght"]
        return faces[weight]

    monkeypatch.setattr(render_mod, "_instantiate", instantiate)
    root = OUT / "font-cache-pytest" / f"adwaita-{os.getpid()}"
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(root))
    store_bytes(digest, payload, root)
    import train.samples as samples_mod
    from train.samples import TextEntry

    alphabet = TextEntry(0, Split.TRAIN, "latin", "AAAA")
    monkeypatch.setattr(samples_mod, "TEXT_BY_ID", {**samples_mod.TEXT_BY_ID, 0: alphabet})
    monkeypatch.setattr(render_mod, "TEXT_BY_ID", samples_mod.TEXT_BY_ID)
    spec = SyntheticSampleSpec(class_index=0, text_id=0, bg_id=0, seed=0, split=Split.TRAIN)
    thin_pil = render_sample(spec, read_verified(digest), instance=thin.instance)
    black_pil = render_sample(spec, read_verified(digest), instance=black.instance)
    assert thin_pil.get_flattened_data() != black_pil.get_flattened_data()


def _box_ttf(*, stem: int) -> bytes:
    import io

    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    order = [".notdef", *letters]
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({ord(ch): ch for ch in letters})
    glyphs = {}
    metrics = {}
    for name in order:
        thick = 50 if name == ".notdef" else stem
        pen = TTGlyphPen(None)
        pen.moveTo((0, 0))
        pen.lineTo((0, 700))
        pen.lineTo((thick, 700))
        pen.lineTo((thick, 0))
        pen.closePath()
        glyphs[name] = pen.glyph()
        metrics[name] = (thick + 50, 0)
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": "TestFace", "styleName": f"w{stem}"})
    fb.setupOS2()
    fb.setupPost()
    buf = io.BytesIO()
    fb.save(buf)
    return buf.getvalue()


def test_cache_stores_bytes_only_when_the_hash_matches(tmp_path):
    payload = b"font-bytes"
    digest = hashlib.sha256(payload).hexdigest()
    root = OUT / "font-cache-pytest" / str(os.getpid())
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    try:
        with pytest.raises(ValueError):
            store_bytes(digest, b"other", root)
        assert not cache_path(digest, root).exists()
        with pytest.raises(ValueError, match="out/"):
            store_bytes(digest, payload, tmp_path)
        dest = store_bytes(digest, payload, root)
        assert dest == cache_path(digest, root)
        assert dest.parent.name == digest[:2]
        assert read_verified(digest, root) == payload
        assert store_bytes(digest, payload, root) == dest
        assert not dest.with_name(dest.name + ".partial").exists()
        dest.write_bytes(b"corrupt")
        with pytest.raises(ValueError):
            read_verified(digest, root)
        report = verify((digest,), root)
        assert report == {"catalog": 1, "missing": 0, "mismatched": 1}
        missing = verify((hashlib.sha256(b"absent").hexdigest(),), root)
        assert missing["missing"] == 1
        assert missing["mismatched"] == 0
        with pytest.raises(ValueError):
            cache_path("abc", root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_catalog_digests_reads_file_sha256(monkeypatch):
    digest = "ab" * 32

    class _Rec:
        file_sha256 = digest.upper()

    class _Empty:
        file_sha256 = ""

    monkeypatch.setattr("train.registry.load_manifest", lambda: (_Rec(), _Empty()))
    assert catalog_digests() == (digest,)


def test_samples_cli_prints_disjoint_counts(capsys):
    assert samples_main(["--split", "synth_holdout", "--per-class", "2", "--classes", "3", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "split=synth_holdout" in out
    assert "classes=3" in out
    assert "specs=6" in out
    assert "disjoint=ok" in out
    assert "dry_run=1" in out
    assert samples_main(["--split", "holdout", "--classes", "1"]) == 2


def test_samples_cli_uses_manifest_length_when_classes_is_omitted(capsys):
    from train.registry import PHASE1_CLASSES

    assert samples_main(["--split", "train", "--per-class", "2", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "split=train" in out
    assert f"classes={PHASE1_CLASSES}" in out
    assert f"specs={PHASE1_CLASSES * 2}" in out
    assert "disjoint=ok" in out
    assert "dry_run=1" in out


def test_samples_cli_falls_back_to_phase1_count(monkeypatch, capsys):
    from train.registry import PHASE1_CLASSES

    def boom():
        raise OSError("manifest missing")

    monkeypatch.setattr("train.registry.load_manifest", boom)
    assert samples_main(["--per-class", "1", "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert f"classes={PHASE1_CLASSES}" in out
    assert f"specs={PHASE1_CLASSES}" in out


def test_train_main_dispatches_samples_and_cache(capsys, monkeypatch):
    monkeypatch.setattr("train.cache.catalog_digests", lambda: ())
    from train.__main__ import main

    assert main(["samples", "--classes", "1", "--per-class", "1", "--dry-run"]) == 0
    assert "specs=1" in capsys.readouterr().out
    assert main(["cache", "--verify"]) == 0
    report = capsys.readouterr().out
    assert "catalog=0" in report
    assert "mismatched=0" in report


def test_cache_cli_does_not_open_a_url(monkeypatch):
    def boom(*_args, **_kwargs):
        raise AssertionError("network")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    monkeypatch.setattr("train.cache.catalog_digests", lambda: ())
    assert cache_main(["--verify"]) == 0


def test_render_result_is_a_new_image():
    spec = build_specs(n_classes=1, split=Split.TRAIN, per_class=1)[0]
    canvas = render_sample(spec)
    assert isinstance(canvas, Image.Image)
    assert canvas.getpixel((0, 0)) == (255, 255, 255)
