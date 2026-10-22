from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from fontsnap_ref.evaluate import CONFIGS, score
from fontsnap_ref.image import to_rgb
from fontsnap_ref.pipeline import Families, nz, predict_variants
from train.paths import OUT, REALSHOT_LABELS, assert_under_out

SHOT_COLUMNS: tuple[str, ...] = ("image", "label", "family_key", "source", "split")
SOURCES = frozenset({"fontsource", "collletttivo", "velvetyne", "google_fonts"})
SPLITS = frozenset({"real"})
MAX_DISPLACEMENT = 0.02


@dataclass(frozen=True, slots=True)
class ShotLabel:
    image: str
    label: str
    family_key: str
    source: str
    split: str


def _cell(raw: dict[str, str | None], name: str) -> str:
    value = raw.get(name)
    if value is None:
        return ""
    return value.strip()


def _image_name(name: str) -> str:
    if not name or name in {".", ".."} or name != Path(name).name or "/" in name or "\\" in name or "\x00" in name:
        raise ValueError(f"image must be a file name: {name!r}")
    return name


def _parse_row(raw: dict[str, str | None]) -> ShotLabel:
    image = _image_name(_cell(raw, "image"))
    label = _cell(raw, "label")
    if not label:
        raise ValueError("label is empty")
    family_key = _cell(raw, "family_key")
    if family_key and family_key != nz(label):
        raise ValueError(f"family_key {family_key!r} is not nz of {label!r}")
    source = _cell(raw, "source")
    if source and source not in SOURCES:
        raise ValueError(f"unknown source {source!r}")
    split = _cell(raw, "split")
    if split and split not in SPLITS:
        raise ValueError(f"unknown split {split!r}")
    return ShotLabel(image, label, family_key, source, split)


def load_shot_labels(path: Path) -> tuple[ShotLabel, ...]:
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        fields = reader.fieldnames or ()
        missing = [name for name in SHOT_COLUMNS if name not in fields]
        if missing:
            raise ValueError("missing columns: " + ",".join(missing))
        return tuple(_parse_row(row) for row in reader)


def score_shots(labels: tuple[ShotLabel, ...], preds: dict) -> dict:
    return score(preds, [(row.image, row.label) for row in labels])


def _shot_path(image_root: Path, name: str) -> Path:
    path = (image_root / name).resolve()
    if path.parent != image_root.resolve():
        raise ValueError(f"image escapes the directory: {name}")
    return path


def eval_shots(labels: tuple[ShotLabel, ...], image_dir: Path, model: object) -> dict:
    if not labels:
        raise ValueError("no shot labels")
    image_root = assert_under_out(image_dir)
    if not image_root.is_dir():
        raise ValueError(f"image directory does not exist: {image_root}")
    families = Families()
    needed: list[str] = []
    for variants, _alpha, _merge in CONFIGS.values():
        for variant in variants:
            if variant not in needed:
                needed.append(variant)
    preds = {}
    for shot in labels:
        rgb = to_rgb(Image.open(_shot_path(image_root, shot.image)))
        packed = predict_variants(model, rgb, variants=tuple(needed))
        preds[shot.image] = {
            name: families.rank_families([packed[variant] for variant in variants], alpha, merge)
            for name, (variants, alpha, merge) in CONFIGS.items()
        }
    return score_shots(labels, preds)


def displacement_report(before: dict, after: dict) -> dict[str, float | int | bool]:
    try:
        before_preds = before["preds"]
        after_preds = after["preds"]
    except (KeyError, TypeError) as exc:
        raise ValueError("evaluate JSON is missing preds") from exc
    shared = sorted(set(before_preds) & set(after_preds))
    changed = 0
    for image in shared:
        if _best_family(before_preds, image) != _best_family(after_preds, image):
            changed += 1
    fraction = (changed / len(shared)) if shared else 0.0
    return {
        "n": len(shared),
        "top1_changed": fraction,
        "max_displacement": MAX_DISPLACEMENT,
        "enforced": False,
    }


def _best_family(preds: dict, image: str) -> str:
    try:
        family = preds[image]["best"][0]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError(f"missing best family for {image}") from exc
    if not isinstance(family, str):
        raise ValueError(f"missing best family for {image}")
    return family


def format_displacement(report: dict) -> str:
    enforced = "true" if report["enforced"] else "false"
    return (
        f"n={report['n']} top1_changed={report['top1_changed']:.4f} max_displacement={report['max_displacement']:.2f} enforced={enforced}"
    )


def _load_eval_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} is not an evaluate document")
    return data


def _write_out(path: Path | None, payload: dict) -> None:
    if path is None:
        return
    dest = assert_under_out(path)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(payload), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="train shots")
    sub = parser.add_subparsers(dest="command", required=True)

    check = sub.add_parser("check")
    check.add_argument("--labels", type=Path, default=REALSHOT_LABELS)

    ev = sub.add_parser("eval")
    ev.add_argument("--labels", type=Path, default=REALSHOT_LABELS)
    ev.add_argument("--images", type=Path, default=OUT / "realshots" / "images")
    ev.add_argument("--model", type=Path, default=None)
    ev.add_argument("--out", type=Path, default=None)

    disp = sub.add_parser("displace")
    disp.add_argument("--before", type=Path, required=True)
    disp.add_argument("--after", type=Path, required=True)
    disp.add_argument("--out", type=Path, default=None)

    args = parser.parse_args(argv)
    try:
        if args.command == "check":
            rows = load_shot_labels(args.labels)
            print(f"rows={len(rows)}")
            return 0
        if args.command == "eval":
            labels = load_shot_labels(args.labels)
            if not labels:
                raise ValueError("no shot labels")
            if args.out is not None:
                assert_under_out(args.out)
            image_root = assert_under_out(args.images)
            if not image_root.is_dir():
                raise ValueError(f"image directory does not exist: {image_root}")
            from fontsnap_ref.pipeline import MODEL, Model

            metrics = eval_shots(labels, image_root, Model(args.model or MODEL))
            _write_out(args.out, metrics)
            print(json.dumps(metrics))
            return 0
        report = displacement_report(_load_eval_json(args.before), _load_eval_json(args.after))
        _write_out(args.out, report)
        print(format_displacement(report))
        return 0
    except (ValueError, FileNotFoundError, json.JSONDecodeError) as exc:
        print(exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
