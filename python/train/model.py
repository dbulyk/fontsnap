"""EfficientNet-B3 classifier. Torch and timm load on first construction."""

from __future__ import annotations

BASE_CLASSES = 3665
EXPANDED_CLASSES = 4271


class EfficientNetB3Classifier:
    """timm efficientnet_b3 with our head width. Forward returns logits, no softmax.

    pretrained=False is mandatory. The weights come from the ONNX map, not a timm download.
    """

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
        return self.module.load_state_dict(state, strict=strict)


def expand_classifier(model: EfficientNetB3Classifier, old: int, new: int) -> EfficientNetB3Classifier:
    """Copy the leading 3665 classifier rows into a 4271-way head. New rows are zero."""
    if (old, new) != (BASE_CLASSES, EXPANDED_CLASSES):
        raise ValueError(f"expand_classifier only grows {BASE_CLASSES} to {EXPANDED_CLASSES}, got {old} to {new}")
    if model.num_classes != old:
        raise ValueError(f"model head is {model.num_classes}, expected {old}")
    import torch

    old_linear = model.module.classifier
    new_linear = torch.nn.Linear(old_linear.in_features, new, bias=old_linear.bias is not None)
    with torch.no_grad():
        new_linear.weight.zero_()
        new_linear.weight[:old].copy_(old_linear.weight[:old])
        if new_linear.bias is not None and old_linear.bias is not None:
            new_linear.bias.zero_()
            new_linear.bias[:old].copy_(old_linear.bias[:old])
    model.module.classifier = new_linear
    model.num_classes = new
    return model
