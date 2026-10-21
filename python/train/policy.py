"""Train-side merge groups and source ranks.

``fontsnap_ref.pipeline.MERGE`` and ``KEEP_NOTO`` stay on the product path.
``TRAIN_MERGE_GROUPS`` names Iosevka, Monaspace, Redaction, Open Sauce, and Inter-like families.
``members`` is empty until a hold-out review fills it, so ``apply_train_merge`` keeps each key.
``DEFAULT_RANK_BY_SOURCE`` is 3000 for every source.
That is the rank the live ranker already uses when Google Fonts has no popularity for a family.
"""

from __future__ import annotations

import enum
from collections.abc import Mapping
from dataclasses import dataclass

MISSING_RANK = 3000


@dataclass(frozen=True, slots=True)
class MergeGroup:
    name: str
    members: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class PriorPolicy:
    source: str
    default_rank: int


PRIOR_BY_SOURCE: dict[str, PriorPolicy] = {
    "fontsource": PriorPolicy("fontsource", MISSING_RANK),
    "collletttivo": PriorPolicy("collletttivo", MISSING_RANK),
    "velvetyne": PriorPolicy("velvetyne", MISSING_RANK),
}

DEFAULT_RANK_BY_SOURCE: dict[str, int] = {source: policy.default_rank for source, policy in PRIOR_BY_SOURCE.items()}

# Canonical family_key, then the keys that should disappear into it. Empty until a hold-out review.
TRAIN_MERGE_GROUPS: tuple[MergeGroup, ...] = (
    MergeGroup("iosevka", ()),
    MergeGroup("monaspace", ()),
    MergeGroup("redaction", ()),
    MergeGroup("opensauce", ()),
    MergeGroup("inter", ()),
)


def merge_alias(groups: tuple[MergeGroup, ...]) -> dict[str, str]:
    seen_names: set[str] = set()
    alias: dict[str, str] = {}
    for group in groups:
        if not group.name or group.name in seen_names:
            raise ValueError(f"merge group name {group.name!r}")
        seen_names.add(group.name)
        for member in group.members:
            if not member or member == group.name:
                raise ValueError(f"merge member {member!r} in {group.name}")
            if member in alias:
                raise ValueError(f"{member} is in {alias[member]} and {group.name}")
            alias[member] = group.name
    return alias


merge_alias(TRAIN_MERGE_GROUPS)


def family_rank(family_key: str, source: str | enum.Enum | None, gf_rank: Mapping[str, float]) -> float:
    if family_key in gf_rank:
        return float(gf_rank[family_key])
    if source is None:
        return float(MISSING_RANK)
    key = source.value if isinstance(source, enum.Enum) else source
    if not isinstance(key, str) or key not in PRIOR_BY_SOURCE:
        raise KeyError(key)
    return float(PRIOR_BY_SOURCE[key].default_rank)


def apply_train_merge(keys: list[str], groups: tuple[MergeGroup, ...] | None = None) -> list[str]:
    """Rename-and-dedupe. The first mapped key is kept. Later copies are dropped. The input list is not changed."""
    alias = merge_alias(TRAIN_MERGE_GROUPS if groups is None else groups)
    out: list[str] = []
    for key in keys:
        mapped = alias[key] if key in alias else key
        if mapped not in out:
            out.append(mapped)
    return out
