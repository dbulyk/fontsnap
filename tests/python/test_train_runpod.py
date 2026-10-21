import io
import json
import os
import signal
import subprocess
import sys
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
    plan,
    projected_spend,
    watch,
)

REPO = Path(__file__).resolve().parents[2]
PYTHON = REPO / "python"
KEY = "super-secret-key-9f3a"
POD = "pod-1"


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
    assert f"timeout {CALIBRATE.max_runtime_seconds} python -m train.loop --recipe smoke --steps {CALIBRATE.samples}" in script
    assert "samples/sec" in script
    assert 'runpodctl remove pod "$RUNPOD_POD_ID"' in script
    assert "RUNPOD_API_KEY" not in json.dumps(body)
    assert "env" not in body
    train = create_body(TRAIN)["cmd"][0]
    assert f"timeout {TRAIN.max_runtime_seconds} python -m train.loop --recipe ofl-v1" in train
    assert 'runpodctl remove pod "$RUNPOD_POD_ID"' in train


def test_calibrate_spend_cap_exits_3_above_one_dollar():
    assert CALIBRATE.max_runtime_seconds == 20 * 60
    assert CALIBRATE.spend_cap_usd == Decimal("1.00")
    assert CALIBRATE.samples == 8
    assert TRAIN.samples == 100_000
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
            line = json.dumps({"ts": "2026-01-01T00:00:00Z", "source": "container", "line": "samples/sec 12.5"})
            return 200, f"id: 1\ndata: {line}\n".encode()
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
    assert "main train 100000 samples: 2.222222 h $1.977778" in out
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
            return 200, b"samples/sec 12.5\n"
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
    assert "2.222222 h $1.977778" in out


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
    assert deletes(calls) == [f"/pods/{POD}"] or (code != 0 and POD in err)
    assert deletes(calls)
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
            return 200, b"samples/sec 12.5\n"
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
            return Resp(200, b"samples/sec 12.5\n")
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


def test_delete_404_is_success(monkeypatch, tmp_path, capsys):
    arm(monkeypatch, tmp_path)

    def handler(method, path, _body):
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and "/logs" in path:
            return 200, b"samples/sec 12.5\n"
        if method == "GET" and path.startswith(f"/pods/{POD}"):
            return 200, pod_payload("EXITED")
        if method == "POST" and path.endswith("/action"):
            return 200, {}
        if method == "DELETE":
            return 404, {"title": "Not Found"}
        raise AssertionError((method, path))

    calls = install(monkeypatch, handler)
    assert main(["watch", "--mode", "calibrate"]) == 0
    assert deletes(calls) == [f"/pods/{POD}"]
    assert "DELETE FAILED" not in capsys.readouterr().err
    assert journal_notes(tmp_path) == ["deleted"]


def test_stale_active_pod_is_deleted_before_create(monkeypatch, tmp_path):
    arm(monkeypatch, tmp_path)
    (tmp_path / "runpod-active-pod.json").write_text(json.dumps({"id": "stale-pod", "mode": "calibrate", "name": "old"}) + "\n", encoding="utf-8")
    order = []

    def handler(method, path, _body):
        order.append((method, path))
        if method == "DELETE" and path == "/pods/stale-pod":
            return 204, {}
        hit = price_and_create(method, path)
        if hit:
            return hit
        if method == "GET" and "/logs" in path:
            return 200, b"samples/sec 12.5\n"
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
    deleted = f"DELETE /pods/pod-sig" in logged
    assert deleted or (proc.returncode != 0 and "pod-sig" in proc.stderr)
    assert deleted
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
