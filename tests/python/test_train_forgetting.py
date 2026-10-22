"""Preservation: freeze backbone + new-bias init keep old classes (B1)."""

from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


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
            logits = model(torch.from_numpy(prep(Image.open(path).convert("RGB")))).numpy()[0]
            checked += 1
            if int(logits.argmax()) >= BASE_CLASSES:
                stolen += 1
    assert stolen == 0, f"new rows won argmax on {stolen}/{checked} images at step 0"


def test_frozen_backbone_and_old_rows_unchanged_after_steps(tmp_path, monkeypatch):
    """Freeze + restore beats AdamW weight decay; old realset3 path is bit-identical."""
    pytest.importorskip("torch")
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")

    payload = b"\x00\x01\x00\x00" + b"forget-fixture"
    monkeypatch.setenv("FONTSNAP_SKIP_FETCH", "1")
    monkeypatch.setattr("train.dataset.read_verified", lambda _sha, root=None: payload)
    from PIL import ImageFont

    monkeypatch.setattr(
        "train.render._font",
        lambda _bytes, _size_px, _instance: ImageFont.load_default(),
    )
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(tmp_path / "cache"))
    (tmp_path / "cache").mkdir()
    monkeypatch.setattr("train.export.export_onnx_fp16", lambda *a, **k: None)

    import torch
    from PIL import Image

    from fontsnap_ref.pipeline import prep
    from train.loop import TrainConfig, recipe, train
    from train.model import BASE_CLASSES, EfficientNetB3Classifier, expand_classifier
    from train.port import load_efficientnet_b3_from_onnx
    from train.shots import MAX_DISPLACEMENT

    base_cfg = recipe("ofl-v1")
    assert base_cfg.freeze_backbone is True
    cfg = TrainConfig(
        recipe=base_cfg.recipe,
        steps=30,
        batch_size=base_cfg.batch_size,
        lr=base_cfg.lr,
        weight_decay=base_cfg.weight_decay,
        amp=False,
        num_classes=base_cfg.num_classes,
        device="cpu",
        checkpoint_dir=tmp_path / "train",
        distill_weight=0.0,
        distill_dir="",
        use_synth=True,
        per_class_new=1,
        per_class_replay=0,
        num_workers=0,
        total_samples=base_cfg.total_samples,
        checkpoint_every=0,
        freeze_backbone=True,
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
    after.eval()
    before.eval()

    max_backbone = 0.0
    max_old_head = 0.0
    new_head_moved = False
    with torch.no_grad():
        for key, prior in before_state.items():
            now = after.state_dict()[key]
            if key.startswith("classifier."):
                if key.endswith("weight") or key.endswith("bias"):
                    max_old_head = max(max_old_head, (now[:BASE_CLASSES] - prior[:BASE_CLASSES]).abs().max().item())
                    if (now[BASE_CLASSES:] - prior[BASE_CLASSES:]).abs().max().item() > 1e-8:
                        new_head_moved = True
            else:
                max_backbone = max(max_backbone, (now - prior).abs().max().item())
    assert max_backbone == 0.0
    assert max_old_head == 0.0
    assert new_head_moved

    # Bit-identical old path ⇒ realset3 family ranking cannot move (displacement 0 ≤ 2%).
    images = REPO / "data" / "realset3" / "images"
    if images.is_dir():
        max_logit_delta = 0.0
        with torch.no_grad():
            for path in sorted(images.iterdir())[:32]:
                batch = torch.from_numpy(prep(Image.open(path).convert("RGB")))
                d = (after(batch)[:, :BASE_CLASSES] - before(batch)[:, :BASE_CLASSES]).abs().max().item()
                max_logit_delta = max(max_logit_delta, d)
        assert max_logit_delta == 0.0
        assert 0.0 <= MAX_DISPLACEMENT
