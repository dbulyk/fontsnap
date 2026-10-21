"""Export refuses model/ before torch is imported."""

import subprocess
import sys
from pathlib import Path

import pytest

from train.export import dest_allowed, export_onnx_fp16
from train.paths import MODEL_DIR, ROOT

PYTHON = Path(__file__).resolve().parents[2] / "python"


def test_dest_allowed_rejects_the_product_model_dir():
    assert dest_allowed(MODEL_DIR / "model_fp16.onnx") is False
    assert dest_allowed(MODEL_DIR / "anything.onnx") is False
    assert dest_allowed(ROOT / "out" / "train" / "candidate.onnx") is True


def test_export_raises_before_using_the_model():
    with pytest.raises(ValueError, match="model/"):
        export_onnx_fp16(None, MODEL_DIR / "model_fp16.onnx", num_classes=3665)
    with pytest.raises(ValueError, match="model/"):
        export_onnx_fp16(None, MODEL_DIR / "anything.onnx", num_classes=3665)


def test_dest_check_does_not_import_torch():
    script = """
import sys
from pathlib import Path
from train.export import dest_allowed, export_onnx_fp16
from train.paths import MODEL_DIR
assert dest_allowed(MODEL_DIR / "model_fp16.onnx") is False
try:
    export_onnx_fp16(None, MODEL_DIR / "anything.onnx", num_classes=3665)
except ValueError as err:
    assert "model/" in str(err)
else:
    raise SystemExit("expected ValueError")
assert "torch" not in sys.modules
"""
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=PYTHON,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
