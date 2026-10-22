from train.model import BASE_CLASSES, EXPANDED_CLASSES, expanded_classes
from train.registry import PHASE1_CLASSES, load_manifest


def test_expanded_classes_match_manifest_length():
    assert expanded_classes() == BASE_CLASSES + PHASE1_CLASSES
    assert EXPANDED_CLASSES == BASE_CLASSES + len(load_manifest())
    assert EXPANDED_CLASSES == 4262
    assert EXPANDED_CLASSES != 4271
