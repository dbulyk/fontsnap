"""Loading a PIL image as RGB the way the extension does (src/shared/core/image.ts `fromRGBA`)."""

from __future__ import annotations

import numpy as np
from PIL import Image

ALPHA_MODES = ("RGBA", "LA", "PA", "RGBa", "La")


def to_rgb(im: Image.Image) -> Image.Image:
    """RGB over white: c' = round((c*a + 255*(255-a)) / 255), done in integers so that JS and Python agree.

    `convert("RGB")` alone drops the alpha channel, which turns every transparent pixel (0, 0, 0, 0) black.
    An image without transparency, and an opaque pixel, keep their bytes.
    """
    if im.mode not in ALPHA_MODES and "transparency" not in im.info:
        return im.convert("RGB")
    rgba = np.asarray(im.convert("RGBA"), np.uint32)
    a = rgba[..., 3:4]
    rgb = (rgba[..., :3] * a + 255 * (255 - a) + 127) // 255
    return Image.fromarray(rgb.astype(np.uint8), "RGB")
