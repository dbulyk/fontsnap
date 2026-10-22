"""Single source of truth for the ofl-v1 fine-tune budget and RunPod sizing.

Sample budget (justification)
-----------------------------
The shipped head has BASE_CLASSES = 3665 faces from storia/font-classify-onnx.
meta.json marks most families as in Google Fonts; ofl-v1 pulls a latin-400 cut
per family from the Fontsource CDN for replay (see train.replay_gf).

Choice for ofl-v1 (round 6 / step A)
------------------------------------
- Train the 597 new OFL faces (real verified font bytes) **and** replay old
  classes on real GF family files (PER_CLASS_REPLAY=4, repeated REPLAY_REPEAT=6
  times per epoch) so new head rows see enough CE negatives.
- **Freeze the backbone**; train classifier head only; restore old head rows
  after each AdamW step (weight decay would move them with zeroed grads).
- Threat-only softplus on a **public web screenshot bank** (never realset3):
  softplus(max_new − max_old + margin) on pack/crop views of those shots.
  GF replay is CE-only; unthresholded logsumexp and LwF are gone.
- CE views (new + GF replay + synth hold-out) stay on raw synth-prep: a CPU
  full-head measure with pack/crop on the CE pool dropped realset3 to ~47%.
  Softplus bank views use evaluate pack+crop (screenshot domain).
- The bank is fetched at train time from PUBLIC_URLS (Playwright); screenshots
  stay under out/ and are not committed. WEB_BANK_SLACK_SECONDS sits in setup.
- Init new head bias to -80 so new classes do not steal argmax at step 0.
- Batch 16 + AMP; num_workers=4. Font fetches run in parallel (8 workers);
  FONT_FETCH_SLACK_SECONDS is inside setup / max_runtime budgets.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path

from train.model import BASE_CLASSES
from train.paths import assert_under_out
from train.registry import PHASE1_CLASSES

OFL_V1_BATCH_SIZE = 16
OFL_V1_PER_CLASS_NEW = 256
OFL_V1_PER_CLASS_REPLAY = 4
# Concat-repeat the replay set each epoch so negatives ≈37% of steps.
OFL_V1_REPLAY_REPEAT = 6
OFL_V1_LR = 1e-3  # head-only; higher than full-net 1e-4
OFL_V1_WEIGHT_DECAY = 1e-2
OFL_V1_NUM_WORKERS = 4
OFL_V1_AMP = True
OFL_V1_CHECKPOINT_EVERY = 500
OFL_V1_FREEZE_BACKBONE = True
OFL_V1_NEW_BIAS = -80.0
OFL_V1_SUPPRESS_WEIGHT = 1.0
OFL_V1_SUPPRESS_MARGIN = 8.0
# Warm-up batches excluded from calibrate samples/sec (fetch/workers/compile).
CALIBRATE_WARMUP_STEPS = 4
CALIBRATE_STEPS = 16
ASSUMED_FLOOR_SAMPLES_PER_SEC = Decimal("5")
RTX_4090_USD_PER_HOUR = Decimal("0.89")
TRAIN_SPEND_CAP_USD = Decimal("17.00")
CALIBRATE_SPEND_CAP_USD = Decimal("1.00")
CALIBRATE_MAX_RUNTIME_SECONDS = 20 * 60
SETUP_SLACK_SECONDS = 20 * 60
# Parallel GF+OFL cold fetch (~1 min measured) plus headroom inside setup.
FONT_FETCH_SLACK_SECONDS = 3 * 60
# Playwright capture of PUBLIC_URLS (target 200 shots) inside setup.
WEB_BANK_SLACK_SECONDS = 3 * 60
# Leave room inside the watchdog for artifact send after train.
ARTIFACT_TRANSFER_SECONDS = 10 * 60


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
    return SampleBudget(
        per_class_new=OFL_V1_PER_CLASS_NEW,
        per_class_replay=OFL_V1_PER_CLASS_REPLAY,
        replay_repeat=OFL_V1_REPLAY_REPEAT,
        new_classes=PHASE1_CLASSES,
        old_classes=BASE_CLASSES,
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
    return SETUP_SLACK_SECONDS + FONT_FETCH_SLACK_SECONDS + WEB_BANK_SLACK_SECONDS


def estimate_train_usd(samples: int, rate: Decimal, hourly: Decimal = RTX_4090_USD_PER_HOUR) -> Decimal:
    """Compute + setup (incl. font fetch + web bank) + artifact transfer, for the >$17 refuse check."""
    slack = Decimal(_setup_slack_seconds() + ARTIFACT_TRANSFER_SECONDS) / Decimal(3600)
    return (estimate_hours(samples, rate) + slack) * hourly


def train_wall_seconds(samples: int, rate: Decimal) -> int:
    """Seconds the pod needs: epoch compute + setup/fetch/bank slack + artifact send window."""
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
        "low": Decimal("25"),
        "realistic": Decimal("12"),
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
