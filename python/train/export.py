"""fp16-weight ONNX export. Refuses any destination under model/ before torch is imported."""

from __future__ import annotations

import sys
from pathlib import Path

from train.paths import assert_under_out, refuse_product_write


def dest_allowed(path: Path) -> bool:
    """False when path resolves to the shipped model directory."""
    try:
        refuse_product_write(path)
    except ValueError:
        return False
    return True


def _default_dest() -> Path:
    from train import paths

    return paths.OUT / "train" / "candidate.onnx"


def export_onnx_fp16(model, dest: Path, *, num_classes: int) -> None:
    """Write an ONNX file with float32 input/logits named input and logits, and fp16 initializers."""
    if not dest_allowed(dest):
        raise ValueError(f"refusing write to product model/: {dest}")
    resolved = assert_under_out(dest)
    _export_loaded(model, resolved, num_classes)


def _export_loaded(model, dest: Path, num_classes: int) -> None:
    import copy
    import warnings

    import numpy as np
    import onnx
    import torch
    from onnx import numpy_helper

    net = model.module if hasattr(model, "module") else model
    if net.classifier.out_features != num_classes:
        raise ValueError(f"head width {net.classifier.out_features} != {num_classes}")
    export_net = copy.deepcopy(net).half().eval()

    class _FloatIo(torch.nn.Module):
        def __init__(self, inner: torch.nn.Module) -> None:
            super().__init__()
            self.inner = inner

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            return self.inner(x.half()).float()

    wrapped = _FloatIo(export_net).eval()
    dest.parent.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, 3, 320, 320, dtype=torch.float32)
    try:
        # dynamo=False keeps one file with fp16 weights. PyTorch 2.9+ warns that this exporter is legacy.
        with warnings.catch_warnings():
            warnings.filterwarnings("ignore", category=DeprecationWarning)
            torch.onnx.export(
                wrapped,
                (dummy,),
                str(dest),
                input_names=["input"],
                output_names=["logits"],
                opset_version=17,
                dynamo=False,
            )
        graph = onnx.load(str(dest))
        for node in graph.graph.node:
            if node.op_type == "Softmax":
                raise ValueError("export graph contains Softmax")
        if [item.name for item in graph.graph.input] != ["input"]:
            raise ValueError("export input must be named input")
        if [item.name for item in graph.graph.output] != ["logits"]:
            raise ValueError("export output must be named logits")
        if graph.graph.input[0].type.tensor_type.elem_type != 1:
            raise ValueError("export input must stay float32")
        if graph.graph.output[0].type.tensor_type.elem_type != 1:
            raise ValueError("export logits must stay float32")
        for init in graph.graph.initializer:
            array = numpy_helper.to_array(init)
            if np.issubdtype(array.dtype, np.floating) and array.dtype != np.float16:
                raise ValueError(f"initializer {init.name} is {array.dtype}, expected float16")
        onnx.checker.check_model(graph)
    except Exception:
        dest.unlink(missing_ok=True)
        raise


def _parse_dest(argv: list[str]) -> Path:
    if "--dest" in argv:
        return Path(argv[argv.index("--dest") + 1])
    return _default_dest()


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    dest = _parse_dest(argv)
    problem = None if dest_allowed(dest) else f"refusing write to product model/: {dest}"
    if problem is None:
        try:
            assert_under_out(dest)
        except ValueError as err:
            problem = str(err)
    dry_run = "--dry-run" in argv or "--checkpoint" not in argv
    if dry_run:
        print(dest)
        if problem:
            print(problem)
            return 2
        print("refuses any path under model/")
        return 0
    if problem:
        print(problem, file=sys.stderr)
        return 2
    checkpoint = Path(argv[argv.index("--checkpoint") + 1])
    import torch

    from train.model import BASE_CLASSES, EXPANDED_CLASSES, EfficientNetB3Classifier

    blob = torch.load(checkpoint, map_location="cpu", weights_only=False)
    num_classes = int(blob["num_classes"])
    if num_classes not in (BASE_CLASSES, EXPANDED_CLASSES):
        print(f"checkpoint num_classes {num_classes}", file=sys.stderr)
        return 2
    model = EfficientNetB3Classifier(num_classes)
    model.load_state_dict(blob["state_dict"])
    export_onnx_fp16(model, dest, num_classes=num_classes)
    print(dest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
