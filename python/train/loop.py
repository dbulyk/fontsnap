from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from train.model import BASE_CLASSES, EXPANDED_CLASSES, expand_classifier
from train.paths import ROOT, assert_under_out


@dataclass(frozen=True, slots=True)
class TrainConfig:
    recipe: str
    steps: int
    batch_size: int
    lr: float
    weight_decay: float
    amp: bool
    num_classes: int
    device: str
    checkpoint_dir: Path
    distill_weight: float
    distill_dir: str


def _checkpoint_dir() -> Path:
    from train import paths

    return paths.OUT / "train"


def recipe(name: str) -> TrainConfig:
    common = dict(
        steps=1,
        batch_size=1,
        lr=1e-4,
        weight_decay=0.0,
        device="cpu",
        checkpoint_dir=_checkpoint_dir(),
        distill_weight=0.0,
        distill_dir="",
    )
    if name == "smoke":
        return TrainConfig(recipe="smoke", amp=False, num_classes=BASE_CLASSES, **common)
    if name == "ofl-v1":
        return TrainConfig(recipe="ofl-v1", amp=True, num_classes=EXPANDED_CLASSES, **common)
    raise ValueError(f"unknown recipe {name}")


def assert_distill_source(distill_dir: str) -> None:
    if distill_dir.strip() == "":
        raise ValueError("distill directory is empty")
    path = Path(distill_dir).expanduser().resolve()
    banned = (ROOT / "data" / "realset3").resolve()
    if path == banned or banned in path.parents:
        raise ValueError("refusing to distill data/realset3")
    if not path.is_dir() or not any(path.iterdir()):
        raise ValueError("distill directory is empty")


def checkpoint_path(cfg: TrainConfig) -> Path:
    directory = assert_under_out(cfg.checkpoint_dir)
    name = "smoke.pt" if cfg.recipe == "smoke" else f"ckpt-{cfg.steps}.pt"
    return directory / name


def train(cfg: TrainConfig) -> Path:
    if cfg.device != "cpu" and os.environ.get("FONTSNAP_ALLOW_GPU") != "1":
        raise SystemExit(2)
    if cfg.num_classes not in (BASE_CLASSES, EXPANDED_CLASSES):
        raise ValueError(f"num_classes must be {BASE_CLASSES} or {EXPANDED_CLASSES}")
    if cfg.distill_weight > 0:
        assert_distill_source(cfg.distill_dir)
    dest = checkpoint_path(cfg)
    import torch

    from fontsnap_ref.pipeline import MODEL
    from train.port import load_efficientnet_b3_from_onnx

    model = load_efficientnet_b3_from_onnx(MODEL, num_classes=BASE_CLASSES)
    if cfg.num_classes == EXPANDED_CLASSES:
        model = expand_classifier(model, BASE_CLASSES, EXPANDED_CLASSES)
    elif cfg.num_classes != BASE_CLASSES:
        raise ValueError(cfg.num_classes)
    device = torch.device(cfg.device)
    model.train()
    model.module.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
    use_amp = cfg.amp and cfg.device == "cuda"
    scaler = torch.amp.GradScaler(device="cuda", enabled=True) if use_amp else None
    torch.manual_seed(0)
    completed = 0
    for _ in range(cfg.steps):
        completed += 1
        opt.zero_grad(set_to_none=True)
        inputs = torch.randn(cfg.batch_size, 3, 320, 320, device=device)
        labels = torch.zeros(cfg.batch_size, dtype=torch.long, device=device)
        if use_amp:
            with torch.autocast(device_type="cuda", enabled=True):
                loss = torch.nn.functional.cross_entropy(model(inputs), labels)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
        else:
            loss = torch.nn.functional.cross_entropy(model(inputs), labels)
            loss.backward()
            opt.step()
    dest.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "format": "fontsnap-train-ckpt-v1",
            "step": completed,
            "num_classes": cfg.num_classes,
            "recipe": cfg.recipe,
            "state_dict": {key: value.detach().cpu() for key, value in model.state_dict().items()},
        },
        dest,
    )
    return dest


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    name = "smoke"
    dry_run = False
    steps: int | None = None
    index = 0
    while index < len(argv):
        flag = argv[index]
        if flag == "--recipe" and index + 1 < len(argv):
            name = argv[index + 1]
            index += 2
            continue
        if flag == "--steps" and index + 1 < len(argv):
            steps = int(argv[index + 1])
            index += 2
            continue
        if flag == "--dry-run":
            dry_run = True
            index += 1
            continue
        print(f"unknown arg {flag}", file=sys.stderr)
        return 2
    try:
        cfg = recipe(name)
    except ValueError as err:
        print(err, file=sys.stderr)
        return 2
    if steps is not None:
        cfg = TrainConfig(
            recipe=cfg.recipe,
            steps=steps,
            batch_size=cfg.batch_size,
            lr=cfg.lr,
            weight_decay=cfg.weight_decay,
            amp=cfg.amp,
            num_classes=cfg.num_classes,
            device=cfg.device,
            checkpoint_dir=cfg.checkpoint_dir,
            distill_weight=cfg.distill_weight,
            distill_dir=cfg.distill_dir,
        )
    path = checkpoint_path(cfg)
    if dry_run:
        print(path)
        return 0
    written = train(cfg)
    print(written)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
