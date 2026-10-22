from __future__ import annotations

from typing import Any

import numpy as np

from fontsnap_ref.pipeline import prep
from train.cache import read_verified
from train.model import BASE_CLASSES
from train.render import render_sample
from train.samples import (
    BG_BY_ID,
    SEED_BASE,
    SHIPPED_CLASS_COUNT,
    TEXT_BY_ID,
    Split,
    SyntheticSampleSpec,
    build_specs,
    known_spec,
    spec_fits,
)


def prepared_chw(
    spec: SyntheticSampleSpec,
    font_bytes: bytes | None = None,
    *,
    instance: tuple[tuple[str, float], ...] = (),
    textcrop: str | None = None,
) -> np.ndarray:
    """Render → optional evaluate-style textcrop → prep.

    New-class / replay / synth hold-out stay on raw synth-prep (CPU full-head
    measure: pack/crop on the CE pool dropped realset3 to ~47%). Softplus
    negatives from the public web bank use pack+crop in train.web_bank.
    """
    canvas = render_sample(spec, font_bytes, instance=instance)
    if textcrop is not None:
        from fontsnap_ref.textcrop import crop_normalize

        if textcrop not in ("pack", "crop"):
            raise ValueError(f"textcrop must be 'pack' or 'crop', got {textcrop!r}")
        canvas = crop_normalize(canvas, textcrop)
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


class OldClassReplaySynth:
    """Renders from real GF family bytes; label is the shipped class index."""

    def __init__(self, specs: tuple[SyntheticSampleSpec, ...], fonts: dict[int, bytes]) -> None:
        self.specs = tuple(specs)
        self.fonts = fonts
        for spec in self.specs:
            if spec.class_index not in fonts:
                raise ValueError(f"missing gf font for class {spec.class_index}")
            if not known_spec(spec):
                raise ValueError(f"unknown replay text/bg for class {spec.class_index}")

    def __len__(self) -> int:
        return len(self.specs)

    def __getitem__(self, index: int):
        import torch

        # Some GF cuts trip Pillow ("execution context too long"); skip to next.
        last_err: Exception | None = None
        for offset in range(len(self.specs)):
            spec = self.specs[(index + offset) % len(self.specs)]
            try:
                # Raw synth-prep: same CE view as new classes (see prepared_chw).
                arr = prepared_chw(spec, self.fonts[spec.class_index])
            except (OSError, RuntimeError, ValueError) as err:
                last_err = err
                continue
            return torch.from_numpy(arr), int(spec.class_index)
        raise RuntimeError(f"all replay renders failed: {last_err}")


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


def _replay_specs(class_indices: list[int], per_class: int) -> tuple[SyntheticSampleSpec, ...]:
    """Latin-only REPLAY split specs keyed by the real shipped class index."""
    if per_class < 1:
        raise ValueError("per_class must be >= 1")
    text_ids = tuple(entry.text_id for entry in TEXT_BY_ID.values() if entry.split is Split.REPLAY and entry.script == "latin")
    bg_ids = tuple(bg.bg_id for bg in BG_BY_ID.values() if bg.split is Split.REPLAY)
    if not text_ids or not bg_ids:
        raise RuntimeError("replay split has no latin text or background")
    specs: list[SyntheticSampleSpec] = []
    for class_index in class_indices:
        for k in range(per_class):
            specs.append(
                SyntheticSampleSpec(
                    class_index=class_index,
                    text_id=text_ids[k % len(text_ids)],
                    bg_id=bg_ids[(k // len(text_ids)) % len(bg_ids)],
                    seed=SEED_BASE[Split.REPLAY] + class_index * per_class + k,
                    split=Split.REPLAY,
                )
            )
    return tuple(specs)


def make_ofl_loader(
    *,
    batch_size: int,
    per_class_new: int,
    per_class_replay: int,
    num_workers: int,
    shuffle: bool,
    fetch_fonts: bool = True,
    replay_repeat: int = 1,
):
    """New OFL faces (labels BASE..) plus GF replay of old classes (labels 0..BASE-1).

    Fake PIL-default replay is refused. Old-class negatives come from real Google
    Fonts family files (see train.replay_gf). replay_repeat concatenates the
    replay set multiple times so each epoch sees enough old-class signal.
    """
    from torch.utils.data import ConcatDataset, DataLoader

    from train.cache import cache_root
    from train.fetch import _fetch_one
    from train.registry import load_manifest
    from train.replay_gf import load_replay_fonts

    if per_class_replay < 0:
        raise ValueError("per_class_replay must be >= 0")
    if replay_repeat < 1:
        raise ValueError("replay_repeat must be >= 1")
    records = load_manifest()
    if fetch_fonts:
        from concurrent.futures import ThreadPoolExecutor, as_completed

        root = cache_root()
        seen: set[str] = set()
        jobs = []
        for rec in records:
            if not rec.file_sha256 or rec.file_sha256 in seen:
                continue
            seen.add(rec.file_sha256)
            jobs.append(rec)
        with ThreadPoolExecutor(max_workers=8) as pool:
            futs = [pool.submit(_fetch_one, rec, root) for rec in jobs]
            for fut in as_completed(futs):
                fut.result()
    new_specs = build_specs(n_classes=len(records), split="train", per_class=per_class_new, records=records)
    new_ds = FontSnapSynth(new_specs, records=records, label_offset=SHIPPED_CLASS_COUNT)
    parts: list = [new_ds]
    if per_class_replay > 0:
        fonts = load_replay_fonts(fetch=fetch_fonts, root=cache_root())
        if not fonts:
            raise RuntimeError("gf replay requested but no old-class fonts were available")
        class_indices = sorted(i for i in fonts if 0 <= i < BASE_CLASSES)
        replay_specs = _replay_specs(class_indices, per_class_replay)
        replay_ds = OldClassReplaySynth(replay_specs, fonts)
        parts.extend([replay_ds] * replay_repeat)
    dataset = parts[0] if len(parts) == 1 else ConcatDataset(parts)
    return DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=shuffle,
        num_workers=num_workers,
        persistent_workers=num_workers > 0,
    )
