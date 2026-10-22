"""Preservation: GF replay + partial unfreeze + threat-only softplus (B1 step B)."""

from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def _stub_train_fonts(monkeypatch, tmp_path, payload: bytes, *, replay_classes: int = 64):
    monkeypatch.setenv("FONTSNAP_SKIP_FETCH", "1")
    monkeypatch.setattr("train.dataset.read_verified", lambda _sha, root=None: payload)
    monkeypatch.setattr(
        "train.replay_gf.load_replay_fonts",
        lambda **_kwargs: {i: payload for i in range(replay_classes)},
    )
    from PIL import ImageFont

    monkeypatch.setattr(
        "train.render._font",
        lambda _bytes, _size_px, _instance: ImageFont.load_default(),
    )
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(tmp_path / "cache"))
    (tmp_path / "cache").mkdir(exist_ok=True)
    monkeypatch.setattr("train.export.export_onnx_fp16", lambda *a, **k: None)


def test_new_head_bias_does_not_dominate_argmax_at_step_zero():
    pytest.importorskip("torch")
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")
    images = REPO / "data" / "realset3" / "images"
    if not images.is_dir() or not any(images.iterdir()):
        pytest.skip("realset3 images are not pulled")

    import torch
    from PIL import Image

    from fontsnap_ref.pipeline import prep
    from train.model import BASE_CLASSES, NEW_HEAD_BIAS, expand_classifier, expanded_classes
    from train.port import load_efficientnet_b3_from_onnx

    assert NEW_HEAD_BIAS <= -80.0
    model = expand_classifier(
        load_efficientnet_b3_from_onnx(MODEL, num_classes=BASE_CLASSES),
        BASE_CLASSES,
        expanded_classes(),
    )
    model.eval()
    stolen = 0
    checked = 0
    with torch.no_grad():
        for path in sorted(images.iterdir()):
            # prep() calls to_rgb; do not Image.convert("RGB") (image-loading guard).
            logits = model(torch.from_numpy(prep(Image.open(path)))).numpy()[0]
            checked += 1
            if int(logits.argmax()) >= BASE_CLASSES:
                stolen += 1
    assert stolen == 0, f"new rows won argmax on {stolen}/{checked} images at step 0"


def test_loader_mixes_old_replay_labels_with_new(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    payload = b"\x00\x01\x00\x00" + b"mix"
    _stub_train_fonts(monkeypatch, tmp_path, payload, replay_classes=32)
    from train.dataset import make_ofl_loader
    from train.model import BASE_CLASSES

    loader = make_ofl_loader(
        batch_size=8,
        per_class_new=1,
        per_class_replay=1,
        num_workers=0,
        shuffle=True,
        fetch_fonts=False,
    )
    old = new = 0
    for _inputs, labels in loader:
        for value in labels.tolist():
            if int(value) < BASE_CLASSES:
                old += 1
            else:
                new += 1
        if old and new:
            break
    assert old > 0 and new > 0


def test_partial_unfreeze_moves_last_blocks_keeps_early_and_old_head(tmp_path, monkeypatch):
    pytest.importorskip("torch")
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")

    _stub_train_fonts(monkeypatch, tmp_path, b"\x00\x01\x00\x00" + b"forget-fixture", replay_classes=64)

    import torch

    from train.loop import TrainConfig, recipe, train
    from train.model import BASE_CLASSES, EfficientNetB3Classifier, expand_classifier
    from train.port import load_efficientnet_b3_from_onnx

    base_cfg = recipe("ofl-v1")
    assert base_cfg.per_class_replay >= 4
    assert base_cfg.unfreeze_from_block == 5
    assert base_cfg.suppress_weight > 0
    assert base_cfg.suppress_margin > 0
    cfg = TrainConfig(
        recipe=base_cfg.recipe,
        steps=8,
        batch_size=base_cfg.batch_size,
        lr=base_cfg.lr,
        backbone_lr=base_cfg.backbone_lr,
        weight_decay=base_cfg.weight_decay,
        amp=False,
        num_classes=base_cfg.num_classes,
        device="cpu",
        checkpoint_dir=tmp_path / "train",
        suppress_weight=base_cfg.suppress_weight,
        suppress_margin=base_cfg.suppress_margin,
        use_synth=True,
        per_class_new=1,
        per_class_replay=2,
        replay_repeat=1,
        num_workers=0,
        total_samples=base_cfg.total_samples,
        checkpoint_every=0,
        unfreeze_from_block=base_cfg.unfreeze_from_block,
    )
    before = expand_classifier(
        load_efficientnet_b3_from_onnx(MODEL, num_classes=BASE_CLASSES),
        BASE_CLASSES,
        cfg.num_classes,
    )
    before_state = {k: v.detach().clone() for k, v in before.state_dict().items()}
    dest = train(cfg)
    blob = torch.load(dest, map_location="cpu", weights_only=False)
    after = EfficientNetB3Classifier(int(blob["num_classes"]))
    after.load_state_dict(blob["state_dict"])

    max_early = 0.0
    max_late = 0.0
    max_old_head = 0.0
    new_head_moved = False
    with torch.no_grad():
        for key, prior in before_state.items():
            now = after.state_dict()[key]
            delta = (now - prior).abs().max().item()
            if key.startswith("classifier."):
                if key.endswith("weight") or key.endswith("bias"):
                    max_old_head = max(max_old_head, (now[:BASE_CLASSES] - prior[:BASE_CLASSES]).abs().max().item())
                    if (now[BASE_CLASSES:] - prior[BASE_CLASSES:]).abs().max().item() > 1e-8:
                        new_head_moved = True
            elif key.startswith("blocks.0.") or key.startswith("blocks.1.") or key.startswith("conv_stem."):
                max_early = max(max_early, delta)
            elif key.startswith("blocks.5.") or key.startswith("blocks.6.") or key.startswith("conv_head."):
                max_late = max(max_late, delta)
    assert max_early == 0.0
    assert max_late > 0.0
    assert max_old_head == 0.0
    assert new_head_moved


def test_replay_margin_suppress_in_loop_source():
    """Guard: softplus is on GF replay rows; web bank / LwF / logsumexp are gone."""
    import inspect

    from train import loop

    src = inspect.getsource(loop.train)
    assert "softplus" in src
    assert "max_new" in src and "max_old" in src
    assert "labels < BASE_CLASSES" in src
    assert "web_iter" not in src
    assert "web_bank" not in src
    assert "logsumexp" not in src
    assert "distill" not in src.lower()
    assert "apply_partial_unfreeze" in src
    # One call site only (import + call); no second model for LwF.
    assert src.count("load_efficientnet_b3_from_onnx(") == 1


def test_apply_partial_unfreeze_trainability():
    pytest.importorskip("torch")
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")

    from train.loop import apply_partial_unfreeze
    from train.model import BASE_CLASSES, expand_classifier, expanded_classes
    from train.port import load_efficientnet_b3_from_onnx

    model = expand_classifier(
        load_efficientnet_b3_from_onnx(MODEL, num_classes=BASE_CLASSES),
        BASE_CLASSES,
        expanded_classes(),
    )
    apply_partial_unfreeze(model, from_block=5)
    flags = {name: param.requires_grad for name, param in model.module.named_parameters()}
    assert flags["classifier.weight"] is True
    assert flags["conv_head.weight"] is True
    assert any(name.startswith("blocks.5.") and on for name, on in flags.items())
    assert any(name.startswith("blocks.6.") and on for name, on in flags.items())
    assert all(not on for name, on in flags.items() if name.startswith("blocks.0."))
    assert all(not on for name, on in flags.items() if name.startswith("blocks.4."))
    assert all(not on for name, on in flags.items() if name.startswith("conv_stem."))
