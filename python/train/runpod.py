"""RunPod launcher. Plan does not read RUNPOD_API_KEY and does not open a socket.

The client calls API v2 at https://api.runpod.io/v2.
Reference https://docs.runpod.io/api-reference-v2/.
The secure hourly price is price.secure from GET https://api.runpod.io/v2/catalog/gpus/{id}
(https://docs.runpod.io/api-reference-v2/catalog/get-a-gpu-type).
CreatePodRequest sends name, image, cloud SECURE, gpu id and count, disk, and the container
start command as entrypoint and cmd. v1 called that command dockerStartCmd. v2 stores it as args.

The pod fetches this repository at the commit git rev-parse HEAD returned when the plan was
built, installs train deps, and runs the work on the GPU. A background sleep+delete watchdog
covers the whole lifetime within max_runtime_seconds. Self-delete tries legacy
runpodctl remove pod, then runpodctl pod delete, then DELETE via the pod-scoped
RUNPOD_API_KEY Runpod injects (never our client key). A done marker skips re-work if the
container restarts after a failed delete. Calibrate prints samples/sec only on exit 0.
The client stops and deletes the pod in a finally block on every exit.

Free-phase command:

    python -m train.runpod plan --mode calibrate

Live calibrate needs RUNPOD_API_KEY and FONTSNAP_RUNPOD_LIVE=1.
It refuses a price that would pass $1 in 20 minutes.

    FONTSNAP_RUNPOD_LIVE=1 python -m train.runpod watch --mode calibrate
"""

from __future__ import annotations

import http.client
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from enum import Enum
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from train.paths import ROOT, assert_under_out

API = "https://api.runpod.io/v2"
_PUBLIC_REPO = "https://github.com/dbulyk/fontsnap.git"
_LOG_SETTLE_SECONDS = 45
PLAN_CALIBRATE = "python -m train.runpod plan --mode calibrate"
LIVE_CALIBRATE = "FONTSNAP_RUNPOD_LIVE=1 python -m train.runpod watch --mode calibrate"
_REJECT = ("--api-key", "--apikey")
_POLL_SECONDS = 5
_TRANSIENT_HTTP = frozenset({429, 500, 502, 503, 504})
_TRANSIENT_LIMIT = 4
_DELETE_OK = frozenset({200, 202, 204, 404})
_DELETE_BACKOFF = (1, 2, 4, 8)
_SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
_QUANTUM = Decimal("0.000001")


class _Shutdown(BaseException):
    def __init__(self, signum: int) -> None:
        super().__init__(signum)
        self.signum = signum


class PodState(str, Enum):
    PROVISIONING = "PROVISIONING"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    EXITED = "EXITED"
    ERROR = "ERROR"
    TERMINATED = "TERMINATED"
    ABSENT = "ABSENT"
    UNKNOWN = "UNKNOWN"


class JobMode(str, Enum):
    CALIBRATE = "calibrate"
    TRAIN = "train"


class RemoteAction(str, Enum):
    START = "start"
    STOP = "stop"
    RESTART = "restart"
    TERMINATE = "terminate"


_DONE_STATES = frozenset({PodState.EXITED, PodState.TERMINATED, PodState.ABSENT})
_WAIT_STATES = frozenset({PodState.PROVISIONING, PodState.STARTING})


@dataclass(frozen=True, slots=True)
class RunPodJobSpec:
    name: str
    mode: JobMode
    gpu_id: str
    gpu_count: int
    cloud: Literal["SECURE"]
    image: str
    disk_gb: int
    max_runtime_seconds: int
    spend_cap_usd: Decimal
    samples: int
    env: tuple[tuple[str, str], ...]


@dataclass(frozen=True, slots=True)
class RemotePod:
    id: str
    name: str
    state: PodState
    hourly_usd: Decimal
    cloud: str
    gpu_id: str
    actions: frozenset[str]
    started_at: str | None
    http_status: int = 200


@dataclass(frozen=True, slots=True)
class CostLine:
    ts: str
    mode: str
    pod_id: str
    state: str
    hourly_usd: str
    minutes: str
    estimated_usd: str
    note: str

    def as_json(self) -> str:
        return json.dumps(
            {
                "ts": self.ts,
                "mode": self.mode,
                "pod_id": self.pod_id,
                "state": self.state,
                "hourly_usd": self.hourly_usd,
                "minutes": self.minutes,
                "estimated_usd": self.estimated_usd,
                "note": self.note,
            },
            separators=(",", ":"),
        )


CALIBRATE = RunPodJobSpec(
    name="fontsnap-calibrate",
    mode=JobMode.CALIBRATE,
    gpu_id="NVIDIA GeForce RTX 4090",
    gpu_count=1,
    cloud="SECURE",
    image="runpod/pytorch:1.0.2-cu1281-torch280-ubuntu2404",
    disk_gb=20,
    max_runtime_seconds=20 * 60,
    spend_cap_usd=Decimal("1.00"),
    samples=8,
    env=(),
)

TRAIN = RunPodJobSpec(
    name="fontsnap-train",
    mode=JobMode.TRAIN,
    gpu_id=CALIBRATE.gpu_id,
    gpu_count=1,
    cloud="SECURE",
    image=CALIBRATE.image,
    disk_gb=20,
    max_runtime_seconds=4 * 60 * 60,
    spend_cap_usd=Decimal("4.00"),
    samples=100_000,
    env=(),
)


def api_key() -> str:
    key = os.environ.get("RUNPOD_API_KEY")
    if not key:
        raise SystemExit(2)
    return key


def live_enabled() -> bool:
    return os.environ.get("FONTSNAP_RUNPOD_LIVE") == "1"


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def parse_pod(payload: dict, *, status_code: int) -> RemotePod:
    if status_code == 404:
        return RemotePod(
            id="",
            name="",
            state=PodState.ABSENT,
            hourly_usd=Decimal("0"),
            cloud="",
            gpu_id="",
            actions=frozenset(),
            started_at=None,
        )
    status = _text(payload.get("status"))
    try:
        state = PodState(status)
    except ValueError:
        state = PodState.UNKNOWN
    raw_actions = payload.get("actions") or []
    actions = frozenset(item for item in raw_actions if isinstance(item, str)) if isinstance(raw_actions, list) else frozenset()
    gpu = payload.get("gpu")
    gpu_id = _text(gpu.get("id")) if isinstance(gpu, dict) else ""
    try:
        hourly = Decimal(str(payload.get("cost", 0)))
    except (InvalidOperation, ValueError):
        hourly = Decimal("0")
    started = payload.get("startedAt")
    return RemotePod(
        id=_text(payload.get("id")),
        name=_text(payload.get("name")),
        state=state,
        hourly_usd=hourly,
        cloud=_text(payload.get("cloud")),
        gpu_id=gpu_id,
        actions=actions,
        started_at=started if isinstance(started, str) else None,
    )


def pinned_commit() -> str:
    override = os.environ.get("FONTSNAP_RUNPOD_COMMIT", "").strip()
    if override:
        if not re.fullmatch(r"[0-9a-f]{40}", override):
            raise ValueError("FONTSNAP_RUNPOD_COMMIT must be a full 40-char lowercase sha")
        return override
    try:
        out = subprocess.check_output(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise RuntimeError("cannot pin repository commit for the pod script") from exc
    sha = out.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise RuntimeError(f"unexpected git rev-parse output: {sha!r}")
    return sha


def _self_delete_deadline(spec: RunPodJobSpec) -> int:
    # Must not exceed the spend-cap window (max_runtime_seconds).
    return spec.max_runtime_seconds


def self_delete_shell() -> str:
    """Shell that terminates this pod with whatever the image actually has.

    Live pytorch images ship an older runpodctl where `pod delete` is unknown and
    `remove pod` still works. Runpod also injects a pod-scoped RUNPOD_API_KEY.
    """
    return (
        "_fontsnap_self_delete() {\n"
        '  runpodctl remove pod "$RUNPOD_POD_ID" && return 0\n'
        '  runpodctl pod delete "$RUNPOD_POD_ID" && return 0\n'
        '  if [ -n "${RUNPOD_API_KEY:-}" ]; then\n'
        '    curl -sS -o /dev/null -w "%{http_code}" -X DELETE '
        '-H "Authorization: Bearer $RUNPOD_API_KEY" '
        '"https://api.runpod.io/v2/pods/$RUNPOD_POD_ID" | grep -Eq "^(200|202|204|404)$" && return 0\n'
        "  fi\n"
        '  echo "fontsnap: self-delete failed for $RUNPOD_POD_ID" >&2\n'
        "  return 1\n"
        "}\n"
    )


def container_script(spec: RunPodJobSpec, *, commit: str | None = None) -> str:
    sha = commit if commit is not None else pinned_commit()
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError(f"bad commit pin: {sha!r}")
    deadline = _self_delete_deadline(spec)
    # Leave room inside the deadline for the post-success log settle.
    settle = min(_LOG_SETTLE_SECONDS, max(0, deadline // 20))
    if spec.mode is JobMode.CALIBRATE:
        train = f"python -m train.loop --recipe calibrate --steps {spec.samples} --device cuda"
        on_ok = f"  cat /tmp/fontsnap-train.out\n  sleep {settle}\n" if settle else "  cat /tmp/fontsnap-train.out\n"
    else:
        train = "python -m train.loop --recipe ofl-v1 --device cuda"
        on_ok = "  cat /tmp/fontsnap-train.out\n"
    # Watchdog first. Done marker short-circuits a restart loop after a failed delete.
    return (
        "set -u\n"
        f"{self_delete_shell()}"
        f"(sleep {deadline}; _fontsnap_self_delete) &\n"
        "WATCHDOG_PID=$!\n"
        "trap 'kill $WATCHDOG_PID 2>/dev/null || true' EXIT\n"
        'DONE="${FONTSNAP_DONE_MARKER:-/var/lib/fontsnap/done}"\n'
        'mkdir -p "$(dirname "$DONE")"\n'
        'if [ -f "$DONE" ]; then\n'
        '  echo "fontsnap: prior run finished; deleting pod without re-work" >&2\n'
        "  _fontsnap_self_delete\n"
        "  exit 4\n"
        "fi\n"
        "export DEBIAN_FRONTEND=noninteractive\n"
        "apt-get update -qq >/dev/null\n"
        "apt-get install -y -qq git git-lfs curl >/dev/null\n"
        "git lfs install --skip-repo >/dev/null\n"
        "rm -rf /tmp/fontsnap\n"
        "mkdir -p /tmp/fontsnap\n"
        "cd /tmp/fontsnap\n"
        "git init -q\n"
        f"git remote add origin {_PUBLIC_REPO}\n"
        f"git fetch --depth 1 origin {sha}\n"
        "GIT_LFS_SKIP_SMUDGE=1 git checkout -q --detach FETCH_HEAD\n"
        "git lfs pull --include='model/**'\n"
        "python -m pip install -q -r python/requirements.txt -r python/train/requirements.txt\n"
        "export FONTSNAP_ALLOW_GPU=1\n"
        "export PYTHONPATH=/tmp/fontsnap/python\n"
        f"{train} >/tmp/fontsnap-train.out 2>/tmp/fontsnap-train.err\n"
        "status=$?\n"
        "cat /tmp/fontsnap-train.err >&2\n"
        'if [ "$status" -eq 0 ]; then\n'
        f"{on_ok}"
        "fi\n"
        'touch "$DONE"\n'
        "_fontsnap_self_delete\n"
        'exit "$status"\n'
    )


def create_body(spec: RunPodJobSpec) -> dict:
    if spec.env:
        raise ValueError("pod env must be empty")
    return {
        "name": spec.name,
        "image": spec.image,
        "cloud": spec.cloud,
        "gpu": {"id": spec.gpu_id, "count": spec.gpu_count},
        "disk": spec.disk_gb,
        "entrypoint": ["/bin/bash", "-lc"],
        "cmd": [container_script(spec)],
    }


def projected_spend(spec: RunPodJobSpec, hourly_usd: Decimal) -> Decimal:
    return hourly_usd * Decimal(spec.max_runtime_seconds) / Decimal(3600)


def check_spend(spec: RunPodJobSpec, hourly_usd: Decimal) -> None:
    if projected_spend(spec, hourly_usd) > spec.spend_cap_usd:
        raise SystemExit(3)


def render_plan(spec: RunPodJobSpec) -> str:
    minutes = spec.max_runtime_seconds // 60
    body = json.dumps(create_body(spec), indent=2)
    lines = [
        f"mode {spec.mode.value}",
        f"gpu {spec.gpu_id} x{spec.gpu_count} cloud {spec.cloud}",
        f"image {spec.image}",
        f"max_runtime_seconds {spec.max_runtime_seconds} ({minutes} min)",
        f"spend_cap_usd {spec.spend_cap_usd}",
        f"cap arithmetic: hourly_usd * {spec.max_runtime_seconds}/3600 must be <= {spec.spend_cap_usd} before create",
        "create body:",
        body,
        "finally: act stop, then delete_pod",
        "journal: estimated_usd=0 note=dry-plan",
        "",
        "# free phase (this command):",
        PLAN_CALIBRATE,
        "",
        "# live calibrate, not this phase, 20 min then stop+delete, cap $1:",
        f"# {LIVE_CALIBRATE}",
    ]
    return "\n".join(lines) + "\n"


def default_journal() -> Path:
    from train import paths

    return paths.OUT / "runpod-cost.jsonl"


def _active_path() -> Path:
    from train import paths

    return paths.OUT / "runpod-active-pod.json"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def append_cost(path: Path, line: CostLine, *, scrub_key: bool) -> None:
    text = line.as_json()
    if scrub_key:
        key = os.environ.get("RUNPOD_API_KEY", "")
        if key and key in text:
            return
    resolved = assert_under_out(path)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    with resolved.open("a", encoding="utf-8") as handle:
        handle.write(text + "\n")


def _write_active(pod_id: str, spec: RunPodJobSpec) -> None:
    path = assert_under_out(_active_path())
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps({"id": pod_id, "mode": spec.mode.value, "name": spec.name}, separators=(",", ":")) + "\n"
    secret = os.environ.get("RUNPOD_API_KEY", "")
    if secret and secret in text:
        raise SystemExit(4)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(path)


def _read_active() -> dict | None:
    path = _active_path()
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("id"), str) or not payload["id"]:
        return None
    return payload


def _clear_active() -> None:
    path = _active_path()
    if path.is_file():
        path.unlink()


def plan(spec: RunPodJobSpec, journal: Path | None = None) -> str:
    text = render_plan(spec)
    line = CostLine(
        ts=_now(),
        mode=spec.mode.value,
        pod_id="",
        state=PodState.ABSENT.value,
        hourly_usd="0",
        minutes="0",
        estimated_usd="0",
        note="dry-plan",
    )
    append_cost(default_journal() if journal is None else journal, line, scrub_key=False)
    return text


def _read_all(response, *, limit: int = 1_000_000, stop_when: re.Pattern[str] | None = None) -> bytes:
    chunks: list[bytes] = []
    total = 0
    # A multi-byte chunked read asks urllib for the next chunk. If that stalls, the
    # timeout is raised inside read() and the bytes already taken from this chunk are dropped.
    size = 1 if stop_when is not None else 8192
    while total < limit:
        try:
            block = response.read(size)
        except http.client.IncompleteRead as err:
            if err.partial:
                chunks.append(err.partial)
            break
        except (TimeoutError, OSError, http.client.HTTPException):
            break
        if not block:
            break
        chunks.append(block)
        total += len(block)
        if stop_when is not None and _rate_text_settled(b"".join(chunks).decode(errors="replace"), stop_when):
            break
    return b"".join(chunks)


def _rate_text_settled(text: str, pattern: re.Pattern[str]) -> bool:
    # The number may still be arriving. "9" is not "9.25" until a non-number byte follows.
    match = pattern.search(text)
    if match is None or match.end() >= len(text):
        return False
    return text[match.end()] not in "0123456789."


def _http_raw(
    method: str,
    path: str,
    key: str,
    body: dict | None = None,
    *,
    timeout: float = 30,
    stop_when: re.Pattern[str] | None = None,
) -> tuple[int, bytes]:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(API + path, data=data, method=method)
    request.add_header("Authorization", "Bearer " + key)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, _read_all(response, stop_when=stop_when)
    except urllib.error.HTTPError as err:
        try:
            raw = err.read()
        except (TimeoutError, OSError, http.client.HTTPException):
            raw = b""
        return err.code, raw


def _http_json(method: str, path: str, key: str, body: dict | None = None) -> tuple[int, dict]:
    status, raw = _http_raw(method, path, key, body)
    if not raw:
        return status, {}
    try:
        payload = json.loads(raw.decode())
    except (UnicodeDecodeError, json.JSONDecodeError):
        return status, {}
    if not isinstance(payload, dict):
        return status, {}
    return status, payload


def get_gpu_price(gpu_id: str, key: str) -> Decimal:
    status, payload = _http_json("GET", "/catalog/gpus/" + quote(gpu_id, safe=""), key)
    if status != 200:
        raise SystemExit(4)
    price = payload.get("price")
    if not isinstance(price, dict) or "secure" not in price:
        raise SystemExit(4)
    try:
        return Decimal(str(price["secure"]))
    except (InvalidOperation, ValueError):
        raise SystemExit(4) from None


def create_pod(spec: RunPodJobSpec, key: str) -> RemotePod:
    status, payload = _http_json("POST", "/pods", key, create_body(spec))
    if status not in (200, 201):
        raise SystemExit(4)
    pod = parse_pod(payload, status_code=status)
    if not pod.id:
        raise SystemExit(4)
    _write_active(pod.id, spec)
    return pod


def _held(pod_id: str, state: PodState, http_status: int) -> RemotePod:
    return RemotePod(
        id=pod_id,
        name="",
        state=state,
        hourly_usd=Decimal("0"),
        cloud="",
        gpu_id="",
        actions=frozenset(),
        started_at=None,
        http_status=http_status,
    )


def get_pod(pod_id: str, key: str) -> RemotePod:
    path = "/pods/" + quote(pod_id, safe="")
    try:
        status, payload = _http_json("GET", path, key)
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException, ValueError):
        return _held(pod_id, PodState.UNKNOWN, 0)
    if status == 404:
        return _held(pod_id, PodState.ABSENT, 404)
    if status != 200:
        return _held(pod_id, PodState.UNKNOWN, status)
    pod = parse_pod(payload, status_code=status)
    if pod.id != pod_id:
        pod = replace(pod, id=pod_id)
    return replace(pod, http_status=status)


def act(pod_id: str, action: str, key: str) -> None:
    if action not in {item.value for item in RemoteAction}:
        raise ValueError(action)
    status, _payload = _http_json("POST", "/pods/" + quote(pod_id, safe="") + "/action", key, {"action": action})
    if status not in (200, 201, 204):
        raise SystemExit(4)


def delete_pod(pod_id: str, key: str) -> bool:
    path = "/pods/" + quote(pod_id, safe="")
    delays = iter(_DELETE_BACKOFF)
    while True:
        try:
            status, _payload = _http_json("DELETE", path, key)
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
            status = 0
        if status in _DELETE_OK:
            return True
        if status not in _TRANSIENT_HTTP and status != 0:
            return False
        try:
            delay = next(delays)
        except StopIteration:
            return False
        time.sleep(delay)


def manual_delete_command(pod_id: str) -> str:
    return f'curl -sS -X DELETE -H "Authorization: Bearer $RUNPOD_API_KEY" https://api.runpod.io/v2/pods/{quote(pod_id, safe="")}'


def _report_delete_failed(pod_id: str) -> None:
    print(f"DELETE FAILED {pod_id}", file=sys.stderr)
    print(manual_delete_command(pod_id), file=sys.stderr)


def _teardown(pod_id: str, key: str, *, mode: str, hourly: Decimal, started: float, state: str) -> bool:
    try:
        act(pod_id, RemoteAction.STOP.value, key)
    except (Exception, SystemExit):
        pass
    deleted = delete_pod(pod_id, key)
    elapsed_min = Decimal(str((time.monotonic() - started) / 60))
    estimated = hourly * elapsed_min / Decimal(60)
    append_cost(
        default_journal(),
        CostLine(
            ts=_now(),
            mode=mode,
            pod_id=pod_id,
            state=state,
            hourly_usd=format(hourly, "f"),
            minutes=format(elapsed_min, "f"),
            estimated_usd=format(estimated, "f"),
            note="deleted" if deleted else "DELETE FAILED",
        ),
        scrub_key=True,
    )
    if deleted:
        _clear_active()
    else:
        _report_delete_failed(pod_id)
    return deleted


_SAMPLES_PER_SEC = re.compile(r"samples/sec(?:=|\s+)(\d+(?:\.\d+)?)")


def parse_samples_per_sec(text: str) -> Decimal | None:
    found = _SAMPLES_PER_SEC.findall(text)
    if not found:
        return None
    try:
        rate = Decimal(found[-1])
    except InvalidOperation:
        return None
    if rate <= 0:
        return None
    return rate


def _latest_rate(pod_id: str, key: str, prior: Decimal | None) -> Decimal | None:
    path = "/pods/" + quote(pod_id, safe="") + "/logs?source=container&tail=200"
    try:
        # SSE stays open; read in small chunks and stop once samples/sec appears.
        status, raw = _http_raw("GET", path, key, timeout=2.5, stop_when=_SAMPLES_PER_SEC)
    except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException):
        return prior
    if status != 200:
        return prior
    try:
        text = raw.decode(errors="replace")
    except UnicodeDecodeError:
        return prior
    parsed = parse_samples_per_sec(text)
    return prior if parsed is None else parsed


def project_main_train(rate: Decimal, hourly_usd: Decimal) -> tuple[Decimal, Decimal]:
    hours = Decimal(TRAIN.samples) / rate / Decimal(3600)
    usd = hours * hourly_usd
    return (
        hours.quantize(_QUANTUM, rounding=ROUND_HALF_UP),
        usd.quantize(_QUANTUM, rounding=ROUND_HALF_UP),
    )


def _print_projection(rate: Decimal, hourly_usd: Decimal) -> None:
    hours, usd = project_main_train(rate, hourly_usd)
    print(f"samples/sec {format(rate, 'f')}")
    print(f"main train {TRAIN.samples} samples: {format(hours, 'f')} h ${format(usd, 'f')}")


def _poll(pod_id: str, key: str, spec: RunPodJobSpec, deadline: float) -> tuple[int, Decimal | None, str]:
    rate: Decimal | None = None
    transient = 0
    state = PodState.PROVISIONING.value
    while time.monotonic() < deadline:
        pod = get_pod(pod_id, key)
        state = pod.state.value
        if pod.cloud.upper() == "COMMUNITY":
            return 4, rate, state
        if pod.http_status in _TRANSIENT_HTTP or pod.http_status == 0:
            transient += 1
            if transient >= _TRANSIENT_LIMIT:
                return 4, rate, state
            time.sleep(_POLL_SECONDS)
            continue
        transient = 0
        if pod.http_status in {401, 403}:
            return 4, rate, state
        if pod.state is PodState.RUNNING:
            rate = _latest_rate(pod_id, key, rate)
            time.sleep(_POLL_SECONDS)
            continue
        if pod.state in _WAIT_STATES:
            time.sleep(_POLL_SECONDS)
            continue
        if pod.state in _DONE_STATES:
            # ABSENT (self-delete) and EXITED both keep trying logs once.
            rate = _latest_rate(pod_id, key, rate)
            if spec.mode is JobMode.CALIBRATE and rate is None:
                return 4, rate, state
            return 0, rate, state
        return 4, rate, state
    if spec.mode is JobMode.CALIBRATE and rate is None:
        return 4, rate, state
    return 0, rate, state


def _over_calibrate_cap(spec: RunPodJobSpec) -> bool:
    return spec.mode is JobMode.CALIBRATE and (spec.max_runtime_seconds > 20 * 60 or spec.spend_cap_usd > Decimal("1.00"))


def _install_signals(handler) -> dict:
    return {sig: signal.signal(sig, handler) for sig in _SIGNALS}


def _restore_signals(previous: dict) -> None:
    for sig, old in previous.items():
        signal.signal(sig, old)


def _watch(spec: RunPodJobSpec) -> int:
    if not live_enabled():
        raise SystemExit(2)
    if _over_calibrate_cap(spec):
        raise SystemExit(3)
    key = api_key()
    holder = {"cleaning": False}
    pod_id: str | None = None
    code = 0
    rate: Decimal | None = None
    hourly = Decimal("0")
    started = time.monotonic()
    state = PodState.PROVISIONING.value

    def handler(signum, _frame):
        if holder["cleaning"]:
            return
        raise _Shutdown(signum)

    previous = _install_signals(handler)
    try:
        try:
            stale = _read_active()
            if stale is not None:
                holder["cleaning"] = True
                try:
                    stale_ok = _teardown(
                        str(stale["id"]),
                        key,
                        mode=str(stale.get("mode") or spec.mode.value),
                        hourly=Decimal("0"),
                        started=time.monotonic(),
                        state=PodState.ABSENT.value,
                    )
                finally:
                    holder["cleaning"] = False
                if not stale_ok:
                    code = 4
            if code == 0:
                hourly = get_gpu_price(spec.gpu_id, key)
                check_spend(spec, hourly)
                started = time.monotonic()
                pod = create_pod(spec, key)
                pod_id = pod.id
                code, rate, state = _poll(pod.id, key, spec, started + spec.max_runtime_seconds)
        except _Shutdown as err:
            code = 128 + err.signum
            if pod_id is None:
                recorded = _read_active()
                if recorded is not None:
                    pod_id = str(recorded["id"])
        except Exception:
            code = 4
            if pod_id is None:
                recorded = _read_active()
                if recorded is not None:
                    pod_id = str(recorded["id"])
        if code == 0 and rate is not None and spec.mode is JobMode.CALIBRATE:
            _print_projection(rate, hourly)
    finally:
        try:
            if pod_id is not None and not holder["cleaning"]:
                holder["cleaning"] = True
                if not _teardown(pod_id, key, mode=spec.mode.value, hourly=hourly, started=started, state=state):
                    code = 4
        except Exception:
            code = 4
            if pod_id is not None:
                _report_delete_failed(pod_id)
        finally:
            _restore_signals(previous)
    return code


def watch(spec: RunPodJobSpec) -> int:
    try:
        return _watch(spec)
    except SystemExit as err:
        if err.code is None:
            return 0
        return int(err.code)


def _require_live() -> str:
    if not live_enabled():
        raise SystemExit(2)
    return api_key()


def _reject_argv(argv: list[str]) -> bool:
    for token in argv:
        if token in _REJECT or token.startswith("--api-key=") or token.startswith("--apikey="):
            return True
        if "RUNPOD_API_KEY=" in token:
            return True
    return False


def _spec_from_args(rest: list[str]) -> RunPodJobSpec:
    mode = "calibrate"
    index = 0
    while index < len(rest):
        if rest[index] == "--mode" and index + 1 < len(rest):
            mode = rest[index + 1]
            index += 2
            continue
        raise SystemExit(2)
    if mode == "calibrate":
        return CALIBRATE
    if mode == "train":
        return TRAIN
    raise SystemExit(2)


def _help() -> str:
    return "\n".join(
        [
            "subcommands: plan, journal, status, stop, delete, watch",
            "create refuses with exit 2; watch creates and deletes the pod",
            PLAN_CALIBRATE,
            f"# {LIVE_CALIBRATE}",
        ]
    )


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if _reject_argv(argv):
        print("refusing secret on argv", file=sys.stderr)
        return 2
    if not argv or argv[0] in {"-h", "--help"}:
        print(_help())
        return 0
    cmd, rest = argv[0], argv[1:]
    try:
        if cmd == "plan":
            print(plan(_spec_from_args(rest)), end="")
            return 0
        if cmd == "journal":
            path = default_journal()
            if path.is_file():
                sys.stdout.write(path.read_text(encoding="utf-8"))
            return 0
        if cmd == "create":
            print("create refuses; use watch", file=sys.stderr)
            return 2
        if cmd == "watch":
            return watch(_spec_from_args(rest))
        if cmd in {"status", "stop", "delete"}:
            if len(rest) != 1:
                raise SystemExit(2)
            key = _require_live()
            pod_id = rest[0]
            if cmd == "status":
                print(get_pod(pod_id, key).state.value)
            elif cmd == "stop":
                act(pod_id, RemoteAction.STOP.value, key)
            elif not delete_pod(pod_id, key):
                _report_delete_failed(pod_id)
                return 4
            return 0
    except ValueError as err:
        print(err, file=sys.stderr)
        return 4
    except SystemExit as err:
        code = err.code
        return 0 if code is None else int(code)
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
