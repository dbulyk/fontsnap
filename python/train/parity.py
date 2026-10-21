"""ORT versus the PyTorch port on prep(crop_normalize(image, pack|crop))."""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, UnidentifiedImageError

from fontsnap_ref.image import to_rgb
from fontsnap_ref.pipeline import MODEL, prep, softmax
from fontsnap_ref.textcrop import crop_normalize
from train.model import BASE_CLASSES
from train.paths import assert_under_out
from train.port import load_efficientnet_b3_from_onnx

PARITY_MAX_ABS = 2e-2
PARITY_PROB_ATOL = 2e-3
PARITY_TOP1 = 1.0
PARITY_VARIANTS = ("pack", "crop")
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}


@dataclass(frozen=True, slots=True)
class ParityReport:
    n: int
    max_abs: float
    mean_abs: float
    max_prob_abs: float
    top1_agree: float


def openable_images(folder: Path, limit: int) -> tuple[Path, ...]:
    """Skip Git LFS pointers and unreadable files. Return up to limit real images."""
    if limit < 1:
        raise ValueError("limit must be >= 1")
    picked: list[Path] = []
    if not folder.is_dir():
        return ()
    for path in sorted(folder.iterdir()):
        if not path.is_file() or path.suffix.lower() not in _IMAGE_SUFFIXES:
            continue
        try:
            with Image.open(path) as opened:
                opened.load()
        except (UnidentifiedImageError, OSError):
            continue
        picked.append(path)
        if len(picked) >= limit:
            break
    return tuple(picked)


def _session(onnx_path: Path):
    import onnxruntime as ort

    options = ort.SessionOptions()
    session = ort.InferenceSession(str(onnx_path), options, providers=["CPUExecutionProvider"])
    inputs = [item.name for item in session.get_inputs()]
    outputs = [item.name for item in session.get_outputs()]
    if inputs != ["input"] or outputs != ["logits"]:
        raise ValueError(f"expected input/logits, got {inputs} {outputs}")
    return session


def _run(session, nchw: np.ndarray) -> np.ndarray:
    tensor = np.ascontiguousarray(nchw, dtype=np.float32)
    logits = session.run(["logits"], {"input": tensor})[0]
    vector = np.asarray(logits, dtype=np.float32)[0]
    if vector.shape != (BASE_CLASSES,):
        raise ValueError(f"logits shape {vector.shape}")
    return vector


def reference_logits(onnx_path: Path, nchw: np.ndarray) -> np.ndarray:
    """One ORT CPU session. Returns float32 logits of shape (3665,). No softmax."""
    return _run(_session(onnx_path), nchw)


def compare(onnx_path: Path, images: tuple[Path, ...]) -> ParityReport:
    """Shared prep tensor for pack and crop. The module is loaded once."""
    if not images:
        raise ValueError("no images")
    import torch

    session = _session(onnx_path)
    model = load_efficientnet_b3_from_onnx(onnx_path)
    model.eval()
    abs_chunks: list[np.ndarray] = []
    prob_max = 0.0
    matches = 0
    n = 0
    for path in images:
        with Image.open(path) as opened:
            pil = to_rgb(opened)
        for variant in PARITY_VARIANTS:
            tensor = np.ascontiguousarray(prep(crop_normalize(pil, variant)), dtype=np.float32)
            ort = _run(session, tensor)
            with torch.inference_mode():
                pt = model(torch.from_numpy(tensor)).detach().numpy()[0].astype(np.float32)
            if pt.shape != ort.shape:
                raise ValueError(f"logit shape {pt.shape} vs {ort.shape}")
            abs_chunks.append(np.abs(pt - ort))
            prob_max = max(prob_max, float(np.max(np.abs(softmax(pt) - softmax(ort)))))
            matches += int(int(np.argmax(pt)) == int(np.argmax(ort)))
            n += 1
    flat = np.concatenate([chunk.ravel() for chunk in abs_chunks])
    return ParityReport(
        n=n,
        max_abs=float(flat.max()),
        mean_abs=float(flat.mean()),
        max_prob_abs=prob_max,
        top1_agree=matches / n,
    )


def _format(report: ParityReport) -> str:
    return (
        f"n={report.n} max_abs_logit={report.max_abs:.8g} mean_abs_logit={report.mean_abs:.8g} "
        f"max_abs_prob={report.max_prob_abs:.8g} top1_agree={report.top1_agree:.3f}"
    )


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    limit = 4
    images = MODEL.parents[1] / "data" / "realset3" / "images"
    onnx_path = MODEL
    out: Path | None = None
    index = 0
    while index < len(argv):
        flag = argv[index]
        if flag == "--limit" and index + 1 < len(argv):
            limit = int(argv[index + 1])
            index += 2
            continue
        if flag == "--images" and index + 1 < len(argv):
            images = Path(argv[index + 1])
            index += 2
            continue
        if flag == "--model" and index + 1 < len(argv):
            onnx_path = Path(argv[index + 1])
            index += 2
            continue
        if flag == "--out" and index + 1 < len(argv):
            out = Path(argv[index + 1])
            index += 2
            continue
        print(f"unknown arg {flag}", file=sys.stderr)
        return 2
    picked = openable_images(images, limit)
    if not picked:
        print(f"no decodable images in {images}", file=sys.stderr)
        return 2
    report = compare(onnx_path, picked)
    print(_format(report))
    if out is not None:
        import json

        dest = assert_under_out(out)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(
            json.dumps(
                {
                    "n": report.n,
                    "max_abs_logit": report.max_abs,
                    "mean_abs_logit": report.mean_abs,
                    "max_abs_prob": report.max_prob_abs,
                    "top1_agree": report.top1_agree,
                }
            )
            + "\n"
        )
    if report.top1_agree < PARITY_TOP1 or report.max_abs > PARITY_MAX_ABS or report.max_prob_abs > PARITY_PROB_ATOL:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
