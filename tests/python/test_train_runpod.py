import io
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from decimal import Decimal
from pathlib import Path

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
    pinned_commit,
    plan,
    projected_spend,
    watch,
)

REPO = Path(__file__).resolve().parents[2]
PYTHON = REPO / "python"
KEY = "super-secret-key-9f3a"
POD = "pod-1"
CAL_HANDOVER_CODE = "abcd-ef01-2345-6789-2"
CAL_HANDOVER_SHA = "ab" * 32


def calibrate_handover_logs(rate: str = "12.5") -> bytes:
    """Log blob with rate first, then runpodctl handover markers (client ACK)."""
    return (
        f"samples/sec {rate}\n"
        f"fontsnap_calibrate_sha256 {CAL_HANDOVER_SHA}\n"
        f"fontsnap_calibrate_receive {CAL_HANDOVER_CODE}\n"
    ).encode()


class Resp:
    def __init__(self, status, body):
        self.status = status
        self._body = body if isinstance(body, bytes) else bytes(body)

    def read(self, n=-1):
        if n is None or n < 0 or n >= len(self._body):
            data, self._body = self._body, b""
            return data
        data, self._body = self._body[:n], self._body[n:]
        return data

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class Clock:
    def __init__(self):
        self.n = 0.0

    def __call__(self):
        self.n += 1.0
        return self.n


def pod_payload(status, *, pod_id=POD, cloud="SECURE", actions=None):
    return {
        "id": pod_id,
        "name": "fontsnap-calibrate",
        "status": status,
        "cost": "0.89",
        "cloud": cloud,
        "gpu": {"id": "NVIDIA GeForce RTX 4090"},
        "actions": ["stop", "terminate"] if actions is None else actions,
    }


def install(monkeypatch, handler):
    calls = []

    def urlopen(request, timeout=30):
        method = request.get_method()
        path = request.full_url.split("/v2", 1)[-1]
        calls.append((method, path, request.data))
        status, payload = handler(method, path, request.data)
        raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "err", hdrs={}, fp=io.BytesIO(raw))
        return Resp(status, raw)

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return calls


def arm(monkeypatch, tmp_path):
    monkeypatch.setenv("FONTSNAP_RUNPOD_LIVE", "1")
    monkeypatch.setenv("RUNPOD_API_KEY", KEY)
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    sleeps = []
    monkeypatch.setattr("train.runpod.time.sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr("train.runpod.time.monotonic", Clock())

    import train.runpod as runpod
    from train.recipe_defs import write_calibrate_rate

    holder: dict[str, Decimal] = {}

    def tracking_handover(pod_id: str, key: str, prior: tuple[str | None, str | None]):
        text = runpod._pod_log_text(pod_id, key, stop_when=runpod._CALIBRATE_RECEIVE)
        rate = runpod.parse_samples_per_sec(text)
        if rate is not None:
            holder["rate"] = rate
        code = runpod.parse_calibrate_receive(text) or prior[0]
        digest = runpod.parse_calibrate_sha256(text) or prior[1]
        return code, digest

    def fake_receive_calibrate(code: str, sha: str):
        assert code == CAL_HANDOVER_CODE
        assert sha == CAL_HANDOVER_SHA
        rate = holder.get("rate")
        if rate is None:
            raise ValueError("test handover missing samples/sec in logs")
        write_calibrate_rate(rate)
        return rate

    monkeypatch.setattr(runpod, "_latest_calibrate_handover", tracking_handover)
    monkeypatch.setattr(runpod, "receive_calibrate_rate", fake_receive_calibrate)
    return sleeps


def price_and_create(method, path, secure="0.89"):
    if method == "GET" and path.startswith("/catalog/gpus/"):
        return 200, {"id": "NVIDIA GeForce RTX 4090", "price": {"secure": secure, "community": "0.30"}}
    if method == "POST" and path == "/pods":
        return 201, pod_payload("PROVISIONING")
    return None


def deletes(calls):
    return [path for method, path, _body in calls if method == "DELETE"]


def journal_notes(tmp_path):
    path = tmp_path / "runpod-cost.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line)["note"] for line in path.read_text(encoding="utf-8").splitlines() if line]


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
    monkeypatch.setenv("RUNPOD_API_KEY", KEY)
    monkeypatch.delenv("FONTSNAP_RUNPOD_LIVE", raising=False)
    monkeypatch.setattr("train.paths.OUT", tmp_path)

    def boom(*_args, **_kwargs):
        raise AssertionError("urlopen")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    text = plan(CALIBRATE, journal=tmp_path / "cost.jsonl")
    journal = (tmp_path / "cost.jsonl").read_text(encoding="utf-8")
    assert KEY not in text
    assert KEY not in journal
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

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    assert main(["watch", "--mode", "calibrate"]) == 2
    assert calls == []


def test_argv_rejects_a_key_flag():
    assert main(["--api-key", "sek"]) == 2
    assert main(["--apikey=sek"]) == 2
    assert main(["plan", "RUNPOD_API_KEY=sek", "--mode", "calibrate"]) == 2


def test_create_body_is_a_secure_pod_that_stops_itself():
    body = create_body(CALIBRATE)
    script = body["cmd"][0]
    assert body["name"] == "fontsnap-calibrate"
    assert body["image"] == CALIBRATE.image
    assert body["cloud"] == "SECURE"
    assert body["gpu"] == {"id": "NVIDIA GeForce RTX 4090", "count": 1}
    assert body["disk"] == 20
    assert body["entrypoint"] == ["/bin/bash", "-lc"]
    assert set(body) == {"name", "image", "cloud", "gpu", "disk", "entrypoint", "cmd"}
    sha = pinned_commit()
    assert "https://github.com/dbulyk/fontsnap.git" in script
    assert f"git fetch --depth 1 origin {sha}" in script
    assert "git lfs pull --include='model/**'" in script
    assert "python/requirements.txt" in script
    assert "python/train/requirements.txt" in script
    assert "x-access-token" not in script
    assert "_fontsnap_self_delete" in script
    assert "_fontsnap_until_deleted" in script
    assert script.index("_fontsnap_until_deleted") < script.index('exit "$status"')
    assert "pip install" in script
    from train.runpod import _PROVISION_SLACK_SECONDS, _SELF_DELETE_CALL_TIMEOUT, _self_delete_deadline

    assert _self_delete_deadline(CALIBRATE) == max(60, CALIBRATE.max_runtime_seconds - _PROVISION_SLACK_SECONDS)
    assert _self_delete_deadline(TRAIN) == max(60, TRAIN.max_runtime_seconds - _PROVISION_SLACK_SECONDS)
    assert f"(sleep {_self_delete_deadline(CALIBRATE)}; _fontsnap_until_deleted) &" in script
    assert script.index("(sleep") < script.index("apt-get")
    assert "python -m train.loop --recipe calibrate --device cuda" in script
    assert "FONTSNAP_ALLOW_GPU=1" in script
    assert "FONTSNAP_POD_WORK" in script
    assert f'timeout {_SELF_DELETE_CALL_TIMEOUT} runpodctl remove pod "$RUNPOD_POD_ID"' in script
    assert f'timeout {_SELF_DELETE_CALL_TIMEOUT} runpodctl pod delete "$RUNPOD_POD_ID"' in script
    assert f'timeout {_SELF_DELETE_CALL_TIMEOUT} runpodctl stop pod "$RUNPOD_POD_ID"' in script
    assert script.index("remove pod") < script.index("pod delete")
    assert script.index("pod delete") < script.index("stop pod")
    assert "api.runpod.io/v2/pods/" in script
    assert "--max-time" in script
    assert "-H @-" in script
    assert "FONTSNAP_DONE_MARKER" not in script
    assert "/var/lib/fontsnap/done" not in script
    assert "fontsnap_calibrate_receive" in script
    assert "calibrate-rate.txt" in script
    assert "runpodctl send --code" in script
    assert " sleep 5\n" not in script
    # Script may read the pod-scoped $RUNPOD_API_KEY Runpod injects; create body must not set it.
    assert "env" not in body
    assert KEY not in json.dumps(body)
    train = create_body(TRAIN)["cmd"][0]
    assert f"(sleep {_self_delete_deadline(TRAIN)}; _fontsnap_until_deleted) &" in train
    assert "python -m train.loop --recipe ofl-v1 --device cuda" in train
    assert "_fontsnap_until_deleted" in train
    assert "runpodctl send --code" in train
    assert "fontsnap_artifact_receive" in train
    # send starts in the background; full 5-part code is echoed from its stdout.
    assert "SEND_OUT=" in train
    assert train.index("runpodctl send --code") < train.index("fontsnap_artifact_receive")
    assert train.index("runpodctl send") < train.index("_fontsnap_until_deleted\nexit")


def test_calibrate_spend_cap_exits_3_above_one_dollar():
    from train.recipe_defs import CALIBRATE_STEPS, OFL_V1_BATCH_SIZE, ofl_v1_budget

    assert CALIBRATE.max_runtime_seconds == 20 * 60
    assert CALIBRATE.spend_cap_usd == Decimal("1.00")
    assert CALIBRATE.samples == CALIBRATE_STEPS * OFL_V1_BATCH_SIZE
    assert TRAIN.samples == ofl_v1_budget().total_samples
    assert TRAIN.spend_cap_usd == Decimal("17.00")
    assert CALIBRATE.cloud == "SECURE"
    assert projected_spend(CALIBRATE, Decimal("6.00")) > Decimal("1.00")
    with pytest.raises(SystemExit) as caught:
        check_spend(CALIBRATE, Decimal("6.00"))
    assert caught.value.code == 3
    check_spend(CALIBRATE, Decimal("2.00"))
    assert (TRAIN.max_runtime_seconds, TRAIN.spend_cap_usd) != (CALIBRATE.max_runtime_seconds, CALIBRATE.spend_cap_usd)


def test_module_docstring_cites_the_v2_api_and_the_launch_commands():
    import train.runpod as runpod

    assert PLAN_CALIBRATE in runpod.__doc__
    assert LIVE_CALIBRATE in runpod.__doc__
    assert "https://docs.runpod.io/api-reference-v2/" in runpod.__doc__
    assert "https://api.runpod.io/v2/catalog/gpus/{id}" in runpod.__doc__
    assert "price.secure" in runpod.__doc__


def test_create_refuses_without_a_socket(monkeypatch):
    monkeypatch.setenv("FONTSNAP_RUNPOD_LIVE", "1")
    monkeypatch.setenv("RUNPOD_API_KEY", KEY)
    calls = []

    def boom(*_args, **_kwargs):
        calls.append(1)
        raise AssertionError("urlopen")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    assert main(["create", "--mode", "calibrate"]) == 2
    assert calls == []


def test_watch_refuses_a_calibrate_spec_over_the_cap_before_create(monkeypatch, tmp_path):
    from dataclasses import replace

    arm(monkeypatch, tmp_path)

    def handler(method, path, _body):
        hit = price_and_create(method, path, secure="0.01")
        if hit:
            return hit
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return 200, pod_payload("EXITED")
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE":
            return 204, {}
        if method == "GET" and "/logs" in path:
            return 200, b""
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    assert watch(replace(CALIBRATE, max_runtime_seconds=20 * 60 + 1)) == 3
    assert watch(replace(CALIBRATE, spend_cap_usd=Decimal("1.01"))) == 3
    assert calls == []


def test_price_over_a_dollar_does_not_create(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)

    def handler(method, path, _body):
        hit = price_and_create(method, path, secure="6.00")
        if hit:
            return hit
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    assert main(["watch", "--mode", "calibrate"]) == 3
    assert deletes(calls) == []
    assert not any(method == "POST" and path == "/pods" for method, path, _body in calls)
    assert "/catalog/gpus/" in calls[0][1]
    assert KEY not in capsys.readouterr().err


def test_happy_path_waits_for_the_job_then_deletes(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)
    seen = {"active_during_poll": False, "pod_gets": 0}

    def handler(method, path, body):
        hit = price_and_create(method, path)
        if hit:
            if method == "POST":
                assert json.loads(body) == create_body(CALIBRATE)
            return hit
        if method == "GET" and path.startswith(f"/pods/{POD}/logs"):
            return 200, calibrate_handover_logs("12.5")
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            seen["pod_gets"] += 1
            record = tmp_path / "runpod-active-pod.json"
            seen["active_during_poll"] = record.is_file() and json.loads(record.read_text(encoding="utf-8"))["id"] == POD
            status = "RUNNING" if seen["pod_gets"] == 1 else "EXITED"
            return 200, pod_payload(status)
        if method == "POST" and path == f"/pods/{POD}/action":
            assert json.loads(body) == {"action": "stop"}
            return 200, {}
        if method == "DELETE" and path == f"/pods/{POD}":
            return 204, {}
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    assert main(["watch", "--mode", "calibrate"]) == 0
    out = capsys.readouterr().out
    assert seen["active_during_poll"]
    assert seen["pod_gets"] >= 2
    assert any(method == "GET" and path.startswith(f"/pods/{POD}/logs") for method, path, _body in calls)
    assert deletes(calls) == [f"/pods/{POD}"]
    assert "samples/sec 12.5" in out
    from train.recipe_defs import RTX_4090_USD_PER_HOUR
    from train.runpod import project_main_train

    hours, usd = project_main_train(Decimal("12.5"), RTX_4090_USD_PER_HOUR)
    assert f"main train {TRAIN.samples} samples: {format(hours, 'f')} h ${format(usd, 'f')}" in out
    assert "main train max_runtime_seconds" in out
    assert KEY not in out
    assert not (tmp_path / "runpod-active-pod.json").exists()
    assert journal_notes(tmp_path) == ["deleted"]


def test_timer_stops_a_running_calibrate(monkeypatch, tmp_path, capsys):
    from dataclasses import replace

    arm(monkeypatch, tmp_path)
    short = replace(CALIBRATE, max_runtime_seconds=2)

    def handler(method, path, _body):
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and path.startswith(f"/pods/{POD}/logs"):
            return 200, calibrate_handover_logs("12.5")
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return 200, pod_payload("RUNNING")
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE":
            return 204, {}
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    assert watch(short) == 0
    out = capsys.readouterr().out
    assert deletes(calls) == [f"/pods/{POD}"]
    assert "samples/sec 12.5" in out
    from train.recipe_defs import RTX_4090_USD_PER_HOUR
    from train.runpod import project_main_train

    hours, usd = project_main_train(Decimal("12.5"), RTX_4090_USD_PER_HOUR)
    assert f"main train {TRAIN.samples} samples: {format(hours, 'f')} h ${format(usd, 'f')}" in out


@pytest.mark.parametrize("status", [503, 401, 404, 429, 500])
def test_status_http_error_still_deletes(status, monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)

    def handler(method, path, _body):
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and "/pods/" in path and "/logs" not in path:
            return status, {"title": "no"}
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE":
            return 204, {}
        if method == "GET" and "/logs" in path:
            return 200, b""
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    code = main(["watch", "--mode", "calibrate"])
    err = capsys.readouterr().err
    assert deletes(calls) == [f"/pods/{POD}"]
    assert code != 0
    assert KEY not in err


def test_unknown_status_still_deletes(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)

    def handler(method, path, _body):
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and path.startswith(f"/pods/{POD}") and "/logs" not in path:
            return 200, {"status": "PAUSED", "actions": ["dance"]}
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE":
            return 204, {}
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    code = main(["watch", "--mode", "calibrate"])
    err = capsys.readouterr().err
    assert deletes(calls) == [f"/pods/{POD}"]
    assert code != 0
    assert KEY not in err
    assert "DELETE FAILED" not in journal_notes(tmp_path)


def test_delete_retries_then_reports_the_pod_id(monkeypatch, tmp_path, capsys):
    sleeps = arm(monkeypatch, tmp_path)

    def handler(method, path, _body):
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and "/logs" in path:
            return 200, calibrate_handover_logs("12.5")
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return 200, pod_payload("EXITED")
        if method == "POST" and path.endswith("/action"):
            return 500, {"title": "stop unavailable"}
        if method == "DELETE":
            return 500, {"title": "unavailable"}
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    code = main(["watch", "--mode", "calibrate"])
    captured = capsys.readouterr()
    assert len(deletes(calls)) >= 2
    assert sleeps and sleeps == sorted(sleeps) and len(sleeps) >= 2 and sleeps[0] < sleeps[-1]
    assert code != 0
    assert POD in captured.err
    assert "https://api.runpod.io/v2/pods/pod-1" in captured.err
    assert "Bearer $RUNPOD_API_KEY" in captured.err
    assert KEY not in captured.err
    assert KEY not in captured.out
    assert "DELETE FAILED" in journal_notes(tmp_path)
    assert "wind-down" not in journal_notes(tmp_path)
    assert json.loads((tmp_path / "runpod-active-pod.json").read_text(encoding="utf-8"))["id"] == POD


def test_delete_retries_a_network_error_then_succeeds(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)
    attempts = {"delete": 0}

    def urlopen(request, timeout=30):
        method = request.get_method()
        path = request.full_url.split("/v2", 1)[-1]
        if method == "DELETE":
            attempts["delete"] += 1
            if attempts["delete"] == 1:
                raise urllib.error.URLError("reset")
            return Resp(204, b"")
        if method == "GET" and path.startswith("/catalog/gpus/"):
            return Resp(200, json.dumps({"price": {"secure": "0.89"}}).encode())
        if method == "POST" and path == "/pods":
            return Resp(201, json.dumps(pod_payload("PROVISIONING")).encode())
        if method == "GET" and "/logs" in path:
            return Resp(200, calibrate_handover_logs("12.5"))
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return Resp(200, json.dumps(pod_payload("EXITED")).encode())
        if method == "POST" and path.endswith("/action"):
            return Resp(200, b"{}")
        raise AssertionError((method, path))

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    assert main(["watch", "--mode", "calibrate"]) == 0
    assert attempts["delete"] == 2
    captured = capsys.readouterr()
    assert "DELETE FAILED" not in captured.err
    assert journal_notes(tmp_path) == ["deleted"]
    assert not (tmp_path / "runpod-active-pod.json").exists()


def test_delete_404_is_success_when_pod_is_gone(monkeypatch, tmp_path, capsys):
    """Client: after #25 self-delete, DELETE 404 + get ABSENT is success (clears active)."""
    arm(monkeypatch, tmp_path)
    state = {"deleted": False, "polls": 0}

    def handler(method, path, _body):
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and "/logs" in path:
            return 200, calibrate_handover_logs("12.5")
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            if state["deleted"]:
                return 404, {"title": "Not Found"}
            state["polls"] += 1
            status = "RUNNING" if state["polls"] == 1 else "EXITED"
            return 200, pod_payload(status)
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE":
            state["deleted"] = True
            return 404, {"title": "Not Found"}
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    assert main(["watch", "--mode", "calibrate"]) == 0
    assert deletes(calls) == [f"/pods/{POD}"]
    assert "DELETE FAILED" not in capsys.readouterr().err
    assert journal_notes(tmp_path) == ["deleted"]
    assert not (tmp_path / "runpod-active-pod.json").exists()


def test_stale_active_pod_is_deleted_before_create(monkeypatch, tmp_path):
    arm(monkeypatch, tmp_path)
    stale = {"id": "stale-pod", "mode": "calibrate", "name": "old"}
    (tmp_path / "runpod-active-pod.json").write_text(json.dumps(stale) + "\n", encoding="utf-8")
    order = []

    def handler(method, path, _body):
        order.append((method, path))
        if method == "DELETE" and path == "/pods/stale-pod":
            return 204, {}
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and "/logs" in path:
            return 200, calibrate_handover_logs("12.5")
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return 200, pod_payload("EXITED")
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE" and path == f"/pods/{POD}":
            return 204, {}
        raise AssertionError((method, path))

    install(monkeypatch, handler)
    assert main(["watch", "--mode", "calibrate"]) == 0
    assert ("DELETE", "/pods/stale-pod") in order
    assert ("POST", "/pods") in order
    assert order.index(("DELETE", "/pods/stale-pod")) < order.index(("POST", "/pods"))


@pytest.mark.parametrize("sig", [signal.SIGINT, signal.SIGTERM, signal.SIGHUP])
def test_signal_during_poll_deletes(sig, tmp_path):
    trace = tmp_path / "trace.txt"
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    env = os.environ.copy()
    env["PYTHONPATH"] = str(PYTHON)
    env["TRACE"] = str(trace)
    env["OUT_DIR"] = str(out_dir)
    env["KILL_SIG"] = str(int(sig))
    env["RUNPOD_API_KEY"] = KEY
    env["FONTSNAP_RUNPOD_LIVE"] = "1"
    proc = subprocess.run(
        [sys.executable, "-c", SIGNAL_CHILD],
        cwd=REPO,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    logged = trace.read_text(encoding="utf-8") if trace.is_file() else ""
    assert "DELETE /pods/pod-sig" in logged
    assert proc.returncode == 128 + int(sig)
    assert KEY not in proc.stderr
    assert KEY not in proc.stdout


SIGNAL_CHILD = r"""
import json
import os
import signal
import urllib.error
import urllib.request
from pathlib import Path

import train.runpod as runpod
from train import paths

trace = Path(os.environ["TRACE"])
paths.OUT = Path(os.environ["OUT_DIR"])

class Clock:
    def __init__(self):
        self.n = 0.0

    def __call__(self):
        self.n += 1.0
        return self.n

runpod.time.sleep = lambda _seconds: None
runpod.time.monotonic = Clock()

def log(line):
    with trace.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")

class Resp:
    def __init__(self, body):
        self.status = 200
        self._body = body

    def read(self, n=-1):
        data, self._body = self._body, b""
        return data

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

def urlopen(request, timeout=30):
    method = request.get_method()
    path = request.full_url.split("/v2", 1)[-1]
    log(method + " " + path)
    if method == "GET" and path.startswith("/catalog/gpus/"):
        return Resp(json.dumps({"price": {"secure": "0.89"}}).encode())
    if method == "POST" and path == "/pods":
        body = {"id": "pod-sig", "status": "PROVISIONING", "cost": "0.89", "cloud": "SECURE", "actions": ["stop", "terminate"]}
        return Resp(json.dumps(body).encode())
    if method == "GET" and path.startswith("/pods/pod-sig") and "/logs" not in path:
        os.kill(os.getpid(), int(os.environ["KILL_SIG"]))
        return Resp(b"{}")
    if method == "DELETE":
        return Resp(b"")
    if method == "POST" and path.endswith("/action"):
        return Resp(b"{}")
    return Resp(b"")

urllib.request.urlopen = urlopen
raise SystemExit(runpod.main(["watch", "--mode", "calibrate"]))
"""


def test_bad_status_line_during_poll_still_deletes(monkeypatch, tmp_path, capsys):
    import http.client

    arm(monkeypatch, tmp_path)

    def urlopen(request, timeout=30):
        method = request.get_method()
        path = request.full_url.split("/v2", 1)[-1]
        if method == "GET" and path.startswith("/catalog/gpus/"):
            return Resp(200, json.dumps({"price": {"secure": "0.89"}}).encode())
        if method == "POST" and path == "/pods":
            return Resp(201, json.dumps(pod_payload("PROVISIONING")).encode())
        if method == "GET" and path.startswith(f"/pods/{POD}") and "/logs" not in path:
            raise http.client.BadStatusLine("HTTP/1.1 ABC Garbage")
        if method == "POST" and path.endswith("/action"):
            return Resp(200, b"{}")
        if method == "DELETE":
            return Resp(204, b"")
        raise AssertionError((method, path))

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    code = main(["watch", "--mode", "calibrate"])
    assert code != 0
    err = capsys.readouterr().err
    assert KEY not in err
    notes = journal_notes(tmp_path)
    assert "deleted" in notes
    assert not (tmp_path / "runpod-active-pod.json").exists()


def test_sse_chunked_logs_still_yield_samples_per_sec(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)

    class SlowSSE(Resp):
        def __init__(self):
            prefix = b"data: " + calibrate_handover_logs("9.25").replace(b"\n", b"\ndata: ")
            # Trailing chunk never arrives; read must stop early on the rate line.
            super().__init__(200, prefix)

        def read(self, n=-1):
            if self._body:
                return super().read(n)
            raise TimeoutError("sse still open")

    def urlopen(request, timeout=30):
        method = request.get_method()
        path = request.full_url.split("/v2", 1)[-1]
        if method == "GET" and path.startswith("/catalog/gpus/"):
            return Resp(200, json.dumps({"price": {"secure": "0.89"}}).encode())
        if method == "POST" and path == "/pods":
            return Resp(201, json.dumps(pod_payload("PROVISIONING")).encode())
        if method == "GET" and "/logs" in path:
            return SlowSSE()
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return Resp(200, json.dumps(pod_payload("EXITED")).encode())
        if method == "POST" and path.endswith("/action"):
            return Resp(200, b"{}")
        if method == "DELETE":
            return Resp(204, b"")
        raise AssertionError((method, path))

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    assert main(["watch", "--mode", "calibrate"]) == 0
    out = capsys.readouterr().out
    assert "samples/sec 9.25" in out
    assert f"main train {TRAIN.samples} samples:" in out


def _park_long_sleep_stub() -> str:
    # Watchdog uses a large sleep; park until the EXIT trap kills it. Short sleeps (settle/backoff) no-op.
    return '#!/bin/sh\nif [ -n "$1" ] && [ "$1" -gt 100 ] 2>/dev/null; then exec cat; fi\nexit 0\n'


def _pod_env(tmp_path: Path, bind: Path, **extra: str) -> dict[str, str]:
    """Isolate container_script work dir under tmp_path (N18: never touch /tmp/fontsnap)."""
    work = tmp_path / "pod-work"
    work.mkdir(exist_ok=True)
    env = os.environ.copy()
    env["PATH"] = f"{bind}:/usr/bin:/bin"
    env["FONTSNAP_POD_WORK"] = str(work)
    env["RUNPOD_POD_ID"] = POD
    env.update(extra)
    return env


def _kill_process_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        proc.kill()
    proc.wait(timeout=5)


def test_container_script_does_not_print_rate_on_train_failure(tmp_path):
    from train.runpod import container_script

    sha = "a" * 40
    script = container_script(CALIBRATE, commit=sha)
    bind = tmp_path / "bin"
    bind.mkdir()
    git_log = tmp_path / "git.log"
    fetched = tmp_path / "fetched.txt"
    fetched.write_text("", encoding="utf-8")
    py_log = tmp_path / "python.log"
    deleted = tmp_path / "deleted.txt"
    (bind / "git").write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$GIT_LOG"\n'
        'if [ "$1" = fetch ]; then\n'
        "  last=\n"
        "  for last; do :; done\n"
        '  printf "%s\\n" "$last" >> "$GIT_FETCHED"\n'
        "  exit 0\n"
        "fi\n"
        'if [ "$1" = checkout ]; then\n'
        '  case " $* " in\n'
        '    *" FETCH_HEAD "*) [ -s "$GIT_FETCHED" ] && exit 0 ;;\n'
        "  esac\n"
        '  echo "not our commit" >&2\n'
        "  exit 1\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    (bind / "python").write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$PY_LOG"\n'
        'if [ "$1 $2" = "-m pip" ]; then exit 0; fi\n'
        'echo "samples/sec 8.000000"\n'
        'echo "No module named train" >&2\n'
        "exit 1\n",
        encoding="utf-8",
    )
    (bind / "apt-get").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (bind / "runpodctl").write_text(
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DELETED"\nexit 0\n',
        encoding="utf-8",
    )
    (bind / "sleep").write_text(_park_long_sleep_stub(), encoding="utf-8")
    for path in bind.iterdir():
        path.chmod(0o755)
    env = _pod_env(
        tmp_path,
        bind,
        GIT_LOG=str(git_log),
        GIT_FETCHED=str(fetched),
        PY_LOG=str(py_log),
        DELETED=str(deleted),
    )
    proc = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=20, check=False)
    logged = git_log.read_text(encoding="utf-8") if git_log.is_file() else ""
    py = py_log.read_text(encoding="utf-8") if py_log.is_file() else ""
    removed = deleted.read_text(encoding="utf-8") if deleted.is_file() else ""
    assert sha in logged
    assert "fetch --depth 1 origin " + sha in logged
    assert "train.loop" in py
    assert proc.returncode != 0
    assert "samples/sec" not in proc.stdout
    assert "main train" not in proc.stdout
    assert f"remove pod {POD}" in removed
    assert not Path("/tmp/fontsnap").exists() or not (Path("/tmp/fontsnap") / "fontsnap-train.out").exists()


def test_watchdog_deletes_when_apt_get_hangs(monkeypatch, tmp_path):
    import time

    import train.runpod as runpod
    from train.runpod import container_script

    monkeypatch.setattr(runpod, "_self_delete_deadline", lambda _spec: 2)
    sha = "b" * 40
    script = container_script(CALIBRATE, commit=sha)
    bind = tmp_path / "bin"
    bind.mkdir()
    deleted = tmp_path / "deleted.txt"
    (bind / "apt-get").write_text("#!/bin/sh\nexec sleep 1000\n", encoding="utf-8")
    (bind / "runpodctl").write_text(
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DELETED"\nexit 0\n',
        encoding="utf-8",
    )
    for path in bind.iterdir():
        path.chmod(0o755)
    env = _pod_env(tmp_path, bind, DELETED=str(deleted))
    proc = subprocess.Popen(
        ["bash", "-c", script],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if deleted.is_file() and f"remove pod {POD}" in deleted.read_text(encoding="utf-8"):
                break
            time.sleep(0.1)
        else:
            raise AssertionError("watchdog did not delete the pod while setup hung")
    finally:
        _kill_process_group(proc)


def test_self_delete_falls_back_when_pod_subcommand_is_unknown(tmp_path):
    """Live image error: Error: unknown command \"pod\" for \"runpodctl\"."""
    from train.runpod import container_script

    sha = "c" * 40
    script = container_script(CALIBRATE, commit=sha)
    bind = tmp_path / "bin"
    bind.mkdir()
    deleted = tmp_path / "deleted.txt"
    (bind / "git").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (bind / "python").write_text(
        '#!/bin/sh\nif [ "$1 $2" = "-m pip" ]; then exit 0; fi\necho "samples/sec 1.0"\nexit 0\n',
        encoding="utf-8",
    )
    (bind / "apt-get").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (bind / "curl").write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
    (bind / "timeout").write_text(
        "#!/bin/sh\n"
        "shift\n"
        'exec "$@"\n',
        encoding="utf-8",
    )
    (bind / "sha256sum").write_text(
        "#!/bin/sh\n"
        'python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],\'rb\').read()).hexdigest(), sys.argv[1])" "$1"\n',
        encoding="utf-8",
    )
    (bind / "runpodctl").write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$DELETED"\n'
        'if [ "$1" = send ]; then\n'
        "  code=\n"
        "  prev=\n"
        "  for arg; do\n"
        '    if [ "$prev" = "--code" ]; then code="$arg"; fi\n'
        '    prev="$arg"\n'
        "  done\n"
        '  printf "%s-2\\n" "$code"\n'
        "  exit 0\n"
        "fi\n"
        'if [ "$1" = pod ]; then\n'
        '  echo \'Error: unknown command "pod" for "runpodctl"\' >&2\n'
        "  exit 1\n"
        "fi\n"
        'if [ "$1 $2" = "remove pod" ]; then exit 0; fi\n'
        "exit 1\n",
        encoding="utf-8",
    )
    (bind / "sleep").write_text(_park_long_sleep_stub(), encoding="utf-8")
    for path in bind.iterdir():
        path.chmod(0o755)
    env = _pod_env(tmp_path, bind, DELETED=str(deleted))
    proc = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=20, check=False)
    removed = deleted.read_text(encoding="utf-8") if deleted.is_file() else ""
    assert proc.returncode == 0
    assert f"remove pod {POD}" in removed
    assert "samples/sec 1.0" in proc.stdout
    assert "fontsnap_calibrate_receive" in proc.stdout


def test_all_delete_paths_failing_keeps_pid1_alive_without_retrain(tmp_path):
    """If every delete path fails, PID 1 must retry instead of exiting (no restart/re-train)."""
    import time

    from train.runpod import container_script

    sha = "d" * 40
    script = container_script(CALIBRATE, commit=sha)
    bind = tmp_path / "bin"
    bind.mkdir()
    deleted = tmp_path / "deleted.txt"
    py_log = tmp_path / "python.log"
    attempts = tmp_path / "attempts.txt"
    (bind / "git").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (bind / "python").write_text(
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PY_LOG"\nif [ "$1 $2" = "-m pip" ]; then exit 0; fi\necho "samples/sec 1.0"\nexit 0\n',
        encoding="utf-8",
    )
    (bind / "apt-get").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (bind / "curl").write_text(
        '#!/bin/sh\nprintf "curl %s\\n" "$*" >> "$DELETED"\necho 401\nexit 0\n',
        encoding="utf-8",
    )
    (bind / "timeout").write_text(
        "#!/bin/sh\n"
        "shift\n"
        'exec "$@"\n',
        encoding="utf-8",
    )
    (bind / "sha256sum").write_text(
        "#!/bin/sh\n"
        'python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],\'rb\').read()).hexdigest(), sys.argv[1])" "$1"\n',
        encoding="utf-8",
    )
    (bind / "runpodctl").write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$DELETED"\n'
        'if [ "$1" = send ]; then\n'
        "  code=\n"
        "  prev=\n"
        "  for arg; do\n"
        '    if [ "$prev" = "--code" ]; then code="$arg"; fi\n'
        '    prev="$arg"\n'
        "  done\n"
        '  printf "%s-2\\n" "$code"\n'
        "  exit 0\n"
        "fi\n"
        'echo attempt >> "$ATTEMPTS"\n'
        'if [ "$1 $2" = "remove pod" ]; then echo unauthorized >&2; exit 1; fi\n'
        'if [ "$1" = pod ]; then echo \'Error: unknown command "pod"\' >&2; exit 1; fi\n'
        'if [ "$1 $2" = "stop pod" ]; then exit 1; fi\n'
        "exit 1\n",
        encoding="utf-8",
    )
    (bind / "sleep").write_text(_park_long_sleep_stub(), encoding="utf-8")
    for path in bind.iterdir():
        path.chmod(0o755)
    env = _pod_env(
        tmp_path,
        bind,
        DELETED=str(deleted),
        PY_LOG=str(py_log),
        ATTEMPTS=str(attempts),
        RUNPOD_API_KEY="pod-scoped-injected-key",
    )
    proc = subprocess.Popen(
        ["bash", "-c", script],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if attempts.is_file() and attempts.read_text(encoding="utf-8").count("attempt") >= 3:
                break
            time.sleep(0.1)
        else:
            raise AssertionError("self-delete did not retry after all paths failed")
        assert proc.poll() is None, "PID 1 exited while delete was still failing"
        py = py_log.read_text(encoding="utf-8")
        assert py.count("train.loop") == 1
        removed = deleted.read_text(encoding="utf-8")
        assert f"remove pod {POD}" in removed
        assert f"pod delete {POD}" in removed
        assert f"stop pod {POD}" in removed
        assert "api.runpod.io/v2/pods/" + POD in removed
    finally:
        _kill_process_group(proc)


def test_short_commit_sha_fails_loudly(monkeypatch, capsys):
    monkeypatch.setenv("FONTSNAP_RUNPOD_COMMIT", "abc1234")
    monkeypatch.setenv("FONTSNAP_RUNPOD_LIVE", "1")
    monkeypatch.setenv("RUNPOD_API_KEY", KEY)
    assert main(["plan", "--mode", "calibrate"]) == 4
    err = capsys.readouterr().err
    assert "full 40-char" in err


def test_watch_short_commit_sha_fails_before_network(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)
    monkeypatch.setenv("FONTSNAP_RUNPOD_COMMIT", "abc1234")
    calls = install(monkeypatch, lambda *_a: (_ for _ in ()).throw(AssertionError("urlopen")))
    assert main(["watch", "--mode", "calibrate"]) == 4
    err = capsys.readouterr().err
    assert "full 40-char" in err
    assert calls == []


def test_self_delete_uses_injected_key_when_runpodctl_is_broken(tmp_path):
    from train.runpod import container_script

    sha = "e" * 40
    script = container_script(CALIBRATE, commit=sha)
    bind = tmp_path / "bin"
    bind.mkdir()
    deleted = tmp_path / "deleted.txt"
    auth = tmp_path / "auth.txt"
    (bind / "git").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (bind / "python").write_text(
        '#!/bin/sh\nif [ "$1 $2" = "-m pip" ]; then exit 0; fi\necho "samples/sec 1.0"\nexit 0\n',
        encoding="utf-8",
    )
    (bind / "apt-get").write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    (bind / "timeout").write_text("#!/bin/sh\nshift\nexec \"$@\"\n", encoding="utf-8")
    (bind / "sha256sum").write_text(
        "#!/bin/sh\n"
        'python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],\'rb\').read()).hexdigest(), sys.argv[1])" "$1"\n',
        encoding="utf-8",
    )
    (bind / "runpodctl").write_text(
        "#!/bin/sh\n"
        'if [ "$1" = send ]; then\n'
        "  code=\n"
        "  prev=\n"
        "  for arg; do\n"
        '    if [ "$prev" = "--code" ]; then code="$arg"; fi\n'
        '    prev="$arg"\n'
        "  done\n"
        '  printf "%s-2\\n" "$code"\n'
        "  exit 0\n"
        "fi\n"
        "echo 'Error: unknown command \"pod\"' >&2\n"
        "exit 1\n",
        encoding="utf-8",
    )
    (bind / "curl").write_text(
        '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DELETED"\ncat > "$AUTH"\necho 204\nexit 0\n',
        encoding="utf-8",
    )
    (bind / "sleep").write_text(_park_long_sleep_stub(), encoding="utf-8")
    for path in bind.iterdir():
        path.chmod(0o755)
    env = _pod_env(
        tmp_path,
        bind,
        DELETED=str(deleted),
        AUTH=str(auth),
        RUNPOD_API_KEY="pod-scoped-injected-key",
    )
    proc = subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=20, check=False)
    removed = deleted.read_text(encoding="utf-8") if deleted.is_file() else ""
    header = auth.read_text(encoding="utf-8") if auth.is_file() else ""
    assert proc.returncode == 0
    assert "api.runpod.io/v2/pods/" + POD in removed
    assert "-H" in removed and "@-" in removed
    assert "pod-scoped-injected-key" not in removed
    assert "Authorization: Bearer pod-scoped-injected-key" in header
    assert KEY not in removed
    assert KEY not in header


def _read_http(conn: socket.socket) -> tuple[str, str]:
    conn.settimeout(5)
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = conn.recv(4096)
        if not chunk:
            break
        buf += chunk
    head, _, rest = buf.partition(b"\r\n\r\n")
    lines = head.decode("iso-8859-1").split("\r\n")
    method, target, _proto = lines[0].split(" ", 2)
    length = 0
    for line in lines[1:]:
        if line.lower().startswith("content-length:"):
            length = int(line.split(":", 1)[1].strip())
    while len(rest) < length:
        chunk = conn.recv(4096)
        if not chunk:
            break
        rest += chunk
    path = target.split("?", 1)[0]
    if path.startswith("/v2"):
        path = path[3:] or "/"
    return method, path


def _http_bytes(status: int, reason: str, body: bytes, *, content_type: str = "application/json") -> bytes:
    return (
        f"HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n"
    ).encode() + body


class _FakeRunpod:
    def __init__(self, handler):
        self.handler = handler
        self.calls: list[tuple[str, str]] = []
        self.errors: list[str] = []
        self._stop = threading.Event()
        self._srv = socket.socket()
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", 0))
        self._srv.listen(32)
        self.port = self._srv.getsockname()[1]
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        self._srv.settimeout(0.2)
        while not self._stop.is_set():
            try:
                conn, _addr = self._srv.accept()
            except TimeoutError:
                continue
            try:
                method, path = _read_http(conn)
                self.calls.append((method, path))
                self.handler(method, path, conn)
            except Exception as exc:
                self.errors.append(repr(exc))
            finally:
                try:
                    conn.close()
                except OSError:
                    pass

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)
        self._srv.close()


def _price_body() -> bytes:
    return json.dumps({"id": "NVIDIA GeForce RTX 4090", "price": {"secure": "0.89", "community": "0.30"}}).encode()


def _pod_body(status: str) -> bytes:
    return json.dumps(pod_payload(status)).encode()


def test_fake_server_garbage_status_line_deletes_the_pod(monkeypatch, tmp_path, capsys):
    def handler(method, path, conn):
        if method == "GET" and path.startswith("/catalog/gpus/"):
            conn.sendall(_http_bytes(200, "OK", _price_body()))
            return
        if method == "POST" and path == "/pods":
            conn.sendall(_http_bytes(201, "Created", _pod_body("PROVISIONING")))
            return
        if method == "GET" and path.startswith(f"/pods/{POD}") and "/logs" not in path:
            conn.sendall(b"HTTP/1.1 ABC Garbage\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            return
        if method == "POST" and path.endswith("/action"):
            conn.sendall(_http_bytes(200, "OK", b"{}"))
            return
        if method == "DELETE" and path == f"/pods/{POD}":
            conn.sendall(_http_bytes(204, "No Content", b""))
            return
        conn.sendall(_http_bytes(404, "No", b"{}"))

    server = _FakeRunpod(handler)
    arm(monkeypatch, tmp_path)
    monkeypatch.setattr("train.runpod.API", f"http://127.0.0.1:{server.port}/v2")
    try:
        code = main(["watch", "--mode", "calibrate"])
    finally:
        server.close()
    captured = capsys.readouterr()
    assert server.errors == []
    assert ("DELETE", f"/pods/{POD}") in server.calls
    assert code != 0
    assert "main train" not in captured.out
    assert "samples/sec" not in captured.out
    assert KEY not in captured.err
    assert journal_notes(tmp_path)


def test_fake_server_chunked_sse_parses_samples_per_sec(monkeypatch, tmp_path, capsys):
    released = []

    def handler(method, path, conn):
        if method == "GET" and path.startswith("/catalog/gpus/"):
            conn.sendall(_http_bytes(200, "OK", _price_body()))
            return
        if method == "POST" and path == "/pods":
            conn.sendall(_http_bytes(201, "Created", _pod_body("PROVISIONING")))
            return
        if method == "GET" and "/logs" in path:
            payload = b"data: " + calibrate_handover_logs("9.25").replace(b"\n", b"\ndata: ")
            chunk = f"{len(payload):x}\r\n".encode() + payload + b"\r\n"
            conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n" + chunk)
            conn.settimeout(5)
            started = time.monotonic()
            try:
                while True:
                    got = conn.recv(1024)
                    if not got:
                        break
            except TimeoutError:
                pass
            released.append(time.monotonic() - started)
            return
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            conn.sendall(_http_bytes(200, "OK", _pod_body("EXITED")))
            return
        if method == "POST" and path.endswith("/action"):
            conn.sendall(_http_bytes(200, "OK", b"{}"))
            return
        if method == "DELETE":
            conn.sendall(_http_bytes(204, "No Content", b""))
            return
        conn.sendall(_http_bytes(404, "No", b"{}"))

    server = _FakeRunpod(handler)
    arm(monkeypatch, tmp_path)
    monkeypatch.setattr("train.runpod.API", f"http://127.0.0.1:{server.port}/v2")
    try:
        code = main(["watch", "--mode", "calibrate"])
    finally:
        server.close()
    out = capsys.readouterr().out
    assert server.errors == []
    assert code == 0
    assert "samples/sec 9.25" in out
    assert f"main train {TRAIN.samples} samples:" in out
    assert released and released[0] < 2.0
    assert ("DELETE", f"/pods/{POD}") in server.calls


def test_fake_server_training_failure_log_has_no_projection(monkeypatch, tmp_path, capsys):
    def handler(method, path, conn):
        if method == "GET" and path.startswith("/catalog/gpus/"):
            conn.sendall(_http_bytes(200, "OK", _price_body()))
            return
        if method == "POST" and path == "/pods":
            conn.sendall(_http_bytes(201, "Created", _pod_body("PROVISIONING")))
            return
        if method == "GET" and "/logs" in path:
            body = b"No module named train\n"
            conn.sendall(_http_bytes(200, "OK", body, content_type="text/plain"))
            return
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            conn.sendall(_http_bytes(200, "OK", _pod_body("EXITED")))
            return
        if method == "POST" and path.endswith("/action"):
            conn.sendall(_http_bytes(200, "OK", b"{}"))
            return
        if method == "DELETE":
            conn.sendall(_http_bytes(204, "No Content", b""))
            return
        conn.sendall(_http_bytes(404, "No", b"{}"))

    server = _FakeRunpod(handler)
    arm(monkeypatch, tmp_path)
    monkeypatch.setattr("train.runpod.API", f"http://127.0.0.1:{server.port}/v2")
    try:
        code = main(["watch", "--mode", "calibrate"])
    finally:
        server.close()
    captured = capsys.readouterr()
    assert server.errors == []
    assert code != 0
    assert "samples/sec" not in captured.out
    assert "main train" not in captured.out
    assert ("DELETE", f"/pods/{POD}") in server.calls
    assert journal_notes(tmp_path)


def test_incomplete_log_read_still_parses_samples_per_sec(monkeypatch, tmp_path, capsys):
    import http.client

    arm(monkeypatch, tmp_path)

    class Partial(Resp):
        def __init__(self):
            super().__init__(200, b"")
            self._once = False

        def read(self, n=-1):
            if not self._once:
                self._once = True
                raise http.client.IncompleteRead(b"data: " + calibrate_handover_logs("4.5").replace(b"\n", b"\ndata: "))
            return b""

    def urlopen(request, timeout=30):
        method = request.get_method()
        path = request.full_url.split("/v2", 1)[-1]
        if method == "GET" and path.startswith("/catalog/gpus/"):
            return Resp(200, json.dumps({"price": {"secure": "0.89"}}).encode())
        if method == "POST" and path == "/pods":
            return Resp(201, json.dumps(pod_payload("PROVISIONING")).encode())
        if method == "GET" and "/logs" in path:
            return Partial()
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return Resp(200, json.dumps(pod_payload("EXITED")).encode())
        if method == "POST" and path.endswith("/action"):
            return Resp(200, b"{}")
        if method == "DELETE":
            return Resp(204, b"")
        raise AssertionError((method, path))

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    assert main(["watch", "--mode", "calibrate"]) == 0
    out = capsys.readouterr().out
    assert "samples/sec 4.5" in out
    assert "main train" in out


def test_runtime_error_after_create_still_deletes(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)

    def urlopen(request, timeout=30):
        method = request.get_method()
        path = request.full_url.split("/v2", 1)[-1]
        if method == "GET" and path.startswith("/catalog/gpus/"):
            return Resp(200, json.dumps({"price": {"secure": "0.89"}}).encode())
        if method == "POST" and path == "/pods":
            return Resp(201, json.dumps(pod_payload("PROVISIONING")).encode())
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            raise RuntimeError("poll exploded")
        if method == "POST" and path.endswith("/action"):
            return Resp(200, b"{}")
        if method == "DELETE":
            return Resp(204, b"")
        raise AssertionError((method, path))

    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    code = main(["watch", "--mode", "calibrate"])
    captured = capsys.readouterr()
    assert code != 0
    assert "main train" not in captured.out
    assert journal_notes(tmp_path)
    assert not (tmp_path / "runpod-active-pod.json").exists()


def test_absent_pod_still_reads_a_rate(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)

    def handler(method, path, _body):
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and "/logs" in path:
            return 200, calibrate_handover_logs("3.5")
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return 404, {"title": "gone"}
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE":
            return 204, {}
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    assert main(["watch", "--mode", "calibrate"]) == 0
    out = capsys.readouterr().out
    assert any("/logs" in path for _method, path, _body in calls)
    assert "samples/sec 3.5" in out
    assert "main train" in out
    assert deletes(calls) == [f"/pods/{POD}"]


def test_artifact_receive_regex_requires_relay_index():
    from train.runpod import parse_artifact_receive, parse_artifact_sha256

    code = "abcd-ef01-2345-6789-2"
    digest = "a" * 64
    blob = json.dumps({"line": f"fontsnap_artifact_receive {code}"})
    assert parse_artifact_receive(blob) == code
    # Four-part codes (missing relay index) must not match — receive would fail.
    assert parse_artifact_receive("fontsnap_artifact_receive abcd-ef01-2345-6789") is None
    assert parse_artifact_sha256(f'fontsnap_artifact_sha256 {digest}"}}') == digest
    assert parse_artifact_receive("fontsnap_artifact_receive not-a-code") is None


def test_publish_prints_full_code_from_send_stdout_before_wait(tmp_path):
    """Mimic runpodctl v1.14.4: send prints base-relayIndex then blocks (B4)."""
    work = tmp_path / "pod-work"
    art = work / "out" / "train"
    art.mkdir(parents=True)
    (art / "ckpt-final.pt").write_bytes(b"ckpt-bytes")
    bind = tmp_path / "bin"
    bind.mkdir()
    send_log = tmp_path / "send.log"
    (bind / "runpodctl").write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$SEND_LOG"\n'
        'if [ "$1" = send ]; then\n'
        "  code=\n"
        "  prev=\n"
        "  for arg; do\n"
        '    if [ "$prev" = "--code" ]; then code="$arg"; fi\n'
        '    prev="$arg"\n'
        "  done\n"
        "  # 1.14.15 without config.toml prints a banner on stdout before the code.\n"
        '  printf "%s\\n" "Runpod config file not found, please run runpodctl config to create it"\n'
        "  # Real runpodctl appends a relay index and prints the full secret.\n"
        '  printf "%s-2\\n" "$code"\n'
        "  exec sleep 1000\n"
        "fi\n"
        "exit 0\n",
        encoding="utf-8",
    )
    (bind / "timeout").write_text(
        "#!/bin/sh\n"
        # drop the duration arg and run the rest
        "shift\n"
        'exec "$@"\n',
        encoding="utf-8",
    )
    (bind / "sha256sum").write_text(
        "#!/bin/sh\n"
        'python3 -c "import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],\'rb\').read()).hexdigest(), sys.argv[1])" "$1"\n',
        encoding="utf-8",
    )
    for path in bind.iterdir():
        path.chmod(0o755)
    # Only the publish fragment, with WORK set.
    from train.runpod import _publish_artifacts_shell

    script = 'set -u\nWORK="$FONTSNAP_POD_WORK"\nstatus=0\n' + _publish_artifacts_shell() + "echo STATUS:$status\n"
    env = _pod_env(tmp_path, bind, SEND_LOG=str(send_log))
    # Override work to the prepared tree (helper already created pod-work).
    env["FONTSNAP_POD_WORK"] = str(work)
    proc = subprocess.Popen(
        ["bash", "-c", script],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 5
        buf = ""
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if line:
                buf += line
            if "fontsnap_artifact_receive" in buf and "fontsnap_artifact_sha256" in buf:
                break
            if proc.poll() is not None:
                break
        else:
            raise AssertionError(f"code not printed before send blocked; got {buf!r}")
        assert "fontsnap_artifact_sha256" in buf
        assert "fontsnap_artifact_receive" in buf
        from train.runpod import parse_artifact_receive

        full = parse_artifact_receive(buf)
        assert full is not None and full.count("-") == 4 and full.endswith("-2")
        # send must have started (and be blocked)
        time.sleep(0.2)
        assert proc.poll() is None
        assert send_log.is_file() and "send --code" in send_log.read_text(encoding="utf-8")
    finally:
        _kill_process_group(proc)


def test_receive_artifact_strips_api_key_and_checks_sha(tmp_path, monkeypatch):
    import hashlib

    import train.runpod as runpod

    monkeypatch.setattr(runpod, "ARTIFACT_TRANSFER_SECONDS", 5)
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    monkeypatch.setenv("RUNPOD_API_KEY", KEY)
    dest = tmp_path / "train"
    dest.mkdir()
    payload = b"weights-v2"
    digest = hashlib.sha256(payload).hexdigest()
    seen = {}
    full_code = "abcd-ef01-2345-6789-2"

    def fake_run(cmd, cwd=None, check=None, timeout=None, env=None):
        seen["cmd"] = cmd
        seen["env"] = env
        assert "RUNPOD_API_KEY" not in (env or {})
        assert cmd[2] == full_code
        Path(cwd).joinpath("incoming.tgz").write_bytes(payload)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", fake_run)
    path = runpod.receive_artifact(full_code, digest)
    assert path == dest / "fontsnap-ofl-v1.tgz"
    assert path.read_bytes() == payload
    assert seen["cmd"][:2] == ["runpodctl", "receive"]

    def write_bad(cmd, cwd=None, check=None, timeout=None, env=None):
        Path(cwd).joinpath("bad.tgz").write_bytes(b"other")
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(subprocess, "run", write_bad)
    with pytest.raises(ValueError, match="sha256"):
        runpod.receive_artifact(full_code, digest)
    assert not (dest / "bad.tgz").exists()


def test_train_watch_receives_artifact_while_running(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)
    code = "abcd-ef01-2345-6789-2"
    digest = "b" * 64
    got = {"receive": 0}

    def handler(method, path, body):
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and path.startswith(f"/pods/{POD}/logs"):
            line = f"fontsnap_artifact_sha256 {digest}\nfontsnap_artifact_receive {code}\n"
            return 200, line.encode()
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            # Stay RUNNING until receive has been attempted, then EXITED.
            status = "EXITED" if got["receive"] else "RUNNING"
            return 200, pod_payload(status)
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE":
            return 204, {}
        raise AssertionError((method, path))

    install(monkeypatch, handler)

    def fake_receive(recv_code, expected_sha):
        got["receive"] += 1
        assert recv_code == code
        assert expected_sha == digest
        path = tmp_path / "train" / "fontsnap-ofl-v1.tgz"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"ok")
        return path

    monkeypatch.setattr("train.runpod.receive_artifact", fake_receive)
    monkeypatch.setattr("train.runpod.read_calibrate_rate", lambda: Decimal("12.5"))
    assert main(["watch", "--mode", "train"]) == 0
    assert got["receive"] == 1
    out = capsys.readouterr().out
    assert "artifact" in out


def test_train_watch_fails_loudly_without_artifact(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)

    def handler(method, path, _body):
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and "/logs" in path:
            return 200, b"training done\n"
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return 200, pod_payload("EXITED")
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE":
            return 204, {}
        raise AssertionError((method, path))

    install(monkeypatch, handler)
    monkeypatch.setattr("train.runpod.read_calibrate_rate", lambda: Decimal("12.5"))
    assert main(["watch", "--mode", "train"]) == 4
    err = capsys.readouterr().err
    assert "without a verified artifact" in err


def test_slow_calibrate_rate_refuses_train_under_cap(monkeypatch, tmp_path, capsys):
    """N7: ~2.27 samples/s fits $17 estimate without transfer slack but exceeds capped max_runtime."""
    arm(monkeypatch, tmp_path)
    (tmp_path / "runpod-calibrate-rate.txt").write_text("2.27\n", encoding="utf-8")
    calls = install(monkeypatch, lambda *_a: (_ for _ in ()).throw(AssertionError("urlopen")))
    assert main(["watch", "--mode", "train"]) == 3
    err = capsys.readouterr().err
    assert "refusing train" in err
    assert calls == []


def test_pod_self_delete_shell_still_rejects_404():
    """N13: in-pod curl must not treat 404 as success (wrong path / rights)."""
    from train.runpod import _DELETE_OK, self_delete_shell

    assert 404 not in _DELETE_OK
    assert "404" not in self_delete_shell()
