from __future__ import annotations

from pathlib import Path

import numpy as np

from train.model import BASE_CLASSES, EfficientNetB3Classifier
from train.name_map import DEFAULT_TSV, NameMapRow, load_name_map


def apply_layout(op: str, raw: np.ndarray, timm_shape: tuple[int, ...]) -> np.ndarray:
    if op == "copy":
        out = raw
    elif op == "transpose_oi":
        if raw.ndim != 2:
            raise ValueError(f"transpose_oi needs rank 2, got {raw.shape}")
        out = raw.T
    elif op == "conv1x1_to_linear":
        if raw.ndim != 4 or tuple(raw.shape[-2:]) != (1, 1):
            raise ValueError(f"conv1x1_to_linear needs trailing 1,1, got {raw.shape}")
        out = raw.reshape(raw.shape[0], raw.shape[1])
    else:
        raise ValueError(f"unknown op {op}")
    out = np.ascontiguousarray(out)
    if tuple(out.shape) != timm_shape:
        raise ValueError(f"{op} produced {out.shape}, TSV expects {timm_shape}")
    return out


def _folded_bn_leftover(name: str) -> bool:
    if name.endswith((".running_mean", ".running_var", ".num_batches_tracked")):
        return True
    parts = name.split(".")
    return len(parts) >= 2 and parts[-1] == "weight" and parts[-2].startswith("bn")


def _assert_io(graph) -> None:
    inputs = list(graph.input)
    outputs = list(graph.output)
    if len(inputs) != 1 or inputs[0].name != "input":
        raise ValueError("ONNX input must be named input")
    if len(outputs) != 1 or outputs[0].name != "logits":
        raise ValueError("ONNX output must be named logits")
    in_dims = [dim.dim_value for dim in inputs[0].type.tensor_type.shape.dim]
    out_dims = [dim.dim_value for dim in outputs[0].type.tensor_type.shape.dim]
    if in_dims[-3:] != [3, 320, 320]:
        raise ValueError(f"expected NCHW 3x320x320, got {in_dims}")
    if out_dims[-1] != BASE_CLASSES:
        raise ValueError(f"expected {BASE_CLASSES} logits, got {out_dims}")
    if inputs[0].type.tensor_type.elem_type != 1:
        raise ValueError("ONNX input must be float32")


def load_efficientnet_b3_from_onnx(
    onnx_path: str | Path,
    *,
    num_classes: int = BASE_CLASSES,
    name_map: Path | None = None,
) -> EfficientNetB3Classifier:
    if num_classes != BASE_CLASSES:
        raise ValueError(f"load the {BASE_CLASSES}-way head, then expand_classifier for 4271")
    import onnx
    import torch
    from onnx import numpy_helper

    proto = onnx.load(str(onnx_path))
    _assert_io(proto.graph)
    rows = load_name_map(Path(name_map) if name_map is not None else DEFAULT_TSV)
    blobs = {init.name: numpy_helper.to_array(init) for init in proto.graph.initializer}
    if set(blobs) != {row.onnx_name for row in rows}:
        missing = sorted(set(blobs) - {row.onnx_name for row in rows})
        extra = sorted({row.onnx_name for row in rows} - set(blobs))
        raise ValueError(f"name map does not match initializers, missing {missing[:5]} extra {extra[:5]}")

    model = EfficientNetB3Classifier(num_classes)
    state = model.state_dict()
    written: set[str] = set()
    for row in rows:
        _check_row(row, blobs[row.onnx_name])
        array = apply_layout(row.op, np.asarray(blobs[row.onnx_name], dtype=np.float32), row.timm_shape)
        if row.timm_name not in state:
            raise ValueError(f"timm has no parameter {row.timm_name}")
        state[row.timm_name] = torch.from_numpy(array).to(dtype=state[row.timm_name].dtype).clone()
        written.add(row.timm_name)
    unread = [name for name in state if name not in written]
    unexpected = [name for name in unread if not _folded_bn_leftover(name)]
    if unexpected:
        raise ValueError(f"timm parameters missing from the name map: {unexpected[:8]}")
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


def _check_row(row: NameMapRow, blob: np.ndarray) -> None:
    if tuple(blob.shape) != row.onnx_shape:
        raise ValueError(f"{row.onnx_name} shape {blob.shape} != TSV {row.onnx_shape}")
    if blob.dtype not in (np.float16, np.float32):
        raise ValueError(f"{row.onnx_name} dtype {blob.dtype}")
