"""Loading a PIL image as RGB, the rule of the extension (src/shared/core/image.ts `chooseBackdrop` and `fromRGBA`)."""

from __future__ import annotations

import numpy as np
from PIL import Image

ALPHA_MODES = ("RGBA", "LA", "PA", "RGBa")


def choose_backdrop(rgba: np.ndarray) -> int:
    """Light content goes on black (0), anything else on white (255), so that text stays against its ground.

    "Light" is an alpha-weighted mean of the cv2 RGB2GRAY luminance (the fixed-point sum of `toGray`) above 127.5,
    2*sum(gray*a) > 255*sum(a), in integers; the tie and an image without content go to white.
    """
    px = rgba.reshape(-1, 4).astype(np.int64)
    gray = (px[:, 0] * 4899 + px[:, 1] * 9617 + px[:, 2] * 1868 + 8192) >> 14
    return 0 if 2 * int((gray * px[:, 3]).sum()) > 255 * int(px[:, 3].sum()) else 255


def composite_over(rgba: np.ndarray, bg: int) -> np.ndarray:
    """(H, W, 4) uint8 RGBA → (H, W, 3) uint8 RGB over the backdrop `bg` (0 or 255): c' = round((c*a + bg*(255-a)) / 255).

    Integers only, so that JS (`compositeOver`) and Python agree. A fully opaque image keeps its bytes.
    """
    px = rgba.astype(np.uint32)
    a = px[..., 3:4]
    return ((px[..., :3] * a + bg * (255 - a) + 127) // 255).astype(np.uint8)


def to_rgb(im: Image.Image) -> Image.Image:
    """RGB with the transparency composited over the backdrop `choose_backdrop` picks.

    `convert("RGB")` alone drops the alpha channel, which turns every transparent pixel (0, 0, 0, 0) black. An image
    without transparency, and a fully opaque one, keep their bytes.

    Not the extension's reading: 16-bit gray (`I;16`, which the browser scales to 8 bits and `convert` clips) and
    CMYK or ICC profiles (the browser applies them). Those were never matched, and no alpha is involved.
    """
    if im.mode not in ALPHA_MODES and "transparency" not in im.info:
        return im.convert("RGB")
    rgba = np.asarray(im.convert("RGBA"))
    return Image.fromarray(composite_over(rgba, choose_backdrop(rgba)), "RGB")
