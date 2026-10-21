"""Train-side ranks and merge groups. Product MERGE stays put."""

import enum

import pytest

from fontsnap_ref.pipeline import KEEP_NOTO, MERGE
from train.policy import (
    DEFAULT_RANK_BY_SOURCE,
    MISSING_RANK,
    PRIOR_BY_SOURCE,
    TRAIN_MERGE_GROUPS,
    MergeGroup,
    apply_train_merge,
    family_rank,
)


def test_import_leaves_the_product_merge_table():
    assert MERGE == {
        "intertight": "inter",
        "ibmplexsanskr": "ibmplexsans",
        "ibmplexsanscondensed": "ibmplexsans",
        "robotoflex": "roboto",
        "robotocondensed": "roboto",
        "opensanscondensed": "opensans",
        "notosansdisplay": "notosans",
    }
    assert KEEP_NOTO == (
        "notosanssc",
        "notosanstc",
        "notosanshk",
        "notosansjp",
        "notosanskr",
        "notosansarabic",
        "notosansdevanagari",
        "notosansmono",
        "notosansthai",
        "notosanshebrew",
    )


def test_default_rank_is_3000_for_every_source():
    assert set(DEFAULT_RANK_BY_SOURCE) == {"fontsource", "collletttivo", "velvetyne"}
    assert set(DEFAULT_RANK_BY_SOURCE.values()) == {3000}
    assert MISSING_RANK == 3000
    for source, policy in PRIOR_BY_SOURCE.items():
        assert policy.source == source
        assert policy.default_rank == 3000
        assert family_rank("any-family", source, {}) == 3000


def test_google_fonts_rank_wins_and_a_missing_source_is_3000():
    assert family_rank("inter", "fontsource", {"inter": 12}) == 12
    assert family_rank("custom", None, {}) == 3000
    with pytest.raises(KeyError):
        family_rank("custom", "other", {})

    class _Source(enum.Enum):
        FONTSOURCE = "fontsource"

    assert family_rank("custom", _Source.FONTSOURCE, {}) == 3000


def test_train_merge_groups_name_the_superfamilies_and_start_empty():
    assert [group.name for group in TRAIN_MERGE_GROUPS] == [
        "iosevka",
        "monaspace",
        "redaction",
        "opensauce",
        "inter",
    ]
    assert all(group.members == () for group in TRAIN_MERGE_GROUPS)
    keys = ["intertight", "inter", "iosevka", "monaspace"]
    merged = apply_train_merge(keys)
    keys.append("roboto")
    assert merged == ["intertight", "inter", "iosevka", "monaspace"]


def test_a_filled_group_keeps_the_first_mapped_key():
    groups = (MergeGroup("inter", ("intertight",)),)
    assert apply_train_merge(["intertight", "roboto", "inter"], groups) == ["inter", "roboto"]
    with pytest.raises(ValueError):
        apply_train_merge(
            ["intertight"],
            (MergeGroup("inter", ("intertight",)), MergeGroup("opensauce", ("intertight",))),
        )
