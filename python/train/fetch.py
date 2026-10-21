from __future__ import annotations

import os
import sys
from dataclasses import replace
from pathlib import Path

from train.inventory import read_url
from train.paths import MANIFEST_TSV, OUT, assert_under_out
from train.registry import FontClassRecord, dump_manifest, is_sfnt, load_manifest, sha256_hex


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    cache = OUT / "font-cache"
    dry = False
    write_sha = False
    only: list[str] = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--dry-run":
            dry = True
        elif arg == "--write-sha256":
            write_sha = True
        elif arg == "--cache" and index + 1 < len(args):
            index += 1
            cache = Path(args[index])
        elif arg == "--class" and index + 1 < len(args):
            index += 1
            only.append(args[index])
        else:
            print("usage: python -m train fetch [--dry-run] [--write-sha256] [--cache DIR] [--class ID]", file=sys.stderr)
            return 2
        index += 1
    try:
        cache = assert_under_out(cache)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    records = load_manifest()
    if only:
        want = set(only)
        records = tuple(rec for rec in records if rec.class_id in want)
        if {rec.class_id for rec in records} != want:
            print("unknown class id", file=sys.stderr)
            return 2
    if dry:
        print(f"{len(records)} downloads -> {cache}")
        return 0
    digests: dict[str, str] = {}
    try:
        for rec in records:
            digests[rec.class_id] = _fetch_one(rec, _dest(cache, rec))
    except (OSError, RuntimeError, ValueError) as exc:
        print(exc, file=sys.stderr)
        return 1
    if write_sha:
        _stamp(digests)
    print(f"fetched {len(digests)}")
    return 0


def _dest(cache: Path, rec: FontClassRecord) -> Path:
    return assert_under_out(cache / rec.source.value / rec.family_id / rec.download.filename)


def _fetch_one(rec: FontClassRecord, dest: Path) -> str:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_file():
        digest = sha256_hex(dest.read_bytes())
        if is_sfnt(dest.read_bytes()[:4]) and (not rec.file_sha256 or digest == rec.file_sha256):
            _sidecar(dest, digest)
            return digest
        dest.unlink()
    partial = dest.with_name(dest.name + ".partial")
    assert_under_out(partial)
    data = read_url(rec.download.url)
    if not is_sfnt(data):
        raise RuntimeError(f"{rec.class_id} is not a static sfnt")
    digest = sha256_hex(data)
    if rec.file_sha256 and digest != rec.file_sha256:
        raise RuntimeError(f"{rec.class_id} sha256 {digest} != manifest")
    partial.write_bytes(data)
    os.replace(partial, dest)
    _sidecar(dest, digest)
    return digest


def _sidecar(dest: Path, digest: str) -> None:
    dest.with_suffix(".sha256").write_text(digest + "\n", encoding="utf-8")


def _stamp(digests: dict[str, str]) -> None:
    stamped = []
    for rec in load_manifest():
        digest = digests.get(rec.class_id)
        stamped.append(rec if digest is None else replace(rec, file_sha256=digest))
    text = dump_manifest(stamped)
    tmp = MANIFEST_TSV.with_name(MANIFEST_TSV.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, MANIFEST_TSV)
