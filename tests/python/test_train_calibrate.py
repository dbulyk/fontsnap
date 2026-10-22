from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def test_calibrate_recipe_head_matches_synth_labels():
    from train.loop import recipe
    from train.model import expanded_classes
    from train.samples import SHIPPED_CLASS_COUNT

    cfg = recipe("calibrate")
    assert cfg.num_classes == expanded_classes()
    assert cfg.num_classes > SHIPPED_CLASS_COUNT
    assert cfg.use_synth is True


def test_calibrate_one_cpu_step_prints_rate_and_exits_0(tmp_path, monkeypatch, capsys):
    """Pod calibrate path on CPU: expanded head must accept synth labels."""
    pytest.importorskip("torch")
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")

    payload = b"\x00\x01\x00\x00" + b"calibrate-fixture"

    def fake_fetch(rec, root):
        from train.cache import cache_path

        dest = cache_path(rec.file_sha256, root)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)
        return rec.file_sha256

    monkeypatch.setattr("train.fetch._fetch_one", fake_fetch)
    monkeypatch.setattr("train.dataset.read_verified", lambda _sha, root=None: payload)
    from PIL import ImageFont

    monkeypatch.setattr(
        "train.render._font",
        lambda _bytes, _size_px, _instance: ImageFont.load_default(),
    )
    cache = tmp_path / "font-cache"
    cache.mkdir()
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(cache))
    monkeypatch.setattr("train.paths.OUT", tmp_path)

    from train.loop import main as loop_main

    assert loop_main(["--recipe", "calibrate", "--steps", "1", "--device", "cpu"]) == 0
    out = capsys.readouterr().out
    assert "samples/sec" in out
