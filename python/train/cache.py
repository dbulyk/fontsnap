from __future__ import annotations

import argparse
import hashlib
import os
import sys
from pathlib import Path

from train.paths import OUT, assert_under_out

_HEX = frozenset("0123456789abcdef")


def cache_root() -> Path:
    override = os.environ.get("FONTSNAP_FONT_CACHE")
    if override:
        return assert_under_out(Path(override))
    return assert_under_out(OUT / "font-cache")


def _digest(value: str) -> str:
    digest = value.strip().lower()
    if len(digest) != 64 or any(char not in _HEX for char in digest):
        raise ValueError("sha256 must be 64 hex characters")
    return digest


class HashMismatch(ValueError):
    pass


def cache_path(sha256: str, root: Path | None = None) -> Path:
    digest = _digest(sha256)
    base = cache_root() if root is None else assert_under_out(root)
    return base / digest[:2] / digest


def store_bytes(sha256: str, data: bytes, root: Path | None = None) -> Path:
    digest = _digest(sha256)
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("hash mismatch")
    dest = cache_path(digest, root)
    partial = dest.with_name(dest.name + ".partial")
    if dest.is_file() and hashlib.sha256(dest.read_bytes()).hexdigest() == digest:
        if partial.exists():
            partial.unlink()
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    partial.write_bytes(data)
    partial.replace(dest)
    return dest


def read_verified(sha256: str, root: Path | None = None) -> bytes:
    dest = cache_path(sha256, root)
    data = dest.read_bytes()
    if hashlib.sha256(data).hexdigest() != _digest(sha256):
        raise HashMismatch(dest)
    return data


def catalog_digests() -> tuple[str, ...]:
    from train.registry import load_manifest

    digests: list[str] = []
    for record in load_manifest():
        if not record.file_sha256:
            continue
        digests.append(_digest(record.file_sha256))
    return tuple(digests)


def verify(digests: tuple[str, ...], root: Path | None = None) -> dict[str, int]:
    missing = 0
    mismatched = 0
    for digest in digests:
        try:
            read_verified(digest, root=root)
        except FileNotFoundError:
            missing += 1
        except HashMismatch:
            mismatched += 1
    return {"catalog": len(digests), "missing": missing, "mismatched": mismatched}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="train cache")
    parser.add_argument("--verify", action="store_true", help="hash cached fonts and report gaps, do not download")
    parser.parse_args(argv)
    try:
        report = verify(catalog_digests())
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    print(f"catalog={report['catalog']} missing={report['missing']} mismatched={report['mismatched']}")
    if report["mismatched"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
