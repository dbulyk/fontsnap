"""RunPod launcher. Plan does not read RUNPOD_API_KEY and does not open a socket.

Free-phase command, the one this phase runs:

    python -m train.runpod plan --mode calibrate

Live calibrate is not run in this phase. It needs RUNPOD_API_KEY in the environment and
FONTSNAP_RUNPOD_LIVE=1. The pod is a Secure RTX 4090 (quoted $0.89/h). Calibrate refuses a
price that would pass $1 in 20 minutes. watch stops the pod and deletes it when the poll
ends or the timer fires.

    FONTSNAP_RUNPOD_LIVE=1 python -m train.runpod watch --mode calibrate
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from enum import Enum
from pathlib import Path
from typing import Literal
from urllib.parse import quote

from train.paths import assert_under_out

API = "https://api.runpod.io/v2"
PLAN_CALIBRATE = "python -m train.runpod plan --mode calibrate"
LIVE_CALIBRATE = "FONTSNAP_RUNPOD_LIVE=1 python -m train.runpod watch --mode calibrate"
_REJECT = ("--api-key", "--apikey")


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


def create_body(spec: RunPodJobSpec) -> dict:
    if spec.env:
        raise ValueError("pod env must be empty")
    return {
        "name": spec.name,
        "image": spec.image,
        "cloud": spec.cloud,
        "gpu": {"id": spec.gpu_id, "count": spec.gpu_count},
        "disk": spec.disk_gb,
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


def _http_json(method: str, path: str, key: str, body: dict | None = None) -> tuple[int, dict]:
    import urllib.error
    import urllib.request

    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(API + path, data=data, method=method)
    request.add_header("Authorization", "Bearer " + key)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as err:
        raw = err.read()
        status = err.code
    if not raw:
        return status, {}
    payload = json.loads(raw.decode())
    if not isinstance(payload, dict):
        raise SystemExit(4)
    return status, payload


def get_gpu_price(gpu_id: str, key: str) -> Decimal:
    status, payload = _http_json("GET", "/gpus/" + quote(gpu_id, safe=""), key)
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
    return parse_pod(payload, status_code=status)


def get_pod(pod_id: str, key: str) -> RemotePod:
    status, payload = _http_json("GET", "/pods/" + quote(pod_id, safe=""), key)
    return parse_pod(payload, status_code=status)


def act(pod_id: str, action: str, key: str) -> None:
    if action not in {item.value for item in RemoteAction}:
        raise ValueError(action)
    status, _payload = _http_json("POST", "/pods/" + quote(pod_id, safe="") + "/action", key, {"action": action})
    if status not in (200, 201, 204):
        raise SystemExit(4)


def delete_pod(pod_id: str, key: str) -> None:
    status, _payload = _http_json("DELETE", "/pods/" + quote(pod_id, safe=""), key)
    if status not in (200, 204, 404):
        raise SystemExit(4)


def _wind_down(pod: RemotePod, key: str, started: float, spec: RunPodJobSpec) -> None:
    actions = {item.lower() for item in pod.actions}
    exit_code: int | None = None
    delete = True
    stop = False
    if pod.cloud.upper() == "COMMUNITY":
        exit_code = 4
    elif pod.state == PodState.UNKNOWN:
        delete = "terminate" in actions
        exit_code = 4
    elif pod.state in {PodState.PROVISIONING, PodState.STARTING, PodState.RUNNING} and "stop" in actions:
        stop = True
    try:
        if stop and pod.id:
            act(pod.id, RemoteAction.STOP.value, key)
    finally:
        try:
            if delete and pod.id:
                delete_pod(pod.id, key)
        finally:
            elapsed_min = Decimal(str((time.monotonic() - started) / 60))
            estimated = pod.hourly_usd * elapsed_min / Decimal(60)
            append_cost(
                default_journal(),
                CostLine(
                    ts=_now(),
                    mode=spec.mode.value,
                    pod_id=pod.id,
                    state=pod.state.value,
                    hourly_usd=format(pod.hourly_usd, "f"),
                    minutes=format(elapsed_min, "f"),
                    estimated_usd=format(estimated, "f"),
                    note="wind-down",
                ),
                scrub_key=True,
            )
            if exit_code is not None:
                raise SystemExit(exit_code)


def watch(spec: RunPodJobSpec) -> None:
    if not live_enabled():
        raise SystemExit(2)
    key = api_key()
    check_spend(spec, get_gpu_price(spec.gpu_id, key))
    started = time.monotonic()
    deadline = started + spec.max_runtime_seconds
    pod = create_pod(spec, key)
    try:
        while time.monotonic() < deadline and pod.id:
            pod = get_pod(pod.id, key)
            if pod.cloud.upper() == "COMMUNITY" or pod.state == PodState.UNKNOWN:
                break
            if pod.state in {PodState.RUNNING, PodState.EXITED, PodState.ERROR, PodState.TERMINATED, PodState.ABSENT}:
                break
            time.sleep(5)
    finally:
        if pod.id:
            _wind_down(pod, key, started, spec)


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
            "subcommands: plan, journal, create, status, stop, delete, watch",
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
        if cmd == "watch":
            watch(_spec_from_args(rest))
            return 0
        if cmd == "create":
            spec = _spec_from_args(rest)
            key = _require_live()
            check_spend(spec, get_gpu_price(spec.gpu_id, key))
            pod = create_pod(spec, key)
            print(pod.id)
            return 0
        if cmd in {"status", "stop", "delete"}:
            if len(rest) != 1:
                raise SystemExit(2)
            key = _require_live()
            pod_id = rest[0]
            if cmd == "status":
                print(get_pod(pod_id, key).state.value)
            elif cmd == "stop":
                act(pod_id, RemoteAction.STOP.value, key)
            else:
                delete_pod(pod_id, key)
            return 0
    except SystemExit as err:
        code = err.code
        return 0 if code is None else int(code)
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
