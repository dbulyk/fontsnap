from decimal import Decimal

import pytest

from train.loop import recipe
from train.model import BASE_CLASSES, NEW_HEAD_BIAS, expanded_classes
from train.recipe_defs import (
    ASSUMED_FLOOR_SAMPLES_PER_SEC,
    CALIBRATE_STEPS,
    OFL_V1_BATCH_SIZE,
    OFL_V1_PER_CLASS_NEW,
    OFL_V1_PER_CLASS_REPLAY,
    OFL_V1_REPLAY_REPEAT,
    OFL_V1_SUPPRESS_WEIGHT,
    TRAIN_SPEND_CAP_USD,
    ofl_v1_budget,
    projection_band,
    train_max_runtime_seconds,
)
from train.registry import PHASE1_CLASSES
from train.runpod import CALIBRATE, TRAIN, calibrate_spec, train_spec


def test_ofl_v1_and_calibrate_share_loader_shape():
    ofl = recipe("ofl-v1")
    cal = recipe("calibrate")
    assert ofl.batch_size == cal.batch_size == OFL_V1_BATCH_SIZE
    assert ofl.amp is cal.amp is True
    assert ofl.num_workers == cal.num_workers
    assert ofl.per_class_new == cal.per_class_new == OFL_V1_PER_CLASS_NEW
    assert ofl.per_class_replay == cal.per_class_replay == OFL_V1_PER_CLASS_REPLAY == 4
    assert ofl.replay_repeat == cal.replay_repeat == OFL_V1_REPLAY_REPEAT == 6
    assert ofl.freeze_backbone is cal.freeze_backbone is True
    assert ofl.distill_weight == cal.distill_weight > 0
    assert ofl.suppress_weight == cal.suppress_weight == OFL_V1_SUPPRESS_WEIGHT == 0.5
    assert ofl.num_classes == cal.num_classes == expanded_classes()
    assert ofl.device == cal.device == "cuda"
    assert cal.steps == CALIBRATE_STEPS
    assert ofl.total_samples == ofl_v1_budget().total_samples


def test_sample_budget_includes_gf_replay():
    budget = ofl_v1_budget()
    assert budget.new_classes == PHASE1_CLASSES
    assert budget.old_classes == BASE_CLASSES
    assert budget.replay_repeat == OFL_V1_REPLAY_REPEAT
    assert budget.replay_samples == BASE_CLASSES * OFL_V1_PER_CLASS_REPLAY * OFL_V1_REPLAY_REPEAT
    assert budget.total_samples == PHASE1_CLASSES * OFL_V1_PER_CLASS_NEW + budget.replay_samples == 240_792


def test_runpod_specs_derive_from_recipe_and_rate():
    budget = ofl_v1_budget()
    assert calibrate_spec().samples == CALIBRATE_STEPS * OFL_V1_BATCH_SIZE
    assert CALIBRATE.samples == CALIBRATE_STEPS * OFL_V1_BATCH_SIZE
    assert TRAIN.samples == budget.total_samples
    assert train_spec(Decimal("12")).max_runtime_seconds == train_max_runtime_seconds(budget.total_samples, Decimal("12"))
    assert TRAIN.spend_cap_usd == TRAIN_SPEND_CAP_USD
    band = projection_band(budget.total_samples)
    assert band["fits_17"] == Decimal(1)
    assert ASSUMED_FLOOR_SAMPLES_PER_SEC == Decimal("5")
    assert NEW_HEAD_BIAS == -80.0


def test_fontsource_slug_uses_display_kebab_case():
    from train.model import BASE_CLASSES
    from train.replay_gf import family_for_class, fontsource_slug

    assert fontsource_slug("Open Sans") == "open-sans"
    assert fontsource_slug("IBM Plex Sans") == "ibm-plex-sans"
    # meta fams are compressed; CDN package ids must keep hyphens from display.
    assert any(family_for_class(i) == "open-sans" for i in range(BASE_CLASSES))


def test_make_ofl_loader_replays_with_real_gf_bytes(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    payload = b"\x00\x01\x00\x00" + b"gf-replay"
    monkeypatch.setenv("FONTSNAP_SKIP_FETCH", "1")
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(tmp_path / "cache"))
    (tmp_path / "cache").mkdir()
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    monkeypatch.setattr("train.dataset.read_verified", lambda _sha, root=None: payload)
    monkeypatch.setattr(
        "train.replay_gf.load_replay_fonts",
        lambda **_kwargs: {i: payload for i in range(8)},
    )
    from PIL import ImageFont

    monkeypatch.setattr(
        "train.render._font",
        lambda _bytes, _size_px, _instance: ImageFont.load_default(),
    )
    from train.dataset import make_ofl_loader

    loader = make_ofl_loader(
        batch_size=4,
        per_class_new=1,
        per_class_replay=1,
        num_workers=0,
        shuffle=True,
        fetch_fonts=False,
    )
    labels = []
    for _inputs, batch_labels in loader:
        labels.extend(int(x) for x in batch_labels.tolist())
    assert any(label < BASE_CLASSES for label in labels), labels[:20]
    assert any(label >= BASE_CLASSES for label in labels), labels[:20]
