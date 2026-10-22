from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from train.model import BASE_CLASSES, expand_classifier, expanded_classes
from train.paths import ROOT, assert_under_out
from train.recipe_defs import (
    CALIBRATE_STEPS,
    CALIBRATE_WARMUP_STEPS,
    OFL_V1_AMP,
    OFL_V1_BATCH_SIZE,
    OFL_V1_CHECKPOINT_EVERY,
    OFL_V1_FREEZE_BACKBONE,
    OFL_V1_LR,
    OFL_V1_NUM_WORKERS,
    OFL_V1_PER_CLASS_NEW,
    OFL_V1_PER_CLASS_REPLAY,
    OFL_V1_WEIGHT_DECAY,
    ofl_v1_budget,
    ofl_v1_steps,
)


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
    use_synth: bool
    per_class_new: int
    per_class_replay: int
    num_workers: int
    total_samples: int
    checkpoint_every: int
    freeze_backbone: bool


def _checkpoint_dir() -> Path:
    from train import paths

    return paths.OUT / "train"


def recipe(name: str) -> TrainConfig:
    budget = ofl_v1_budget()
    ofl_common = dict(
        batch_size=OFL_V1_BATCH_SIZE,
        lr=OFL_V1_LR,
        weight_decay=OFL_V1_WEIGHT_DECAY,
        amp=OFL_V1_AMP,
        num_classes=expanded_classes(),
        device="cuda",
        checkpoint_dir=_checkpoint_dir(),
        distill_weight=0.0,
        distill_dir="",
        use_synth=True,
        per_class_new=OFL_V1_PER_CLASS_NEW,
        per_class_replay=OFL_V1_PER_CLASS_REPLAY,
        num_workers=OFL_V1_NUM_WORKERS,
        total_samples=budget.total_samples,
        checkpoint_every=OFL_V1_CHECKPOINT_EVERY,
        freeze_backbone=OFL_V1_FREEZE_BACKBONE,
    )
    if name == "smoke":
        return TrainConfig(
            recipe="smoke",
            steps=1,
            batch_size=1,
            lr=1e-4,
            weight_decay=0.0,
            amp=False,
            num_classes=BASE_CLASSES,
            device="cpu",
            checkpoint_dir=_checkpoint_dir(),
            distill_weight=0.0,
            distill_dir="",
            use_synth=False,
            per_class_new=0,
            per_class_replay=0,
            num_workers=0,
            total_samples=1,
            checkpoint_every=0,
            freeze_backbone=False,
        )
    if name == "calibrate":
        return TrainConfig(
            recipe="calibrate",
            steps=CALIBRATE_STEPS,
            **ofl_common,
        )
    if name == "ofl-v1":
        return TrainConfig(
            recipe="ofl-v1",
            steps=ofl_v1_steps(OFL_V1_BATCH_SIZE),
            **ofl_common,
        )
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


def checkpoint_path(cfg: TrainConfig, *, step: int | None = None) -> Path:
    directory = assert_under_out(cfg.checkpoint_dir)
    if cfg.recipe == "smoke":
        return directory / "smoke.pt"
    if cfg.recipe == "calibrate":
        return directory / "calibrate.pt"
    mark = cfg.steps if step is None else step
    return directory / f"ckpt-{mark}.pt"


def final_checkpoint_path(cfg: TrainConfig) -> Path:
    directory = assert_under_out(cfg.checkpoint_dir)
    if cfg.recipe == "ofl-v1":
        return directory / "ckpt-final.pt"
    return checkpoint_path(cfg)


def onnx_export_path(cfg: TrainConfig) -> Path:
    return assert_under_out(cfg.checkpoint_dir) / "candidate.onnx"


def _freeze_backbone(model) -> None:
    for name, param in model.module.named_parameters():
        if name.startswith("classifier."):
            param.requires_grad = True
        else:
            param.requires_grad = False


def _zero_old_head_grads(model) -> None:
    weight = model.module.classifier.weight
    bias = model.module.classifier.bias
    if weight.grad is not None:
        weight.grad[:BASE_CLASSES].zero_()
    if bias is not None and bias.grad is not None:
        bias.grad[:BASE_CLASSES].zero_()


def _anchor_old_head(model):
    """Snapshot old classifier rows; AdamW weight decay would still move them with zero grad."""
    weight = model.module.classifier.weight[:BASE_CLASSES].detach().clone()
    bias = model.module.classifier.bias
    bias_anchor = None if bias is None else bias[:BASE_CLASSES].detach().clone()
    return weight, bias_anchor


def _restore_old_head(model, weight_anchor, bias_anchor) -> None:
    import torch

    with torch.no_grad():
        model.module.classifier.weight[:BASE_CLASSES].copy_(weight_anchor)
        if bias_anchor is not None and model.module.classifier.bias is not None:
            model.module.classifier.bias[:BASE_CLASSES].copy_(bias_anchor)


def train(cfg: TrainConfig) -> Path:
    target = expanded_classes()
    if cfg.device != "cpu" and os.environ.get("FONTSNAP_ALLOW_GPU") != "1":
        raise SystemExit(2)
    if cfg.num_classes not in (BASE_CLASSES, target):
        raise ValueError(f"num_classes must be {BASE_CLASSES} or {target}")
    if cfg.distill_weight > 0:
        assert_distill_source(cfg.distill_dir)
    dest = final_checkpoint_path(cfg)
    import torch

    from fontsnap_ref.pipeline import MODEL
    from train.port import load_efficientnet_b3_from_onnx

    model = load_efficientnet_b3_from_onnx(MODEL, num_classes=BASE_CLASSES)
    if cfg.num_classes == target:
        model = expand_classifier(model, BASE_CLASSES, target)
    elif cfg.num_classes != BASE_CLASSES:
        raise ValueError(cfg.num_classes)
    device = torch.device(cfg.device)
    if cfg.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("cuda requested but not available")
    model.train()
    model.module.to(device)
    preserve_old = cfg.freeze_backbone and cfg.num_classes == target
    if preserve_old:
        _freeze_backbone(model)
    params = [p for p in model.parameters() if p.requires_grad]
    if not params:
        raise RuntimeError("no trainable parameters")
    opt = torch.optim.AdamW(params, lr=cfg.lr, weight_decay=cfg.weight_decay)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(cfg.steps, 1))
    use_amp = cfg.amp and cfg.device == "cuda"
    scaler = torch.amp.GradScaler(device="cuda", enabled=True) if use_amp else None
    torch.manual_seed(0)
    old_w = old_b = None
    if preserve_old:
        old_w, old_b = _anchor_old_head(model)

    # Build loader (font fetch + workers) before the calibrate timer; warm-up
    # batches are excluded from samples/sec so cold fetch cannot tank the rate.
    extra = CALIBRATE_WARMUP_STEPS if cfg.recipe == "calibrate" else 0
    stream = _batches(cfg, device, limit=cfg.steps + extra)
    for _ in range(extra):
        try:
            warm_x, warm_y = next(stream)
        except StopIteration as exc:
            raise RuntimeError("loader produced no warm-up batches") from exc
        with torch.no_grad():
            if use_amp:
                with torch.autocast(device_type="cuda", enabled=True):
                    _ = torch.nn.functional.cross_entropy(model(warm_x), warm_y)
            else:
                _ = torch.nn.functional.cross_entropy(model(warm_x), warm_y)
    if device.type == "cuda":
        torch.cuda.synchronize()

    completed = 0
    samples = 0
    started = time.perf_counter()
    for inputs, labels in stream:
        completed += 1
        samples += int(labels.shape[0])
        opt.zero_grad(set_to_none=True)
        if use_amp:
            with torch.autocast(device_type="cuda", enabled=True):
                loss = torch.nn.functional.cross_entropy(model(inputs), labels)
            scaler.scale(loss).backward()
            if preserve_old:
                _zero_old_head_grads(model)
            scaler.step(opt)
            scaler.update()
        else:
            loss = torch.nn.functional.cross_entropy(model(inputs), labels)
            loss.backward()
            if preserve_old:
                _zero_old_head_grads(model)
            opt.step()
        if preserve_old:
            _restore_old_head(model, old_w, old_b)
        scheduler.step()
        if cfg.checkpoint_every and completed % cfg.checkpoint_every == 0 and cfg.recipe == "ofl-v1":
            _save(cfg, model, completed, checkpoint_path(cfg, step=completed))
        if completed >= cfg.steps:
            break
    if completed < cfg.steps:
        raise RuntimeError(f"loader produced {completed} batches, need {cfg.steps}")
    if device.type == "cuda":
        torch.cuda.synchronize()
    elapsed = max(time.perf_counter() - started, 1e-9)
    if cfg.recipe == "calibrate":
        print(f"samples/sec {samples / elapsed:.6f}", flush=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    _save(cfg, model, completed, dest)
    if cfg.recipe == "ofl-v1":
        try:
            from train.export import export_onnx_fp16
            from train.model import EfficientNetB3Classifier

            # Export must run on CPU weights; a CUDA module + CPU dummy crashes.
            cpu_model = EfficientNetB3Classifier(cfg.num_classes)
            cpu_model.load_state_dict(model.state_dict())
            export_onnx_fp16(cpu_model, onnx_export_path(cfg), num_classes=cfg.num_classes)
        except (RuntimeError, ValueError, OSError) as err:
            print(f"fontsnap: onnx export failed: {err}", file=sys.stderr, flush=True)
    return dest


def _save(cfg: TrainConfig, model, completed: int, dest: Path) -> None:
    import torch

    dest.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "format": "fontsnap-train-ckpt-v1",
            "step": completed,
            "num_classes": cfg.num_classes,
            "recipe": cfg.recipe,
            "total_samples": cfg.total_samples,
            "state_dict": {key: value.detach().cpu() for key, value in model.state_dict().items()},
        },
        dest,
    )


def _batches(cfg: TrainConfig, device, *, limit: int):
    import torch

    if not cfg.use_synth:
        for _ in range(limit):
            yield (
                torch.randn(cfg.batch_size, 3, 320, 320, device=device),
                torch.zeros(cfg.batch_size, dtype=torch.long, device=device),
            )
        return
    from train.dataset import make_ofl_loader

    fetch = os.environ.get("FONTSNAP_SKIP_FETCH") != "1"
    workers = 0 if cfg.device == "cpu" else cfg.num_workers
    loader = make_ofl_loader(
        batch_size=cfg.batch_size,
        per_class_new=cfg.per_class_new,
        per_class_replay=cfg.per_class_replay,
        num_workers=workers,
        shuffle=True,
        fetch_fonts=fetch,
    )
    produced = 0
    while produced < limit:
        for inputs, labels in loader:
            yield inputs.to(device), labels.to(device)
            produced += 1
            if produced >= limit:
                return


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    name = "smoke"
    dry_run = False
    steps: int | None = None
    device: str | None = None
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
        if flag == "--device" and index + 1 < len(argv):
            device = argv[index + 1]
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
    if steps is not None or device is not None:
        cfg = TrainConfig(
            recipe=cfg.recipe,
            steps=cfg.steps if steps is None else steps,
            batch_size=cfg.batch_size,
            lr=cfg.lr,
            weight_decay=cfg.weight_decay,
            amp=cfg.amp,
            num_classes=cfg.num_classes,
            device=cfg.device if device is None else device,
            checkpoint_dir=cfg.checkpoint_dir,
            distill_weight=cfg.distill_weight,
            distill_dir=cfg.distill_dir,
            use_synth=cfg.use_synth,
            per_class_new=cfg.per_class_new,
            per_class_replay=cfg.per_class_replay,
            num_workers=cfg.num_workers,
            total_samples=cfg.total_samples,
            checkpoint_every=cfg.checkpoint_every,
            freeze_backbone=cfg.freeze_backbone,
        )
    path = final_checkpoint_path(cfg)
    if dry_run:
        print(path)
        return 0
    written = train(cfg)
    print(written)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
