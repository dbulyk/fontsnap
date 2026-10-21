import json
import os
from decimal import Decimal

import pytest

from train.runpod import (
    CALIBRATE,
    LIVE_CALIBRATE,
    PLAN_CALIBRATE,
    TRAIN,
    PodState,
    check_spend,
    create_body,
    main,
    parse_pod,
    plan,
    projected_spend,
    watch,
)


def test_remote_status_maps_and_unknown_and_absent():
    for state in (
        PodState.PROVISIONING,
        PodState.STARTING,
        PodState.RUNNING,
        PodState.EXITED,
        PodState.ERROR,
        PodState.TERMINATED,
    ):
        pod = parse_pod(
            {
                "id": "pod-1",
                "name": "fontsnap-calibrate",
                "status": state.value,
                "cost": "0.89",
                "cloud": "SECURE",
                "gpu": {"id": "NVIDIA GeForce RTX 4090"},
                "actions": ["stop", "terminate"],
                "startedAt": "2026-01-01T00:00:00Z",
            },
            status_code=200,
        )
        assert pod.state is state
        assert pod.hourly_usd == Decimal("0.89")
        assert pod.actions == frozenset({"stop", "terminate"})
    unknown = parse_pod({"id": "pod-x", "status": "PAUSED", "actions": ["dance"]}, status_code=200)
    assert unknown.state is PodState.UNKNOWN
    assert unknown.actions == frozenset({"dance"})
    absent = parse_pod({"status": "RUNNING"}, status_code=404)
    assert absent.state is PodState.ABSENT
    assert absent.id == ""


def test_plan_does_not_open_a_socket_or_leak_the_key(monkeypatch, tmp_path):
    monkeypatch.setenv("RUNPOD_API_KEY", "super-secret-key-9f3a")
    monkeypatch.delenv("FONTSNAP_RUNPOD_LIVE", raising=False)
    monkeypatch.setattr("train.paths.OUT", tmp_path)

    def boom(*_args, **_kwargs):
        raise AssertionError("urlopen")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    text = plan(CALIBRATE, journal=tmp_path / "cost.jsonl")
    journal = (tmp_path / "cost.jsonl").read_text(encoding="utf-8")
    assert "super-secret-key-9f3a" not in text
    assert "super-secret-key-9f3a" not in journal
    assert PLAN_CALIBRATE in text
    assert LIVE_CALIBRATE in text
    assert "NVIDIA GeForce RTX 4090" in text
    body = create_body(CALIBRATE)
    assert body["cloud"] == "SECURE"
    assert body["gpu"] == {"id": "NVIDIA GeForce RTX 4090", "count": 1}
    assert "env" not in body
    assert json.dumps(body, indent=2) in text
    line = json.loads(journal)
    assert line["note"] == "dry-plan"
    assert line["estimated_usd"] == "0"
    assert line["mode"] == "calibrate"


def test_plan_cli_with_key_removed(monkeypatch, tmp_path):
    monkeypatch.delenv("RUNPOD_API_KEY", raising=False)
    monkeypatch.delenv("FONTSNAP_RUNPOD_LIVE", raising=False)
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    assert "RUNPOD_API_KEY" not in os.environ
    assert main(["plan", "--mode", "calibrate"]) == 0
    journal = json.loads((tmp_path / "runpod-cost.jsonl").read_text(encoding="utf-8"))
    assert journal["estimated_usd"] == "0"
    assert journal["note"] == "dry-plan"


def test_watch_refuses_before_any_socket_when_live_flag_is_off(monkeypatch):
    monkeypatch.setenv("RUNPOD_API_KEY", "test")
    monkeypatch.delenv("FONTSNAP_RUNPOD_LIVE", raising=False)
    calls = []

    def boom(*_args, **_kwargs):
        calls.append(1)
        raise AssertionError("urlopen")

    monkeypatch.setattr("urllib.request.urlopen", boom)
    with pytest.raises(SystemExit) as caught:
        watch(CALIBRATE)
    assert caught.value.code == 2
    assert calls == []


def test_argv_rejects_a_key_flag():
    assert main(["--api-key", "sek"]) == 2
    assert main(["--apikey=sek"]) == 2
    assert main(["plan", "RUNPOD_API_KEY=sek", "--mode", "calibrate"]) == 2


def test_create_body_has_no_secret_slot():
    body = create_body(CALIBRATE)
    assert body == {
        "name": "fontsnap-calibrate",
        "image": CALIBRATE.image,
        "cloud": "SECURE",
        "gpu": {"id": "NVIDIA GeForce RTX 4090", "count": 1},
        "disk": 20,
    }
    assert "RUNPOD" not in json.dumps(body)


def test_calibrate_spend_cap_exits_3_above_one_dollar():
    assert CALIBRATE.max_runtime_seconds == 20 * 60
    assert CALIBRATE.spend_cap_usd == Decimal("1.00")
    assert CALIBRATE.cloud == "SECURE"
    assert projected_spend(CALIBRATE, Decimal("6.00")) > Decimal("1.00")
    with pytest.raises(SystemExit) as caught:
        check_spend(CALIBRATE, Decimal("6.00"))
    assert caught.value.code == 3
    check_spend(CALIBRATE, Decimal("2.00"))
    assert (TRAIN.max_runtime_seconds, TRAIN.spend_cap_usd) != (CALIBRATE.max_runtime_seconds, CALIBRATE.spend_cap_usd)


def test_module_docstring_has_the_launch_commands():
    import train.runpod as runpod

    assert PLAN_CALIBRATE in runpod.__doc__
    assert LIVE_CALIBRATE in runpod.__doc__
