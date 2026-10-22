"""runpodctl v1.14.x relay code: only the full `<base>-<relay index>` line on send stdout counts."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

from train.runpod import _publish_artifacts_shell, parse_artifact_receive

# The fake send learns the base from --code and runs the given shell body with $code set.
_SEND = (
    "#!/bin/sh\n"
    'if [ "$1" = send ]; then\n'
    "  code=\n"
    "  prev=\n"
    "  for arg; do\n"
    '    if [ "$prev" = "--code" ]; then code="$arg"; fi\n'
    '    prev="$arg"\n'
    "  done\n"
    "{body}"
    "fi\n"
    "exit 0\n"
)


def _publish(tmp_path: Path, send_body: str) -> subprocess.CompletedProcess[str]:
    work = tmp_path / "pod-work"
    art = work / "out" / "train"
    art.mkdir(parents=True)
    (art / "ckpt-final.pt").write_bytes(b"ckpt-bytes")
    bind = tmp_path / "bin"
    bind.mkdir()
    (bind / "runpodctl").write_text(_SEND.format(body=send_body), encoding="utf-8")
    (bind / "timeout").write_text('#!/bin/sh\nshift\nexec "$@"\n', encoding="utf-8")
    for path in bind.iterdir():
        path.chmod(0o755)
    env = os.environ.copy()
    env["PATH"] = f"{bind}:/usr/bin:/bin"
    env["FONTSNAP_POD_WORK"] = str(work)
    script = 'set -u\nWORK="$FONTSNAP_POD_WORK"\nstatus=0\n' + _publish_artifacts_shell() + "echo STATUS:$status\n"
    return subprocess.run(["bash", "-c", script], env=env, capture_output=True, text=True, timeout=60)


def test_publish_takes_the_code_line_from_stdout_and_ignores_banners(tmp_path):
    proc = _publish(
        tmp_path,
        # stderr: the human banner, with a different relay index.
        '  printf "Sending fontsnap-ofl-v1.tgz\\nCode is: %s-7\\nrunpodctl receive %s-7\\n" "$code" "$code" >&2\n'
        # stdout: config banner, decoys that only contain the code, then the real line.
        '  printf "Runpod config file not found\\n"\n'
        '  printf "Code is: %s-8\\n" "$code"\n'
        '  printf "%s-9 relay\\n" "$code"\n'
        '  printf "%s-3\\n" "$code"\n',
    )
    assert "STATUS:0" in proc.stdout, proc.stderr
    code = parse_artifact_receive(proc.stdout)
    assert code is not None and code.endswith("-3")
    assert [line for line in proc.stdout.splitlines() if line.startswith("fontsnap_artifact_receive")] == [
        f"fontsnap_artifact_receive {code}"
    ]


def test_publish_without_a_code_line_fails_and_prints_no_receive_marker(tmp_path):
    proc = _publish(
        tmp_path,
        '  printf "Runpod config file not found\\n"\n  printf "Code is: %s\\n" "$code" >&2\n  printf "%s\\n" "$code"\n',
    )
    assert "STATUS:4" in proc.stdout
    assert "fontsnap_artifact_receive" not in proc.stdout
    assert parse_artifact_receive(proc.stdout) is None
    assert "send produced no receive code" in proc.stderr
    # The send's own stderr is surfaced for the operator.
    assert "Code is:" in proc.stderr


def test_client_reads_the_marker_not_runpodctl_banners_in_pod_logs():
    log = (
        "Sending 'fontsnap-ofl-v1.tgz' (1.2 MB)\n"
        "Code is: 1111-2222-3333-4444-5\n"
        "On the other computer run\n"
        "runpodctl receive 1111-2222-3333-4444-5\n"
        "fontsnap_artifact_receive abcd-ef01-2345-6789-2\n"
    )
    assert parse_artifact_receive(log) == "abcd-ef01-2345-6789-2"
    assert parse_artifact_receive(log.replace("fontsnap_artifact_receive abcd-ef01-2345-6789-2\n", "")) is None
