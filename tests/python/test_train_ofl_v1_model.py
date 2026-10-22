"""ofl-v1 step B on the real network: threat softplus, partial unfreeze and the exported ONNX."""

from __future__ import annotations

import numpy as np
import pytest

from train.model import BASE_CLASSES

N_NEW = 4
MARGIN = 8.0
TRAINABLE = ("blocks.5.", "blocks.6.", "conv_head.", "classifier.")


def _weights():
    from fontsnap_ref.pipeline import MODEL

    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")
    return MODEL


def _replay_row(torch, *, label: int, label_logit: float, best_new: float):
    # Every other logit sits far below both, so `best_new` is the max over new rows.
    logits = torch.full((1, BASE_CLASSES + N_NEW), min(label_logit, best_new) - 60.0)
    logits[0, label] = label_logit
    logits[0, BASE_CLASSES + 1] = best_new
    logits[0, BASE_CLASSES + 2] = best_new - 1.0
    return logits


def test_softplus_is_silent_once_the_labeled_class_leads_by_more_than_the_margin():
    torch = pytest.importorskip("torch")
    from train.loop import threat_softplus

    logits = _replay_row(torch, label=7, label_logit=10.0, best_new=10.0 - MARGIN - 40.0).requires_grad_()
    loss = threat_softplus(logits, torch.tensor([7]), margin=MARGIN, weight=1.0)
    loss.backward()
    assert loss.item() < 1e-12
    assert float(logits.grad.abs().max()) < 1e-12


def test_softplus_falls_as_the_labeled_class_rises():
    torch = pytest.importorskip("torch")
    from train.loop import threat_softplus

    losses = [
        float(threat_softplus(_replay_row(torch, label=7, label_logit=x, best_new=0.0), torch.tensor([7]), margin=MARGIN, weight=1.0))
        for x in (-6.0, -2.0, 0.0, 4.0, 8.0, 12.0)
    ]
    assert all(a > b for a, b in zip(losses, losses[1:], strict=False))
    # Threatened (best new within the margin): a real penalty, not a rounding error.
    assert losses[2] > 1.0


def test_softplus_pushes_only_the_best_new_logit_down():
    torch = pytest.importorskip("torch")
    from train.loop import threat_softplus

    logits = _replay_row(torch, label=7, label_logit=0.0, best_new=0.0).requires_grad_()
    threat_softplus(logits, torch.tensor([7]), margin=MARGIN, weight=1.0).backward()
    grad = logits.grad[0]
    assert float(grad[BASE_CLASSES + 1]) > 0.5
    assert float(grad[BASE_CLASSES + 2]) == 0.0
    assert float(grad[BASE_CLASSES + 3]) == 0.0


def test_softplus_ignores_rows_labeled_with_new_classes():
    torch = pytest.importorskip("torch")
    from train.loop import threat_softplus

    replay = _replay_row(torch, label=7, label_logit=0.0, best_new=0.0)
    new = _replay_row(torch, label=3, label_logit=0.0, best_new=50.0)
    mixed = torch.cat([replay, new]).requires_grad_()
    labels = torch.tensor([7, BASE_CLASSES + 1])
    loss = threat_softplus(mixed, labels, margin=MARGIN, weight=1.0)
    loss.backward()
    assert float(mixed.grad[1].abs().max()) == 0.0
    # The new row neither adds to nor dilutes the replay mean.
    alone = threat_softplus(replay, torch.tensor([7]), margin=MARGIN, weight=1.0)
    assert loss.item() == pytest.approx(alone.item())


def test_softplus_is_zero_for_a_batch_of_new_labels_and_leaves_ce_untouched():
    torch = pytest.importorskip("torch")
    import torch.nn.functional as F

    from train.loop import threat_softplus

    logits = torch.randn(3, BASE_CLASSES + N_NEW, generator=torch.Generator().manual_seed(0))
    labels = torch.tensor([BASE_CLASSES, BASE_CLASSES + 1, BASE_CLASSES + 3])
    with_penalty = logits.clone().requires_grad_()
    ce_only = logits.clone().requires_grad_()
    penalty = threat_softplus(with_penalty, labels, margin=MARGIN, weight=1.0)
    assert float(penalty) == 0.0
    (F.cross_entropy(with_penalty, labels) + penalty).backward()
    F.cross_entropy(ce_only, labels).backward()
    assert torch.equal(with_penalty.grad, ce_only.grad)


def test_softplus_scales_with_its_weight():
    torch = pytest.importorskip("torch")
    from train.loop import threat_softplus

    row = _replay_row(torch, label=7, label_logit=0.0, best_new=0.0)
    one = float(threat_softplus(row, torch.tensor([7]), margin=MARGIN, weight=1.0))
    assert float(threat_softplus(row, torch.tensor([7]), margin=MARGIN, weight=0.0)) == 0.0
    assert float(threat_softplus(row, torch.tensor([7]), margin=MARGIN, weight=2.5)) == pytest.approx(2.5 * one)


def _one_step_config(tmp_path):
    from train.loop import TrainConfig, recipe

    base = recipe("ofl-v1")
    return TrainConfig(
        recipe=base.recipe,
        steps=1,
        batch_size=4,
        lr=base.lr,
        backbone_lr=base.backbone_lr,
        weight_decay=base.weight_decay,
        amp=False,
        num_classes=base.num_classes,
        device="cpu",
        checkpoint_dir=tmp_path / "train",
        suppress_weight=base.suppress_weight,
        suppress_margin=base.suppress_margin,
        use_synth=True,
        per_class_new=1,
        per_class_replay=1,
        replay_repeat=1,
        num_workers=0,
        total_samples=base.total_samples,
        checkpoint_every=0,
        unfreeze_from_block=base.unfreeze_from_block,
    )


def _stub_fonts(monkeypatch, tmp_path):
    from PIL import ImageFont

    payload = b"\x00\x01\x00\x00" + b"one-step"
    monkeypatch.setenv("FONTSNAP_SKIP_FETCH", "1")
    monkeypatch.setattr("train.paths.OUT", tmp_path)
    # train.cache binds OUT at import time; point the cache under the patched OUT explicitly.
    monkeypatch.setenv("FONTSNAP_FONT_CACHE", str(tmp_path / "cache"))
    (tmp_path / "cache").mkdir(exist_ok=True)
    monkeypatch.setattr("train.dataset.read_verified", lambda _sha, root=None: payload)
    monkeypatch.setattr("train.replay_gf.load_replay_fonts", lambda **_kwargs: {i: payload for i in range(16)})
    monkeypatch.setattr("train.render._font", lambda _bytes, _size_px, _instance: ImageFont.load_default())
    monkeypatch.setattr("train.export.export_onnx_fp16", lambda *a, **k: None)


def test_one_adamw_step_moves_only_the_unfrozen_tail_at_its_own_learning_rate(tmp_path, monkeypatch):
    """First AdamW step moves a parameter by about its group's lr; frozen tensors stay bitwise."""
    torch = pytest.importorskip("torch")
    model_path = _weights()
    _stub_fonts(monkeypatch, tmp_path)

    from train.loop import train
    from train.model import EfficientNetB3Classifier, expand_classifier
    from train.port import load_efficientnet_b3_from_onnx

    cfg = _one_step_config(tmp_path)
    before = expand_classifier(load_efficientnet_b3_from_onnx(model_path, num_classes=BASE_CLASSES), BASE_CLASSES, cfg.num_classes)
    prior = {k: v.detach().clone() for k, v in before.state_dict().items()}
    blob = torch.load(train(cfg), map_location="cpu", weights_only=False)
    after = EfficientNetB3Classifier(int(blob["num_classes"]))
    after.load_state_dict(blob["state_dict"])
    now = after.state_dict()

    assert set(now) == set(prior)
    frozen = [k for k in prior if not k.startswith(TRAINABLE)]
    assert any(k.startswith("blocks.4.") for k in frozen)
    assert any(k.startswith("conv_stem.") for k in frozen)
    for key in frozen:
        assert torch.equal(now[key], prior[key]), key

    def max_step(prefixes, rows=slice(None)):
        return max(float((now[k][rows] - prior[k][rows]).abs().max()) for k in prior if k.startswith(prefixes))

    backbone = max_step(("blocks.5.", "blocks.6.", "conv_head."))
    # New head rows start at weight 0, so their step is pure Adam (no decay term).
    head = float((now["classifier.weight"][BASE_CLASSES:] - prior["classifier.weight"][BASE_CLASSES:]).abs().max())
    # Folded-BN conv weights are large, so decoupled decay adds up to ~half an lr on top.
    assert 0.5 * 1e-4 < backbone < 3 * 1e-4, backbone
    assert 0.5 * 1e-3 < head < 1.5 * 1e-3, head
    assert torch.equal(now["classifier.weight"][:BASE_CLASSES], prior["classifier.weight"][:BASE_CLASSES])
    assert torch.equal(now["classifier.bias"][:BASE_CLASSES], prior["classifier.bias"][:BASE_CLASSES])


def _text_input() -> np.ndarray:
    from PIL import Image, ImageDraw, ImageFont

    from fontsnap_ref.pipeline import prep

    canvas = Image.new("RGB", (480, 160), (255, 255, 255))
    ImageDraw.Draw(canvas).text((20, 50), "Handgloves 2024", fill=(0, 0, 0), font=ImageFont.load_default(size=48))
    return np.ascontiguousarray(prep(canvas), dtype=np.float32)


def test_export_ships_the_whole_trained_network_not_only_the_head(tmp_path, monkeypatch):
    torch = pytest.importorskip("torch")
    pytest.importorskip("onnx")
    ort = pytest.importorskip("onnxruntime")
    model_path = _weights()
    monkeypatch.setattr("train.paths.OUT", tmp_path)

    from train.export import export_onnx_fp16
    from train.model import expand_classifier, expanded_classes
    from train.port import load_efficientnet_b3_from_onnx

    model = expand_classifier(load_efficientnet_b3_from_onnx(model_path, num_classes=BASE_CLASSES), BASE_CLASSES, expanded_classes())
    # Change only the backbone tail, as the unfrozen blocks would after training.
    generator = torch.Generator().manual_seed(0)
    with torch.no_grad():
        for name, param in model.module.named_parameters():
            if name.startswith(("blocks.5.", "blocks.6.")) and name.endswith("weight"):
                param.mul_(1.0 + 0.3 * torch.randn(param.shape, generator=generator))
    model.eval()
    dest = tmp_path / "train" / "candidate.onnx"
    export_onnx_fp16(model, dest, num_classes=expanded_classes())

    x = _text_input()
    with torch.inference_mode():
        expected = model(torch.from_numpy(x)).float().numpy()[0]
    exported = ort.InferenceSession(str(dest), providers=["CPUExecutionProvider"]).run(["logits"], {"input": x})[0][0]
    shipped = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"]).run(["logits"], {"input": x})[0][0]

    assert exported.shape == (expanded_classes(),)
    export_error = float(np.abs(exported - expected).max())
    moved = float(np.abs(exported[:BASE_CLASSES] - shipped).max())
    assert export_error < 0.25, export_error
    assert int(exported.argmax()) == int(expected.argmax())
    assert moved > 20 * export_error, (moved, export_error)
