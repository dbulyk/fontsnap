from __future__ import annotations

BASE_CLASSES = 3665
# Below the lowest old-head maxima seen on realset3 slices (some images peak near -42).
# Zero weight + this bias keeps new rows out of argmax at step 0.
NEW_HEAD_BIAS = -80.0


def expanded_classes() -> int:
    """Shipped head size plus every OFL phase-1 class in the manifest."""
    from train.registry import PHASE1_CLASSES

    return BASE_CLASSES + PHASE1_CLASSES


def __getattr__(name: str) -> int:
    if name == "EXPANDED_CLASSES":
        return expanded_classes()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


class EfficientNetB3Classifier:
    def __init__(self, num_classes: int = BASE_CLASSES) -> None:
        import timm

        self.num_classes = num_classes
        self.module = timm.create_model("efficientnet_b3", pretrained=False, num_classes=num_classes)

    def forward(self, x):
        return self.module(x)

    def __call__(self, x):
        return self.forward(x)

    def train(self, mode: bool = True):
        self.module.train(mode)
        return self

    def eval(self):
        return self.train(False)

    def parameters(self):
        return self.module.parameters()

    def state_dict(self):
        return self.module.state_dict()

    def load_state_dict(self, state, strict: bool = True):
        if not any(key.endswith("running_mean") for key in state):
            _prepare_folded_modules(self.module)
        return self.module.load_state_dict(state, strict=strict)

    def absorb_folded_batchnorm(self) -> None:
        import torch

        pairs = _conv_norm_pairs(self.module)
        with torch.no_grad():
            for parent, name, conv, norm in pairs:
                _fold_conv_batchnorm(conv, norm)
                _swap_norm_for_activation(parent, name, norm)


def expand_classifier(model: EfficientNetB3Classifier, old: int, new: int) -> EfficientNetB3Classifier:
    target = expanded_classes()
    if old != BASE_CLASSES or new != target:
        raise ValueError(f"expand_classifier only grows {BASE_CLASSES} to {target}, got {old} to {new}")
    if model.num_classes != old:
        raise ValueError(f"model head is {model.num_classes}, expected {old}")
    import torch

    # New rows must not dominate argmax: old logits are typically ~-28 on realset3.
    # Zero weight + zero bias would score 0 and win ~99% of images before any step.
    old_linear = model.module.classifier
    new_linear = torch.nn.Linear(old_linear.in_features, new, bias=old_linear.bias is not None)
    with torch.no_grad():
        new_linear.weight.zero_()
        new_linear.weight[:old].copy_(old_linear.weight[:old])
        if new_linear.bias is not None and old_linear.bias is not None:
            new_linear.bias.fill_(NEW_HEAD_BIAS)
            new_linear.bias[:old].copy_(old_linear.bias[:old])
    model.module.classifier = new_linear
    model.num_classes = new
    return model


def _conv_norm_pairs(module):
    from torch import nn

    pairs = []
    for parent in module.modules():
        children = list(parent.named_children())
        for index, (name, child) in enumerate(children):
            if not isinstance(child, nn.modules.batchnorm._BatchNorm):
                continue
            if index == 0 or not isinstance(children[index - 1][1], nn.Conv2d):
                raise ValueError(f"{name} does not follow a conv")
            conv = children[index - 1][1]
            if conv.out_channels != child.num_features:
                raise ValueError(f"{name} has {child.num_features} features and the conv has {conv.out_channels}")
            pairs.append((parent, name, conv, child))
    return pairs


def _swap_norm_for_activation(parent, name, norm) -> None:
    from torch import nn

    drop = getattr(norm, "drop", None)
    if drop is not None and not isinstance(drop, nn.Identity):
        raise ValueError(f"{name} applies {type(drop).__name__} inside the norm")
    act = getattr(norm, "act", None)
    setattr(parent, name, act if act is not None else nn.Identity())


def _fold_conv_batchnorm(conv, norm) -> None:
    import torch
    from torch import nn

    gamma = norm.weight
    beta = norm.bias
    mean = norm.running_mean
    var = norm.running_var
    if gamma is None or beta is None or mean is None or var is None:
        raise ValueError("batch-norm is missing affine weights or running stats")
    scale = gamma / torch.sqrt(var + norm.eps)
    weight = conv.weight
    weight.mul_(scale.reshape((-1,) + (1,) * (weight.ndim - 1)))
    bias = conv.bias if conv.bias is not None else torch.zeros(conv.out_channels, dtype=weight.dtype, device=weight.device)
    fused = (bias - mean) * scale + beta
    if conv.bias is None:
        conv.bias = nn.Parameter(fused.detach().clone())
    else:
        conv.bias.copy_(fused)


def _prepare_folded_modules(module) -> None:
    import torch
    from torch import nn

    for parent, name, conv, norm in _conv_norm_pairs(module):
        if conv.bias is None:
            conv.bias = nn.Parameter(torch.zeros(conv.out_channels, dtype=conv.weight.dtype, device=conv.weight.device))
        _swap_norm_for_activation(parent, name, norm)
