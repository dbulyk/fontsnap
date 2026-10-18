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


def to_rgb(im: Image.Image, backdrop: int | None = None) -> Image.Image:
    """RGB over a black or white backdrop: c' = round((c*a + bg*(255-a)) / 255), done in integers so that JS and Python agree.

    `convert("RGB")` alone drops the alpha channel, which turns every transparent pixel (0, 0, 0, 0) black. A fully
    opaque image keeps its bytes. `backdrop` (0 or 255) overrides `choose_backdrop`, for tests.

    Not the extension's reading: 16-bit gray (`I;16`, which the browser scales to 8 bits and `convert` clips) and
    CMYK or ICC profiles (the browser applies them). Those were never matched, and no alpha is involved.
    """
    if im.mode not in ALPHA_MODES and "transparency" not in im.info:
        return im.convert("RGB")
    rgba = np.asarray(im.convert("RGBA"))
    if backdrop is None:
        backdrop = choose_backdrop(rgba)
    px = rgba.astype(np.uint32)
    a = px[..., 3:4]
    rgb = (px[..., :3] * a + backdrop * (255 - a) + 127) // 255
    return Image.fromarray(rgb.astype(np.uint8), "RGB")
