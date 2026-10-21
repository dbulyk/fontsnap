from __future__ import annotations

import io
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from train.samples import BG_BY_ID, TEXT_BY_ID, SyntheticSampleSpec

_CANVAS = (480, 120)


def render_sample(
    spec: SyntheticSampleSpec,
    font_bytes: bytes | None = None,
    *,
    instance: tuple[tuple[str, float], ...] = (),
) -> Image.Image:
    entry = TEXT_BY_ID[spec.text_id]
    bg = BG_BY_ID[spec.bg_id]
    if entry.split != spec.split or bg.split != spec.split:
        raise ValueError("text or background split does not match the spec")
    if instance and font_bytes is None:
        raise ValueError("variable-font instance requires font bytes")
    rng = random.Random(spec.seed)
    rotate_deg = rng.uniform(-3.0, 3.0)
    origin = (16 + rng.randint(0, 12), 36 + rng.randint(0, 12))
    tracking = rng.randint(0, 2)
    size_px = rng.choice((36, 48, 64))
    jpeg_quality = 75 if rng.randrange(3) == 0 else None
    face = _font(font_bytes, size_px, instance)
    canvas = Image.new("RGB", _CANVAS, bg.rgb)
    _draw_tracked(ImageDraw.Draw(canvas), entry.text, origin, face, _ink(bg.rgb), tracking)
    turned = canvas.rotate(rotate_deg, resample=Image.Resampling.BICUBIC, fillcolor=bg.rgb)
    if jpeg_quality is None:
        return turned
    return _quantize(turned, jpeg_quality)


def _ink(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    if luma < 128:
        return (255, 255, 255)
    return (0, 0, 0)


def _font(font_bytes: bytes | None, size_px: int, instance: tuple[tuple[str, float], ...]) -> ImageFont.ImageFont:
    if font_bytes is None:
        return ImageFont.load_default()
    payload = _instantiate(font_bytes, instance) if instance else font_bytes
    return ImageFont.truetype(io.BytesIO(payload), size=size_px)


def _instantiate(font_bytes: bytes, instance: tuple[tuple[str, float], ...]) -> bytes:
    from fontTools.ttLib import TTFont
    from fontTools.varLib.instancer import instantiateVariableFont

    source = TTFont(io.BytesIO(font_bytes))
    try:
        instanced = instantiateVariableFont(
            source,
            {name: value for name, value in instance},
            inplace=False,
            static=True,
        )
    finally:
        source.close()
    try:
        buf = io.BytesIO()
        instanced.save(buf)
        return buf.getvalue()
    finally:
        instanced.close()


def _draw_tracked(
    draw: ImageDraw.ImageDraw,
    text: str,
    origin: tuple[int, int],
    face: ImageFont.ImageFont,
    fill: tuple[int, int, int],
    tracking: int,
) -> None:
    x, y = origin
    for ch in text:
        draw.text((x, y), ch, font=face, fill=fill)
        bbox = draw.textbbox((x, y), ch, font=face)
        x = bbox[2] + tracking


def _quantize(canvas: Image.Image, quality: int) -> Image.Image:
    step = max(1, (100 - quality) // 5)
    pixels = np.asarray(canvas, dtype=np.uint8)
    snapped = np.ascontiguousarray((pixels // step) * step, dtype=np.uint8)
    return Image.fromarray(snapped, "RGB")
