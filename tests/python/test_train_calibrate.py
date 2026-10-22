from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def test_calibrate_recipe_matches_ofl_v1_shape():
    from train.loop import recipe
    from train.recipe_defs import CALIBRATE_STEPS, OFL_V1_BATCH_SIZE

    cal = recipe("calibrate")
    ofl = recipe("ofl-v1")
    assert cal.steps == CALIBRATE_STEPS
    assert cal.batch_size == ofl.batch_size == OFL_V1_BATCH_SIZE
    assert cal.amp == ofl.amp
    assert cal.per_class_new == ofl.per_class_new
    assert cal.per_class_replay == ofl.per_class_replay == 0
    assert cal.freeze_backbone == ofl.freeze_backbone


def test_calibrate_one_cpu_step_prints_rate_and_exits_0(tmp_path, monkeypatch, capsys):
    pytest.importorskip("torch")
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")

    payload = b"\x00\x01\x00\x00" + b"calibrate-fixture"
    monkeypatch.setenv("FONTSNAP_SKIP_FETCH", "1")
    monkeypatch.setattr("train.dataset.read_verified", lambda _sha, root=None: payload)
    from PIL import ImageFont

    monkeypatch.setattr(
        "train.render._font",
        lambda _bytes, _size_px, _instance: ImageFont.load_default(),
    )
    monkeypatch.setattr("train.loop.OFL_V1_PER_CLASS_NEW", 1)
    monkeypatch.setattr("train.loop.CALIBRATE_WARMUP_STEPS", 0)
    cache = tmp_path / "font-cache"
    cache.mkdir()
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(cache))
    monkeypatch.setattr("train.paths.OUT", tmp_path)

    from train.loop import main as loop_main

    assert loop_main(["--recipe", "calibrate", "--steps", "1", "--device", "cpu"]) == 0
    assert "samples/sec" in capsys.readouterr().out


def test_calibrate_timer_starts_after_loader_warmup(tmp_path, monkeypatch, capsys):
    """B3: font fetch / worker start must not sit inside the samples/sec window."""
    pytest.importorskip("torch")
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")

    payload = b"\x00\x01\x00\x00" + b"warmup-fixture"
    monkeypatch.setenv("FONTSNAP_SKIP_FETCH", "1")
    monkeypatch.setattr("train.dataset.read_verified", lambda _sha, root=None: payload)
    from PIL import ImageFont

    monkeypatch.setattr(
        "train.render._font",
        lambda _bytes, _size_px, _instance: ImageFont.load_default(),
    )
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(tmp_path / "font-cache"))
    (tmp_path / "font-cache").mkdir()
    monkeypatch.setattr("train.loop.CALIBRATE_WARMUP_STEPS", 2)
    monkeypatch.setattr("train.export.export_onnx_fp16", lambda *a, **k: None)

    import train.loop as loop

    order: list[str] = []
    real_batches = loop._batches

    def wrapped(cfg, device, *, limit):
        order.append(f"loader:{limit}")
        yield from real_batches(cfg, device, limit=limit)

    times = {"n": 0.0}

    def fake_perf():
        times["n"] += 1.0
        order.append(f"timer:{times['n']}")
        return times["n"]

    monkeypatch.setattr(loop, "_batches", wrapped)
    monkeypatch.setattr(loop.time, "perf_counter", fake_perf)

    from train.loop import main as loop_main

    assert loop_main(["--recipe", "calibrate", "--steps", "2", "--device", "cpu"]) == 0
    assert order[0].startswith("loader:")
    assert any(item.startswith("timer:") for item in order)
    assert order.index(next(i for i in order if i.startswith("loader:"))) < order.index(next(i for i in order if i.startswith("timer:")))
    assert "samples/sec" in capsys.readouterr().out


def test_ofl_v1_writes_ckpt_when_onnx_export_fails(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")

    payload = b"\x00\x01\x00\x00" + b"export-fail"
    monkeypatch.setenv("FONTSNAP_SKIP_FETCH", "1")
    monkeypatch.setattr("train.dataset.read_verified", lambda _sha, root=None: payload)
    from PIL import ImageFont

    monkeypatch.setattr(
        "train.render._font",
        lambda _bytes, _size_px, _instance: ImageFont.load_default(),
    )
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(tmp_path / "font-cache"))
    (tmp_path / "font-cache").mkdir()

    def boom(*_a, **_k):
        raise RuntimeError("cuda export crashed")

    monkeypatch.setattr("train.export.export_onnx_fp16", boom)

    from train.loop import main as loop_main

    assert loop_main(["--recipe", "ofl-v1", "--steps", "1", "--device", "cpu"]) == 0
    assert (tmp_path / "train" / "ckpt-final.pt").is_file()
    assert not (tmp_path / "train" / "candidate.onnx").exists()


def test_train_streams_and_writes_final_ckpt(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")

    payload = b"\x00\x01\x00\x00" + b"stream-fixture"
    monkeypatch.setenv("FONTSNAP_SKIP_FETCH", "1")
    monkeypatch.setattr("train.dataset.read_verified", lambda _sha, root=None: payload)
    from PIL import ImageFont

    monkeypatch.setattr(
        "train.render._font",
        lambda _bytes, _size_px, _instance: ImageFont.load_default(),
    )
    monkeypatch.setattr("train.loop.OFL_V1_PER_CLASS_NEW", 1)
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(tmp_path / "font-cache"))
    (tmp_path / "font-cache").mkdir()

    import train.loop as loop

    assert "list(_batches" not in Path(loop.__file__).read_text(encoding="utf-8")
    assert loop.main(["--recipe", "ofl-v1", "--steps", "2", "--device", "cpu"]) == 0
    assert (tmp_path / "train" / "ckpt-final.pt").is_file()
