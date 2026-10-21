"""Synthetic sample identity. One spec is a class index, text id, background id, seed, and split.

Train, synth hold-out, and replay use disjoint seed ranges and disjoint text and background banks.
The same call returns the same specs, so a hold-out can be re-rendered without a PNG archive.
"""

from __future__ import annotations

import argparse
import enum
import json
import sys
from dataclasses import dataclass
from typing import NamedTuple

SHIPPED_CLASS_COUNT = 3665
SPLIT_SPAN = 1_000_000_000


class Split(str, enum.Enum):
    TRAIN = "train"
    SYNTH_HOLDOUT = "synth_holdout"
    REPLAY = "replay"


SEED_BASE: dict[Split, int] = {
    Split.TRAIN: 0,
    Split.SYNTH_HOLDOUT: SPLIT_SPAN,
    Split.REPLAY: 2 * SPLIT_SPAN,
}


@dataclass(frozen=True, slots=True)
class TextEntry:
    text_id: int
    split: Split
    script: str
    text: str


@dataclass(frozen=True, slots=True)
class Background:
    bg_id: int
    split: Split
    rgb: tuple[int, int, int]


TEXTS: tuple[TextEntry, ...] = (
    TextEntry(0, Split.TRAIN, "latin", "The quick brown fox jumps over the lazy dog."),
    TextEntry(1, Split.TRAIN, "latin", "Pack my box with five dozen liquor jugs."),
    TextEntry(2, Split.TRAIN, "cyrillic", "Съешь же ещё этих мягких французских булок."),
    TextEntry(100, Split.SYNTH_HOLDOUT, "latin", "A hold-out line the training seeds never render."),
    TextEntry(101, Split.SYNTH_HOLDOUT, "latin", "Second hold-out line, disjoint from the train ids."),
    TextEntry(102, Split.SYNTH_HOLDOUT, "cyrillic", "Это строка только для отложенной выборки."),
    TextEntry(200, Split.REPLAY, "latin", "Replay line one, unused by train or hold-out."),
    TextEntry(201, Split.REPLAY, "latin", "Replay line two, still disjoint."),
    TextEntry(202, Split.REPLAY, "cyrillic", "Строка повтора, не из обучения."),
)

BACKGROUNDS: tuple[Background, ...] = (
    Background(0, Split.TRAIN, (255, 255, 255)),
    Background(1, Split.TRAIN, (245, 245, 240)),
    Background(10, Split.SYNTH_HOLDOUT, (32, 32, 32)),
    Background(11, Split.SYNTH_HOLDOUT, (24, 24, 28)),
    Background(20, Split.REPLAY, (250, 248, 245)),
    Background(21, Split.REPLAY, (230, 230, 230)),
)


def _banks() -> tuple[dict[int, TextEntry], dict[int, Background]]:
    texts: dict[int, TextEntry] = {}
    seen_text: dict[str, int] = {}
    for entry in TEXTS:
        if entry.text_id in texts:
            raise RuntimeError(f"duplicate text_id {entry.text_id}")
        if entry.text in seen_text:
            raise RuntimeError(f"duplicate text {entry.text!r}")
        texts[entry.text_id] = entry
        seen_text[entry.text] = entry.text_id
    backgrounds: dict[int, Background] = {}
    for bg in BACKGROUNDS:
        if bg.bg_id in backgrounds:
            raise RuntimeError(f"duplicate bg_id {bg.bg_id}")
        backgrounds[bg.bg_id] = bg
    return texts, backgrounds


TEXT_BY_ID, BG_BY_ID = _banks()


class SampleKey(NamedTuple):
    class_index: int
    text_id: int
    bg_id: int
    seed: int
    split: str


@dataclass(frozen=True, slots=True)
class SyntheticSampleSpec:
    class_index: int
    text_id: int
    bg_id: int
    seed: int
    split: Split

    def as_key(self) -> SampleKey:
        return SampleKey(self.class_index, self.text_id, self.bg_id, self.seed, self.split.value)


def head_index(spec: SyntheticSampleSpec) -> int:
    if spec.class_index < 0:
        raise ValueError(spec.class_index)
    return SHIPPED_CLASS_COUNT + spec.class_index


def _latin_text_ids(split: Split) -> tuple[int, ...]:
    return tuple(entry.text_id for entry in TEXTS if entry.split == split and entry.script == "latin")


def _background_ids(split: Split) -> tuple[int, ...]:
    return tuple(bg.bg_id for bg in BACKGROUNDS if bg.split == split)


def known_spec(spec: SyntheticSampleSpec) -> bool:
    entry = TEXT_BY_ID.get(spec.text_id)
    bg = BG_BY_ID.get(spec.bg_id)
    if entry is None or bg is None:
        return False
    return entry.split == spec.split and bg.split == spec.split


def _subsets(record: object) -> tuple[str, ...] | None:
    subsets = getattr(record, "subsets", None)
    if isinstance(subsets, (str, bytes)) or not isinstance(subsets, (tuple, list, set, frozenset)):
        return None
    return tuple(subsets)


def spec_fits(record: object, spec: SyntheticSampleSpec) -> bool:
    """True when the spec's script is one of record.subsets and the text and background belong to spec.split."""
    if not known_spec(spec):
        return False
    subsets = _subsets(record)
    if subsets is None:
        return False
    return TEXT_BY_ID[spec.text_id].script in subsets


def _coerce_split(split: Split | str) -> Split:
    if isinstance(split, Split):
        return split
    return Split(split)


def build_specs(*, n_classes: int, split: Split | str, per_class: int) -> tuple[SyntheticSampleSpec, ...]:
    """Latin lines only. Seed is SEED_BASE[split] + class_index * per_class + k, and it must stay inside the split span."""
    split = _coerce_split(split)
    if n_classes < 0 or per_class < 1:
        raise ValueError("n_classes must be >= 0 and per_class must be >= 1")
    if n_classes and (n_classes - 1) * per_class + (per_class - 1) >= SPLIT_SPAN:
        raise ValueError("seed offset crosses the split span")
    text_ids = _latin_text_ids(split)
    bg_ids = _background_ids(split)
    if not text_ids or not bg_ids:
        raise ValueError(f"split {split.value} has no latin text or no background")
    specs: list[SyntheticSampleSpec] = []
    for class_index in range(n_classes):
        for k in range(per_class):
            specs.append(
                SyntheticSampleSpec(
                    class_index=class_index,
                    text_id=text_ids[k % len(text_ids)],
                    bg_id=bg_ids[k % len(bg_ids)],
                    seed=SEED_BASE[split] + class_index * per_class + k,
                    split=split,
                )
            )
    return tuple(specs)


def assert_disjoint(groups: dict[Split, tuple[SyntheticSampleSpec, ...]]) -> None:
    """Raise when two splits share a seed, a text id, a text string, or a background id."""
    seen_seed: dict[int, Split] = {}
    seen_text: dict[int, Split] = {}
    seen_string: dict[str, Split] = {}
    seen_bg: dict[int, Split] = {}
    for split, specs in groups.items():
        split = _coerce_split(split)
        for spec in specs:
            if spec.split != split:
                raise ValueError("spec split does not match its group")
            try:
                entry = TEXT_BY_ID[spec.text_id]
                bg = BG_BY_ID[spec.bg_id]
            except KeyError as exc:
                raise ValueError("unknown text_id or bg_id") from exc
            if entry.split != split:
                raise ValueError(f"text_id {spec.text_id} belongs to {entry.split.value}")
            if bg.split != split:
                raise ValueError(f"bg_id {spec.bg_id} belongs to {bg.split.value}")
            _claim(seen_seed, spec.seed, split, "seed")
            _claim(seen_text, spec.text_id, split, "text_id")
            _claim(seen_string, entry.text, split, "text")
            _claim(seen_bg, spec.bg_id, split, "bg_id")


def _claim(seen: dict, value: object, split: Split, kind: str) -> None:
    prev = seen.get(value)
    if prev is not None and prev != split:
        raise ValueError(f"shared {kind} {value!r} between {prev.value} and {split.value}")
    seen[value] = split


def _as_int(value: object, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an int")
    return value


def spec_from_key(key: SampleKey) -> SyntheticSampleSpec:
    if key.class_index < 0 or key.seed < 0:
        raise ValueError("sample key is negative")
    try:
        split = Split(key.split)
    except ValueError as exc:
        raise ValueError(f"unknown split {key.split!r}") from exc
    spec = SyntheticSampleSpec(key.class_index, key.text_id, key.bg_id, key.seed, split)
    if not known_spec(spec):
        raise ValueError("sample key does not match a text and background in its split")
    return spec


def _key_from_row(row: dict) -> SampleKey:
    missing = [name for name in SampleKey._fields if name not in row]
    if missing:
        raise ValueError("missing sample fields: " + ",".join(missing))
    split = row["split"]
    if not isinstance(split, str):
        raise ValueError("split must be a string")
    return SampleKey(
        _as_int(row["class_index"], "class_index"),
        _as_int(row["text_id"], "text_id"),
        _as_int(row["bg_id"], "bg_id"),
        _as_int(row["seed"], "seed"),
        split,
    )


def specs_to_jsonl(specs: tuple[SyntheticSampleSpec, ...]) -> str:
    lines = [
        json.dumps(
            {
                "class_index": spec.class_index,
                "text_id": spec.text_id,
                "bg_id": spec.bg_id,
                "seed": spec.seed,
                "split": spec.split.value,
            },
            separators=(",", ":"),
        )
        for spec in specs
    ]
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


def specs_from_jsonl(text: str) -> tuple[SyntheticSampleSpec, ...]:
    specs: list[SyntheticSampleSpec] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"line {line_no} is not a sample key") from exc
        if not isinstance(row, dict):
            raise ValueError(f"line {line_no} is not a sample key")
        specs.append(spec_from_key(_key_from_row(row)))
    return tuple(specs)


def _registry_class_count() -> int:
    try:
        from train.registry import REGISTRY
    except ImportError:
        return 0
    return len(REGISTRY)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="train samples")
    parser.add_argument("--split", default=Split.TRAIN.value)
    parser.add_argument("--per-class", type=int, default=2)
    parser.add_argument("--classes", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true", help="print spec counts only, this command never renders")
    args = parser.parse_args(argv)
    try:
        split = Split(args.split)
        n_classes = _registry_class_count() if args.classes is None else args.classes
        groups = {item: build_specs(n_classes=n_classes, split=item, per_class=args.per_class) for item in Split}
        assert_disjoint(groups)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    specs = groups[split]
    dry = int(args.dry_run)
    print(f"split={split.value} classes={n_classes} per_class={args.per_class} specs={len(specs)} disjoint=ok dry_run={dry}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
