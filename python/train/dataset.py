from __future__ import annotations

from typing import Any

import numpy as np

from fontsnap_ref.pipeline import prep
from train.cache import read_verified
from train.render import render_sample
from train.samples import SyntheticSampleSpec, build_specs, head_index, known_spec, spec_fits


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
    def __init__(self, specs: tuple[SyntheticSampleSpec, ...], records: tuple[Any, ...] | None = None) -> None:
        self.specs = tuple(specs)
        self.records = records
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

        return torch.from_numpy(arr), head_index(spec)


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
):
    from torch.utils.data import DataLoader

    specs = build_specs(n_classes=n_classes, split=split, per_class=per_class)
    dataset = FontSnapSynth(specs, records)
    return DataLoader(dataset, batch_size=batch_size, shuffle=False, num_workers=num_workers)
