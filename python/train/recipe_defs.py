"""Single source of truth for the ofl-v1 fine-tune budget and RunPod sizing.

Sample budget (justification)
-----------------------------
The shipped head has 3665 faces from storia/font-classify-onnx. meta.json marks
most families as in Google Fonts; ofl-v1 pulls one latin-400 cut per family from
the Fontsource CDN (see train.replay_gf.selected_replay_classes).

Choice for ofl-v1 (round 7 / step B)
------------------------------------
- Train the 597 new OFL faces (real verified font bytes) **and** replay one
  Regular cut per GF family (PER_CLASS_REPLAY=4, repeated REPLAY_REPEAT=6
  times per epoch) so new head rows see enough CE negatives. SampleBudget.old_classes
  is len(selected_replay_classes()), not the full head size.
- **Partial unfreeze**: train classifier + blocks.5 + blocks.6 + conv_head.
  Earlier stages stay frozen. ONNX import folds BatchNorm into convs, so there
  is no BN to keep in train/eval. Head LR 1e-3; backbone LR 1e-4.
- Restore old head rows after each AdamW step (weight decay would move them
  with zeroed grads). Threat-only softplus on GF replay rows gathers the labeled
  old logit. Step A's public web bank failed on CPU for realset3 (~48.7/72.2);
  with unfreeze, GF softplus is the softplus source. Unthresholded logsumexp and
  LwF are gone.
- Init new head bias to -80 so new classes do not steal argmax at step 0.
- Batch 16 + AMP; num_workers=4. Font fetches run in parallel (8 workers);
  FONT_FETCH_SLACK_SECONDS is inside setup / max_runtime budgets.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

from train.paths import assert_under_out
from train.registry import PHASE1_CLASSES

OFL_V1_BATCH_SIZE = 16
OFL_V1_PER_CLASS_NEW = 256
OFL_V1_PER_CLASS_REPLAY = 4
# Concat-repeat the replay set each epoch so negatives ≈37% of steps.
OFL_V1_REPLAY_REPEAT = 6
OFL_V1_LR = 1e-3  # classifier head
OFL_V1_BACKBONE_LR = 1e-4  # unfrozen last blocks (10× below head)
OFL_V1_WEIGHT_DECAY = 1e-2
OFL_V1_NUM_WORKERS = 4
OFL_V1_AMP = True
OFL_V1_CHECKPOINT_EVERY = 500
# Train blocks.i for i >= this index, plus conv_head and classifier.
OFL_V1_UNFREEZE_FROM_BLOCK = 5
OFL_V1_NEW_BIAS = -80.0
OFL_V1_SUPPRESS_WEIGHT = 1.0
OFL_V1_SUPPRESS_MARGIN = 8.0
# Warm-up batches excluded from calibrate samples/sec (fetch/workers/compile).
# 8+64 keeps cudnn/AMP past the cold first steps; 16 timed steps overstated throughput.
CALIBRATE_WARMUP_STEPS = 8
CALIBRATE_STEPS = 64
ASSUMED_FLOOR_SAMPLES_PER_SEC = Decimal("5")
RTX_4090_USD_PER_HOUR = Decimal("0.89")
TRAIN_SPEND_CAP_USD = Decimal("17.00")
CALIBRATE_SPEND_CAP_USD = Decimal("1.00")
CALIBRATE_MAX_RUNTIME_SECONDS = 20 * 60
SETUP_SLACK_SECONDS = 20 * 60
# Parallel GF+OFL cold fetch (~1 min measured) plus headroom inside setup.
FONT_FETCH_SLACK_SECONDS = 3 * 60
# Leave room inside the watchdog for artifact send after train.
ARTIFACT_TRANSFER_SECONDS = 10 * 60
# Calibrate rate handover: runpodctl send waits for client receive (ACK) then self-deletes.
HANDOVER_ACK_SECONDS = 3 * 60


@dataclass(frozen=True, slots=True)
class SampleBudget:
    per_class_new: int
    per_class_replay: int
    replay_repeat: int
    new_classes: int
    old_classes: int

    @property
    def new_samples(self) -> int:
        return self.per_class_new * self.new_classes

    @property
    def replay_samples(self) -> int:
        return self.per_class_replay * self.old_classes * self.replay_repeat

    @property
    def total_samples(self) -> int:
        return self.new_samples + self.replay_samples


def ofl_v1_budget() -> SampleBudget:
    # Same pre-fetch class set as make_ofl_loader / load_replay_fonts (one cut per GF family).
    from train.replay_gf import selected_replay_classes

    return SampleBudget(
        per_class_new=OFL_V1_PER_CLASS_NEW,
        per_class_replay=OFL_V1_PER_CLASS_REPLAY,
        replay_repeat=OFL_V1_REPLAY_REPEAT,
        new_classes=PHASE1_CLASSES,
        old_classes=len(selected_replay_classes()),
    )


def ofl_v1_steps(batch_size: int = OFL_V1_BATCH_SIZE) -> int:
    return math.ceil(ofl_v1_budget().total_samples / batch_size)


def estimate_hours(samples: int, rate: Decimal) -> Decimal:
    if rate <= 0:
        raise ValueError("rate must be positive")
    return (Decimal(samples) / rate) / Decimal(3600)


def estimate_usd(samples: int, rate: Decimal, hourly: Decimal = RTX_4090_USD_PER_HOUR) -> Decimal:
    return estimate_hours(samples, rate) * hourly


def _setup_slack_seconds() -> int:
    return SETUP_SLACK_SECONDS + FONT_FETCH_SLACK_SECONDS


def estimate_train_usd(samples: int, rate: Decimal, hourly: Decimal = RTX_4090_USD_PER_HOUR) -> Decimal:
    """Compute + setup (incl. font fetch) + artifact transfer, for the >$17 refuse check."""
    slack = Decimal(_setup_slack_seconds() + ARTIFACT_TRANSFER_SECONDS) / Decimal(3600)
    return (estimate_hours(samples, rate) + slack) * hourly


def train_wall_seconds(samples: int, rate: Decimal) -> int:
    """Seconds the pod needs: epoch compute + setup/fetch slack + artifact send window."""
    if rate <= 0:
        raise ValueError("rate must be positive")
    compute = int(math.ceil(float(Decimal(samples) / rate)))
    return compute + _setup_slack_seconds() + ARTIFACT_TRANSFER_SECONDS


def train_max_runtime_seconds(samples: int, rate: Decimal | None = None) -> int:
    """Wall clock for the main pod from measured (or floor) rate, capped by $17."""
    use = ASSUMED_FLOOR_SAMPLES_PER_SEC if rate is None or rate <= 0 else rate
    by_budget = int(TRAIN_SPEND_CAP_USD / RTX_4090_USD_PER_HOUR * 3600)
    return min(train_wall_seconds(samples, use), by_budget)


def projection_band(samples: int) -> dict[str, Decimal]:
    rates = {
        "low": Decimal("20"),
        "realistic": Decimal("8"),
        "high": ASSUMED_FLOOR_SAMPLES_PER_SEC,
    }
    out: dict[str, Decimal] = {}
    for name, rate in rates.items():
        hours = estimate_hours(samples, rate).quantize(Decimal("0.01"))
        usd = (hours * RTX_4090_USD_PER_HOUR).quantize(Decimal("0.01"))
        out[f"{name}_hours"] = hours
        out[f"{name}_usd"] = usd
    out["samples"] = Decimal(samples)
    out["fits_17"] = Decimal(1) if out["high_usd"] <= TRAIN_SPEND_CAP_USD else Decimal(0)
    return out


def calibrate_rate_path() -> Path:
    from train import paths

    return assert_under_out(paths.OUT / "runpod-calibrate-rate.txt")


def write_calibrate_rate(rate: Decimal) -> Path:
    path = calibrate_rate_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{rate}\n", encoding="utf-8")
    return path


def read_calibrate_rate() -> Decimal | None:
    path = calibrate_rate_path()
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return None
    try:
        rate = Decimal(text)
    except InvalidOperation:
        return None
    return rate if rate > 0 else None
