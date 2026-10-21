"""Path guards: train artifacts stay under out/; product model/ is read-only."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "out"
DATA = ROOT / "data"
MODEL_DIR = ROOT / "model"
MANIFEST_TSV = DATA / "fonts_manifest_v3.tsv"
LICENSE_ROOT = DATA / "licenses" / "v3"
EXCLUDE_TSV = DATA / "fonts_exclude_v3.tsv"
REALSHOT_LABELS = DATA / "realshots" / "labels.csv"


def assert_under_out(path: Path) -> Path:
    """Resolve path and require it lives under out/. Rejects symlink escapes."""
    out = OUT.resolve()
    resolved = path.expanduser().resolve()
    if resolved != out and out not in resolved.parents:
        raise ValueError(f"path must be under out/: {path}")
    return resolved


def refuse_product_write(path: Path) -> None:
    """Raise if path targets shipped model/ bytes."""
    model = MODEL_DIR.resolve()
    resolved = path.expanduser().resolve()
    if resolved == model or model in resolved.parents or resolved.parent == model:
        raise ValueError(f"refusing write to product model/: {path}")
