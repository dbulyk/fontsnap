"""Reviewed ONNX-to-timm name map.

propose may walk the graph. The loader in port.py reads the TSV and does not.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

from train.paths import MODEL_DIR

OPS = frozenset({"copy", "transpose_oi", "conv1x1_to_linear"})
COLUMNS = ("onnx_name", "timm_name", "op", "onnx_shape", "timm_shape")
DEFAULT_TSV = Path(__file__).resolve().parent / "tables" / "onnx_timm_b3.tsv"
DEFAULT_ONNX = MODEL_DIR / "model_fp16.onnx"

_BLOCK = re.compile(r"^/blocks/blocks\.(\d+)/blocks\.\1\.(\d+)/(.*)/Conv$")


@dataclass(frozen=True, slots=True)
class NameMapRow:
    onnx_name: str
    timm_name: str
    op: str
    onnx_shape: tuple[int, ...]
    timm_shape: tuple[int, ...]


def _parse_shape(cell: str) -> tuple[int, ...]:
    if cell == "":
        return ()
    parts = tuple(int(piece) for piece in cell.split(","))
    if any(n < 0 for n in parts):
        raise ValueError(f"negative shape in {cell}")
    return parts


def _shape_cell(shape: tuple[int, ...]) -> str:
    return ",".join(str(n) for n in shape)


def load_name_map(path: Path) -> tuple[NameMapRow, ...]:
    """Parse the reviewed TSV. Duplicate names and unknown ops raise."""
    import csv

    rows: list[NameMapRow] = []
    seen_onnx: set[str] = set()
    seen_timm: set[str] = set()
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        if tuple(reader.fieldnames or ()) != COLUMNS:
            raise ValueError(f"name map columns must be {COLUMNS}, got {reader.fieldnames}")
        for raw in reader:
            if raw["onnx_name"].startswith("#"):
                continue
            op = raw["op"]
            if op not in OPS:
                raise ValueError(f"unknown op {op} for {raw['onnx_name']}")
            row = NameMapRow(
                onnx_name=raw["onnx_name"],
                timm_name=raw["timm_name"],
                op=op,
                onnx_shape=_parse_shape(raw["onnx_shape"]),
                timm_shape=_parse_shape(raw["timm_shape"]),
            )
            if row.onnx_name in seen_onnx or row.timm_name in seen_timm:
                raise ValueError(f"duplicate name-map name {row.onnx_name} -> {row.timm_name}")
            seen_onnx.add(row.onnx_name)
            seen_timm.add(row.timm_name)
            rows.append(row)
    if not rows:
        raise ValueError(f"empty name map {path}")
    return tuple(rows)


def op_for_shapes(onnx_shape: tuple[int, ...], timm_shape: tuple[int, ...]) -> str | None:
    """propose-only. The loader trusts the TSV op and does not call this."""
    if onnx_shape == timm_shape:
        return "copy"
    if len(onnx_shape) == 4 and onnx_shape[-2:] == (1, 1) and timm_shape == onnx_shape[:2]:
        return "conv1x1_to_linear"
    swapped = len(timm_shape) == 2 and onnx_shape == (timm_shape[1], timm_shape[0])
    if len(onnx_shape) == 2 and swapped and onnx_shape != timm_shape:
        return "transpose_oi"
    return None


def _conv_prefix(node_name: str) -> str:
    if node_name == "/conv_stem/Conv":
        return "conv_stem"
    if node_name == "/conv_head/Conv":
        return "conv_head"
    match = _BLOCK.fullmatch(node_name)
    if match is None:
        raise ValueError(node_name)
    rest = match.group(3).replace("/", ".")
    return f"blocks.{match.group(1)}.{match.group(2)}.{rest}"


def _bn_bias_name(root, conv_prefix: str) -> str:
    """The shipped graph folds BatchNorm into the conv, and timm's conv has no bias.

    The bias initializer belongs on the BatchNorm that still follows that conv.
    """
    import torch

    parent_name, leaf = conv_prefix.rsplit(".", 1) if "." in conv_prefix else ("", conv_prefix)
    parent = root.get_submodule(parent_name) if parent_name else root
    children = list(parent.named_children())
    start = next(i for i, (name, _) in enumerate(children) if name == leaf)
    for name, mod in children[start + 1 :]:
        if isinstance(mod, torch.nn.modules.batchnorm._BatchNorm):
            return f"{parent_name}.{name}.bias" if parent_name else f"{name}.bias"
    raise ValueError(f"no batch-norm follows {conv_prefix}")


def propose_name_map(onnx_path: Path) -> str:
    """Print a TSV for stdout. Does not write a path. UNMAPPED lines make main exit 2."""
    import onnx

    from train.model import BASE_CLASSES, EfficientNetB3Classifier

    graph = onnx.load(str(onnx_path)).graph
    net = EfficientNetB3Classifier(BASE_CLASSES).module
    state = net.state_dict()
    consumers: dict[str, list[tuple[object, int]]] = {}
    for node in graph.node:
        for index, name in enumerate(node.input):
            consumers.setdefault(name, []).append((node, index))

    rows: list[NameMapRow] = []
    unmapped: list[str] = []
    claimed: set[str] = set()
    for init in graph.initializer:
        shape = tuple(init.dims)
        if init.name in state:
            timm_name = init.name
            timm_shape = tuple(state[timm_name].shape)
            op = op_for_shapes(shape, timm_shape)
            if op is None:
                unmapped.append(f"# UNMAPPED\t{init.name}\tshape {shape} vs {timm_shape}")
                continue
        else:
            uses = consumers.get(init.name, [])
            if len(uses) != 1 or uses[0][0].op_type != "Conv":
                unmapped.append(f"# UNMAPPED\t{init.name}\tno single Conv consumer")
                continue
            node, index = uses[0]
            try:
                prefix = _conv_prefix(node.name)
            except ValueError:
                unmapped.append(f"# UNMAPPED\t{init.name}\tnode {node.name}")
                continue
            conv = net.get_submodule(prefix)
            if index == 1:
                timm_name = prefix + ".weight"
            elif index == 2 and conv.bias is not None:
                timm_name = prefix + ".bias"
            elif index == 2:
                try:
                    timm_name = _bn_bias_name(net, prefix)
                except ValueError as err:
                    unmapped.append(f"# UNMAPPED\t{init.name}\t{err}")
                    continue
            else:
                unmapped.append(f"# UNMAPPED\t{init.name}\tinput {index}")
                continue
            if timm_name not in state:
                unmapped.append(f"# UNMAPPED\t{init.name}\tmissing {timm_name}")
                continue
            timm_shape = tuple(state[timm_name].shape)
            op = op_for_shapes(shape, timm_shape)
            if op is None:
                unmapped.append(f"# UNMAPPED\t{init.name}\tshape {shape} vs {timm_shape} for {timm_name}")
                continue
        if timm_name in claimed:
            unmapped.append(f"# UNMAPPED\t{init.name}\tduplicate {timm_name}")
            continue
        claimed.add(timm_name)
        rows.append(NameMapRow(init.name, timm_name, op, shape, timm_shape))

    rows.sort(key=lambda row: row.timm_name)
    lines = ["\t".join(COLUMNS)]
    lines.extend(
        "\t".join((row.onnx_name, row.timm_name, row.op, _shape_cell(row.onnx_shape), _shape_cell(row.timm_shape))) for row in rows
    )
    lines.extend(unmapped)
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "propose":
        argv = argv[1:]
    onnx_path = DEFAULT_ONNX
    index = 0
    while index < len(argv):
        if argv[index] == "--model" and index + 1 < len(argv):
            onnx_path = Path(argv[index + 1])
            index += 2
            continue
        print(f"unknown arg {argv[index]}", file=sys.stderr)
        return 2
    text = propose_name_map(onnx_path)
    sys.stdout.write(text)
    if any(line.startswith("# UNMAPPED\t") for line in text.splitlines()):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
