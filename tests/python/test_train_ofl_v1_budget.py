"""ofl-v1 step B: the sample budget, the loader that fills it, and what the pod may spend."""

from __future__ import annotations

from decimal import Decimal

import pytest

from train.loop import recipe
from train.model import BASE_CLASSES
from train.recipe_defs import (
    ARTIFACT_TRANSFER_SECONDS,
    CALIBRATE_SPEND_CAP_USD,
    FONT_FETCH_SLACK_SECONDS,
    RTX_4090_USD_PER_HOUR,
    SETUP_SLACK_SECONDS,
    TRAIN_SPEND_CAP_USD,
    estimate_train_usd,
    estimate_usd,
    ofl_v1_budget,
    ofl_v1_steps,
    train_max_runtime_seconds,
    train_wall_seconds,
)
from train.runpod import CALIBRATE, _self_delete_deadline, main, projected_spend, train_spec


def _sfnt(tag: str) -> bytes:
    return b"\x00\x01\x00\x00" + tag.encode().ljust(120, b".")


class _Body:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self, *_args) -> bytes:
        return self._data

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _every_family_downloads(monkeypatch) -> None:
    monkeypatch.setattr("train.replay_gf.urlopen", lambda request, timeout=None: _Body(_sfnt(request.full_url)))


def test_ofl_v1_budget_pins_the_current_numbers():
    """A change to replay selection or the sample plan must show up here on purpose."""
    budget = ofl_v1_budget()
    assert budget.old_classes == 1785
    assert budget.new_classes == 597
    assert budget.replay_samples == 42_840
    assert budget.total_samples == 195_672
    assert ofl_v1_steps(16) == 12_230
    cfg = recipe("ofl-v1")
    assert (cfg.batch_size, cfg.steps, cfg.total_samples) == (16, 12_230, 195_672)


def test_replay_loader_yields_exactly_the_budgeted_classes_when_every_fetch_succeeds(tmp_path, monkeypatch):
    from train.replay_gf import load_replay_fonts

    monkeypatch.setattr("train.paths.OUT", tmp_path)
    _every_family_downloads(monkeypatch)
    fonts = load_replay_fonts(fetch=True, root=tmp_path / "cache")
    assert len(fonts) == ofl_v1_budget().old_classes
    assert all(0 <= i < BASE_CLASSES for i in fonts)


def test_ofl_loader_epoch_is_the_recipe_epoch(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    from train.dataset import make_ofl_loader
    from train.replay_gf import load_replay_fonts

    cache = tmp_path / "font-cache"
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(cache))
    _every_family_downloads(monkeypatch)
    load_replay_fonts(fetch=True, root=cache)

    cfg = recipe("ofl-v1")
    loader = make_ofl_loader(
        batch_size=cfg.batch_size,
        per_class_new=cfg.per_class_new,
        per_class_replay=cfg.per_class_replay,
        num_workers=0,
        shuffle=False,
        fetch_fonts=False,
        replay_repeat=cfg.replay_repeat,
    )
    budget = ofl_v1_budget()
    assert len(loader.dataset) == cfg.total_samples == budget.total_samples
    assert len(loader) == cfg.steps
    new_part, *replay_parts = loader.dataset.datasets
    assert len(new_part) == budget.new_samples
    assert len(replay_parts) == cfg.replay_repeat
    assert sum(len(part) for part in replay_parts) == budget.replay_samples
    replay_classes = {spec.class_index for spec in replay_parts[0].specs}
    assert len(replay_classes) == budget.old_classes


@pytest.mark.parametrize(("samples", "rate"), [(195_672, Decimal("8")), (1_000, Decimal("20")), (195_672, Decimal("3.1"))])
def test_train_estimate_bills_compute_plus_setup_fetch_and_transfer(samples, rate):
    overhead_seconds = SETUP_SLACK_SECONDS + FONT_FETCH_SLACK_SECONDS + ARTIFACT_TRANSFER_SECONDS
    overhead_usd = Decimal(overhead_seconds) / Decimal(3600) * RTX_4090_USD_PER_HOUR
    assert estimate_train_usd(samples, rate) - estimate_usd(samples, rate) == pytest.approx(overhead_usd)
    # The dollars checked against $17 describe the same wall clock the pod is given.
    wall_usd = Decimal(train_wall_seconds(samples, rate)) / Decimal(3600) * RTX_4090_USD_PER_HOUR
    assert abs(wall_usd - estimate_train_usd(samples, rate)) <= RTX_4090_USD_PER_HOUR / Decimal(3600)


@pytest.mark.parametrize("rate", [None, Decimal("0.5"), Decimal("2"), Decimal("2.93"), Decimal("5"), Decimal("50")])
def test_train_max_runtime_never_buys_more_than_the_17_dollar_cap(rate):
    samples = ofl_v1_budget().total_samples
    runtime = train_max_runtime_seconds(samples, rate)
    assert Decimal(runtime) / Decimal(3600) * RTX_4090_USD_PER_HOUR <= TRAIN_SPEND_CAP_USD
    cap_seconds = int(TRAIN_SPEND_CAP_USD / RTX_4090_USD_PER_HOUR * 3600)
    assert runtime == min(cap_seconds, train_wall_seconds(samples, Decimal("5") if rate is None else rate))


def test_fast_rate_gets_the_full_wall_clock_and_a_watchdog_after_fetch_train_and_send():
    rate = Decimal("8")
    samples = ofl_v1_budget().total_samples
    spec = train_spec(rate)
    assert spec.max_runtime_seconds == train_wall_seconds(samples, rate)
    compute = -(-samples // 8)
    assert _self_delete_deadline(spec) >= compute + FONT_FETCH_SLACK_SECONDS + ARTIFACT_TRANSFER_SECONDS


def _edge_rate(samples: int) -> Decimal:
    """Samples/s at which compute + setup + fetch + transfer costs exactly $17 on a 4090."""
    overhead = SETUP_SLACK_SECONDS + FONT_FETCH_SLACK_SECONDS + ARTIFACT_TRANSFER_SECONDS
    seconds = TRAIN_SPEND_CAP_USD / RTX_4090_USD_PER_HOUR * 3600 - overhead
    return Decimal(samples) / seconds


def _plan_train(tmp_path, monkeypatch, rate: Decimal) -> int:
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    (tmp_path / "runpod-calibrate-rate.txt").write_text(f"{rate}\n", encoding="utf-8")

    def offline(*_args, **_kwargs):
        raise AssertionError("network")

    monkeypatch.setattr("urllib.request.urlopen", offline)
    return main(["plan", "--mode", "train"])


def test_train_is_refused_just_below_the_17_dollar_rate(tmp_path, monkeypatch, capsys):
    edge = _edge_rate(ofl_v1_budget().total_samples)
    assert _plan_train(tmp_path, monkeypatch, (edge * Decimal("0.99")).quantize(Decimal("0.001"))) == 3
    assert "refusing train" in capsys.readouterr().err


def test_train_is_planned_just_above_the_17_dollar_rate(tmp_path, monkeypatch, capsys):
    edge = _edge_rate(ofl_v1_budget().total_samples)
    assert _plan_train(tmp_path, monkeypatch, (edge * Decimal("1.01")).quantize(Decimal("0.001"))) == 0
    captured = capsys.readouterr()
    assert "refusing" not in captured.err
    assert captured.out


def test_calibrate_pod_fits_20_minutes_one_dollar_and_the_cold_font_fetch():
    assert CALIBRATE.max_runtime_seconds <= 20 * 60
    assert projected_spend(CALIBRATE, RTX_4090_USD_PER_HOUR) <= CALIBRATE_SPEND_CAP_USD
    # The watchdog must not fire before a cold GF+OFL fetch could finish.
    assert FONT_FETCH_SLACK_SECONDS < _self_delete_deadline(CALIBRATE) < CALIBRATE.max_runtime_seconds
