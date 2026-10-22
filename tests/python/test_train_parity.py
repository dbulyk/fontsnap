from pathlib import Path

import numpy as np
import pytest

from fontsnap_ref.pipeline import MODEL
from train.name_map import DEFAULT_TSV, OPS, load_name_map
from train.port import apply_layout

ROOT = Path(__file__).resolve().parents[2]


def test_layout_ops_reshape_the_way_the_tsv_says():
    weight = np.arange(6, dtype=np.float32).reshape(2, 3)
    transposed = apply_layout("transpose_oi", weight, (3, 2))
    assert transposed.shape == (3, 2)
    assert transposed[0, 1] == weight[1, 0]
    conv = np.arange(8, dtype=np.float32).reshape(2, 4, 1, 1)
    flat = apply_layout("conv1x1_to_linear", conv, (2, 4))
    assert flat.shape == (2, 4)
    assert flat[1, 3] == conv[1, 3, 0, 0]
    copied = apply_layout("copy", weight, (2, 3))
    assert copied.shape == (2, 3)
    with pytest.raises(ValueError):
        apply_layout("copy", weight, (3, 2))


def test_name_map_tsv_matches_the_shipped_initializer_names():
    rows = load_name_map(DEFAULT_TSV)
    by_timm = {row.timm_name: row for row in rows}
    assert len(rows) == 262
    assert {row.op for row in rows} <= OPS
    assert by_timm["classifier.weight"].op == "copy"
    assert by_timm["classifier.weight"].timm_shape == (3665, 1536)
    assert by_timm["classifier.bias"].op == "copy"
    assert by_timm["blocks.0.0.se.conv_reduce.weight"].op == "copy"
    assert by_timm["conv_stem.weight"].onnx_name.startswith("onnx::Conv_")
    assert by_timm["bn1.bias"].onnx_name.startswith("onnx::Conv_")
    text = (ROOT / "python" / "train" / "port.py").read_text(encoding="utf-8")
    assert "graph.node" not in text


def test_real_image_matches_ort_within_fp16_tolerance():
    pytest.importorskip("torch")
    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")
    from train.parity import PARITY_MAX_ABS, PARITY_PROB_ATOL, PARITY_TOP1, compare, openable_images

    images = openable_images(ROOT / "data" / "realset3" / "images", 1)
    if not images:
        pytest.skip("no decodable realset3 image")
    report = compare(MODEL, images)
    assert report.n == 2
    assert report.top1_agree == PARITY_TOP1
    assert report.max_abs <= PARITY_MAX_ABS
    assert report.max_prob_abs <= PARITY_PROB_ATOL
