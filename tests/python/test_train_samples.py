"""Sample specs, render, cache, and the on-the-fly dataset. No font files."""

import hashlib
import os
import shutil
import subprocess
import sys
import types
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
    SHIPPED_CLASS_COUNT,
    SPLIT_SPAN,
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
    assert [(spec.text_id, spec.bg_id) for spec in train] == [(0, 0), (1, 1), (0, 0), (1, 1)]
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


def test_catalog_digests_reads_registry_sha256(monkeypatch):
    digest = "ab" * 32

    class _Recipe:
        sha256 = digest.upper()

    class _Rec:
        recipe = _Recipe()

    module = types.ModuleType("train.registry")
    module.REGISTRY = (_Rec(),)
    monkeypatch.setitem(sys.modules, "train.registry", module)
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


def test_samples_cli_uses_registry_length_when_classes_is_omitted(monkeypatch, capsys):
    module = types.ModuleType("train.registry")
    module.REGISTRY = (object(), object(), object(), object())
    monkeypatch.setitem(sys.modules, "train.registry", module)
    assert samples_main(["--per-class", "1"]) == 0
    out = capsys.readouterr().out
    assert "classes=4" in out
    assert "specs=4" in out
    assert "dry_run=0" in out


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
