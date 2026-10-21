from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from fontsnap_ref.image import to_rgb
from fontsnap_ref.pipeline import MODEL, prep
from fontsnap_ref.textcrop import crop_normalize
from train.model import EfficientNetB3Classifier
from train.parity import PARITY_MAX_ABS, openable_images
from train.port import load_efficientnet_b3_from_onnx

torch = pytest.importorskip("torch")

ROOT = Path(__file__).resolve().parents[2]
# Adam at 1e-4 moves these logits past the 0.06 top-1 margin. 1e-5 keeps the argmax.
STEP_LR = 1e-5


def _images():
    if not MODEL.is_file() or MODEL.stat().st_size < 1_000_000:
        pytest.skip("onnx weights are not pulled")
    images = openable_images(ROOT / "data" / "realset3" / "images", 8)
    if len(images) < 8:
        pytest.skip("need 8 decodable realset3 images")
    return images


def _prepared(images):
    tensors = []
    for path in images:
        with Image.open(path) as opened:
            pil = to_rgb(opened)
        for variant in ("pack", "crop"):
            tensors.append(np.ascontiguousarray(prep(crop_normalize(pil, variant)), dtype=np.float32))
    return tensors


def _references(tensors):
    import onnxruntime as ort

    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    rows = []
    for nchw in tensors:
        logits = session.run(["logits"], {"input": np.ascontiguousarray(nchw, dtype=np.float32)})[0]
        rows.append(np.asarray(logits, dtype=np.float32)[0])
    return rows


def _forward(model, nchw):
    with torch.inference_mode():
        return model(torch.from_numpy(nchw)).detach().float().numpy()[0]


def _score(model, tensors, refs):
    matches = 0
    worst = 0.0
    for nchw, ref in zip(tensors, refs, strict=True):
        pred = _forward(model, nchw)
        worst = max(worst, float(np.max(np.abs(pred - ref))))
        matches += int(int(np.argmax(pred)) == int(np.argmax(ref)))
    return matches, worst


def _running(module):
    saved = {}
    for name, buf in module.named_buffers():
        if name.endswith(("running_mean", "running_var", "num_batches_tracked")):
            saved[name] = buf.detach().clone()
    return saved


def _same_buffers(before, after):
    assert set(before) == set(after)
    for name, lhs in before.items():
        rhs = after[name]
        if lhs.dtype.is_floating_point:
            delta = float((lhs - rhs).abs().max())
            assert delta == 0.0, f"{name} {delta}"
        else:
            assert torch.equal(lhs, rhs), name


def test_train_mode_top1_matches_ort_on_realset3():
    tensors = _prepared(_images())
    refs = _references(tensors)
    model = load_efficientnet_b3_from_onnx(MODEL)
    model.train()
    matches, worst = _score(model, tensors, refs)
    n = len(tensors)
    assert matches == n, f"top1 {matches}/{n} max|dlogit|={worst}"
    assert worst <= PARITY_MAX_ABS, worst


def test_train_forward_does_not_move_later_eval():
    tensors = _prepared(_images())
    model = load_efficientnet_b3_from_onnx(MODEL)
    sample = torch.from_numpy(tensors[0])
    model.eval()
    with torch.inference_mode():
        before = model(sample).detach().clone()
    buffers = _running(model.module)
    model.train()
    trained = model(sample).detach()
    train_delta = float((trained - before).abs().max())
    assert train_delta == 0.0, train_delta
    _same_buffers(buffers, _running(model.module))
    model.eval()
    with torch.inference_mode():
        after = model(sample).detach()
    eval_delta = float((after - before).abs().max())
    assert eval_delta == 0.0, eval_delta


def test_real_prep_step_keeps_ort_top1():
    tensors = _prepared(_images())
    refs = _references(tensors)
    model = load_efficientnet_b3_from_onnx(MODEL)
    model.eval()
    before_matches, before_worst = _score(model, tensors, refs)
    n = len(tensors)
    assert before_matches == n, f"top1 {before_matches}/{n} max|dlogit|={before_worst}"
    assert before_worst <= PARITY_MAX_ABS, before_worst
    batch = torch.from_numpy(np.concatenate(tensors, axis=0))
    with torch.inference_mode():
        guessed = torch.argmax(model(batch), dim=1)
    labels = guessed.clone()
    assert labels.tolist() == [int(np.argmax(row)) for row in refs]
    buffers = _running(model.module)
    model.train()
    opt = torch.optim.AdamW(model.parameters(), lr=STEP_LR, weight_decay=0.0)
    opt.zero_grad(set_to_none=True)
    loss = torch.nn.functional.cross_entropy(model(batch), labels)
    loss.backward()
    opt.step()
    model.eval()
    matches, worst = _score(model, tensors, refs)
    n = len(tensors)
    assert matches == n, f"top1 {matches}/{n} max|dlogit|={worst}"
    _same_buffers(buffers, _running(model.module))
    assert torch.isfinite(loss).item()


def test_reloaded_checkpoint_matches_the_loaded_model():
    tensors = _prepared(_images()[:1])
    model = load_efficientnet_b3_from_onnx(MODEL)
    model.eval()
    fresh = EfficientNetB3Classifier()
    fresh.load_state_dict(model.state_dict())
    fresh.eval()
    assert torch.equal(_as_tensor(model, tensors[0]), _as_tensor(fresh, tensors[0]))


def _as_tensor(model, nchw):
    with torch.inference_mode():
        return model(torch.from_numpy(nchw)).detach()
