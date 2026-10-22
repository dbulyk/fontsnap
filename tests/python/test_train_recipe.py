from decimal import Decimal

from train.loop import recipe
from train.model import BASE_CLASSES, NEW_HEAD_BIAS, expanded_classes
from train.recipe_defs import (
    ASSUMED_FLOOR_SAMPLES_PER_SEC,
    CALIBRATE_STEPS,
    OFL_V1_BATCH_SIZE,
    OFL_V1_PER_CLASS_NEW,
    OFL_V1_PER_CLASS_REPLAY,
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
    assert ofl.per_class_replay == cal.per_class_replay == OFL_V1_PER_CLASS_REPLAY == 0
    assert ofl.freeze_backbone is cal.freeze_backbone is True
    assert ofl.num_classes == cal.num_classes == expanded_classes()
    assert ofl.device == cal.device == "cuda"
    assert cal.steps == CALIBRATE_STEPS
    assert ofl.total_samples == ofl_v1_budget().total_samples


def test_sample_budget_is_new_classes_only():
    budget = ofl_v1_budget()
    assert budget.new_classes == PHASE1_CLASSES
    assert budget.old_classes == BASE_CLASSES
    assert budget.replay_samples == 0
    assert budget.total_samples == PHASE1_CLASSES * OFL_V1_PER_CLASS_NEW == 152_832


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


def test_make_ofl_loader_refuses_fake_replay():
    import pytest

    pytest.importorskip("torch")
    from train.dataset import make_ofl_loader

    with pytest.raises(ValueError, match="refuses synthetic replay"):
        make_ofl_loader(
            batch_size=2,
            per_class_new=1,
            per_class_replay=1,
            num_workers=0,
            shuffle=False,
            fetch_fonts=False,
        )
