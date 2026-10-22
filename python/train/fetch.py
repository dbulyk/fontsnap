from __future__ import annotations

import os
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

from train.cache import HashMismatch, read_verified, store_bytes
from train.inventory import read_font_bytes
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
    digests, failures = _fetch_all(records, cache)
    if write_sha and digests:
        _stamp(digests)
    print(f"fetched {len(digests)} failed {len(failures)}")
    for line in failures:
        print(line, file=sys.stderr)
    return 1 if failures else 0


def _fetch_all(records: tuple[FontClassRecord, ...], cache: Path) -> tuple[dict[str, str], list[str]]:
    digests: dict[str, str] = {}
    failures: list[str] = []

    def one(rec: FontClassRecord) -> tuple[str, str]:
        return rec.class_id, _fetch_one(rec, cache)

    workers = min(8, max(1, len(records)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(one, rec) for rec in records]
        for rec, future in zip(records, futures, strict=True):
            try:
                class_id, digest = future.result()
            except (OSError, RuntimeError, ValueError, HashMismatch) as exc:
                failures.append(f"{rec.class_id}: {exc}")
                continue
            digests[class_id] = digest
    return digests, failures


def _fetch_one(rec: FontClassRecord, root: Path) -> str:
    if rec.file_sha256:
        try:
            read_verified(rec.file_sha256, root)
            return rec.file_sha256
        except (FileNotFoundError, HashMismatch):
            pass
    data = read_font_bytes(rec.download.url)
    if not is_sfnt(data):
        raise RuntimeError(f"{rec.class_id} is not a static sfnt")
    digest = sha256_hex(data)
    if rec.file_sha256 and digest != rec.file_sha256:
        raise RuntimeError(f"{rec.class_id} sha256 {digest} != manifest")
    store_bytes(digest, data, root)
    return digest


def _stamp(digests: dict[str, str]) -> None:
    stamped = []
    for rec in load_manifest():
        digest = digests.get(rec.class_id)
        stamped.append(rec if digest is None else replace(rec, file_sha256=digest))
    text = dump_manifest(stamped)
    tmp = MANIFEST_TSV.with_name(MANIFEST_TSV.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, MANIFEST_TSV)
