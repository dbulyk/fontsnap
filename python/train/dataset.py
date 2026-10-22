from __future__ import annotations

from typing import Any

import numpy as np

from fontsnap_ref.pipeline import prep
from train.cache import read_verified
from train.render import render_sample
from train.samples import SHIPPED_CLASS_COUNT, SyntheticSampleSpec, build_specs, known_spec, spec_fits


def prepared_chw(
    spec: SyntheticSampleSpec,
    font_bytes: bytes | None = None,
    *,
    instance: tuple[tuple[str, float], ...] = (),
) -> np.ndarray:
    canvas = render_sample(spec, font_bytes, instance=instance)
    batch = prep(canvas)
    chw = np.ascontiguousarray(batch[0], dtype=np.float32)
    if chw.shape != (3, 320, 320):
        raise RuntimeError(f"prep shape {chw.shape}")
    return chw


class FontSnapSynth:
    def __init__(
        self,
        specs: tuple[SyntheticSampleSpec, ...],
        records: tuple[Any, ...] | None = None,
        *,
        label_offset: int = SHIPPED_CLASS_COUNT,
    ) -> None:
        self.specs = tuple(specs)
        self.records = records
        self.label_offset = label_offset
        for spec in self.specs:
            if records is None:
                if not known_spec(spec):
                    raise ValueError(f"unknown text or background for class {spec.class_index}")
                continue
            if not 0 <= spec.class_index < len(records):
                raise ValueError(f"class_index {spec.class_index} is outside the record list")
            if not spec_fits(records[spec.class_index], spec):
                raise ValueError(f"spec does not fit class {spec.class_index}")

    def __len__(self) -> int:
        return len(self.specs)

    def __getitem__(self, index: int):
        spec = self.specs[index]
        font_bytes, instance = _font_of(self.records[spec.class_index]) if self.records is not None else (None, ())
        arr = prepared_chw(spec, font_bytes, instance=instance)
        import torch

        return torch.from_numpy(arr), self.label_offset + spec.class_index


def _digest_of(record: object) -> str | None:
    direct = getattr(record, "file_sha256", None)
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    recipe = getattr(record, "recipe", None)
    legacy = getattr(recipe, "sha256", None) if recipe is not None else None
    if isinstance(legacy, str) and legacy.strip():
        return legacy.strip()
    return None


def _has_font_recipe(record: object) -> bool:
    if getattr(record, "download", None) is not None:
        return True
    return getattr(record, "recipe", None) is not None


def _font_of(record: object) -> tuple[bytes | None, tuple[tuple[str, float], ...]]:
    instance = tuple(getattr(record, "instance", ()) or ())
    digest = _digest_of(record)
    name = getattr(record, "class_id", None) or "font"
    if digest:
        try:
            return read_verified(digest), instance
        except FileNotFoundError as exc:
            raise FileNotFoundError(f"font bytes missing for {name}") from exc
    if _has_font_recipe(record):
        raise FileNotFoundError(f"font bytes missing for {name}")
    return None, instance


def make_loader(
    *,
    n_classes: int,
    split: str,
    per_class: int,
    batch_size: int,
    records: tuple[Any, ...] | None = None,
    num_workers: int = 0,
    label_offset: int = SHIPPED_CLASS_COUNT,
    shuffle: bool = False,
):
    from torch.utils.data import DataLoader

    specs = build_specs(n_classes=n_classes, split=split, per_class=per_class, records=records)
    dataset = FontSnapSynth(specs, records, label_offset=label_offset)
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        num_workers=num_workers,
        persistent_workers=num_workers > 0,
    )


def make_ofl_loader(
    *,
    batch_size: int,
    per_class_new: int,
    per_class_replay: int,
    num_workers: int,
    shuffle: bool,
    fetch_fonts: bool = True,
):
    """OFL phase-1 samples (labels BASE..). Replay of old classes is disabled.

    Fake default-font images under old labels are label noise; old classes are
    preserved by freezing the backbone and restoring old head rows. per_class_replay
    must be 0 until real Google Fonts face files are wired for replay.
    """
    from torch.utils.data import DataLoader

    from train.cache import cache_root
    from train.fetch import _fetch_one
    from train.registry import load_manifest

    if per_class_replay != 0:
        raise ValueError(
            "ofl-v1 refuses synthetic replay without real font bytes; set per_class_replay=0 (backbone frozen, old head rows restored)"
        )
    records = load_manifest()
    if fetch_fonts:
        root = cache_root()
        seen: set[str] = set()
        for rec in records:
            if not rec.file_sha256 or rec.file_sha256 in seen:
                continue
            seen.add(rec.file_sha256)
            _fetch_one(rec, root)
    new_specs = build_specs(n_classes=len(records), split="train", per_class=per_class_new, records=records)
    dataset = FontSnapSynth(new_specs, records=records, label_offset=SHIPPED_CLASS_COUNT)
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        num_workers=num_workers,
        persistent_workers=num_workers > 0,
    )
