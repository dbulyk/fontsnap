"""Loading images as RGB (fontsnap_ref.image.to_rgb): alpha is composited, the same way as src/shared/core/image.ts."""

import io
import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from test_reference import text_image

from fontsnap_ref.image import choose_backdrop, to_rgb
from fontsnap_ref.textcrop import text_lines

TABLE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "alpha-composite.json").read_text())


def rgba_image(pixels):
    return Image.fromarray(np.array(pixels, np.uint8)[None], "RGBA")


def over(c, a, backdrop):
    """The integer reference, a second way of rounding half up: floor((2x + 255) / 510)."""
    return (2 * (c * a + backdrop * (255 - a)) + 255) // 510


def png_roundtrip(im, **save):
    buf = io.BytesIO()
    im.save(buf, "PNG", **save)
    return Image.open(io.BytesIO(buf.getvalue()))


@pytest.mark.parametrize(("backdrop", "key"), [(255, "cases"), (0, "blackCases")])
def test_pixels_match_the_table_the_js_tests_use(backdrop, key):
    rows = TABLE[key]
    out = np.array(to_rgb(rgba_image([r["rgba"] for r in rows]), backdrop))
    assert out.tolist() == [[r["rgb"] for r in rows]]


@pytest.mark.parametrize("image", TABLE["images"], ids=lambda i: i["name"])
def test_backdrop_by_contrast_matches_the_table_the_js_tests_use(image):
    im = rgba_image(image["rgba"])
    assert choose_backdrop(np.array(im)) == image["backdrop"]
    assert np.array(to_rgb(im)).ravel().tolist() == image["rgb"]


@pytest.mark.parametrize("backdrop", [0, 255])
def test_every_c_a_pair_matches_the_integer_reference(backdrop):
    c, a = np.meshgrid(np.arange(256), np.arange(256))
    rgba = np.stack([c, 255 - c, c ^ 0x55, a], -1).astype(np.uint8)
    out = np.array(to_rgb(Image.fromarray(rgba, "RGBA"), backdrop))
    want = (2 * (rgba[..., :3].astype(np.int64) * a[..., None] + backdrop * (255 - a[..., None])) + 255) // 510
    assert (out == want).all()


@pytest.mark.parametrize("backdrop", [None, 0, 255])
def test_opaque_images_keep_their_bytes(backdrop):
    rgb = np.random.default_rng(0).integers(0, 256, (8, 8, 3), dtype=np.uint8)
    im = Image.fromarray(rgb)
    assert (np.array(to_rgb(im, backdrop)) == rgb).all()
    assert (np.array(to_rgb(im.convert("RGBA"), backdrop)) == rgb).all()


def test_gray_with_alpha():
    la = Image.fromarray(np.array([[[0, 0], [0, 255], [90, 100], [250, 255]]], np.uint8), "LA")
    assert np.array(to_rgb(la))[0].tolist() == [[255] * 3, [0] * 3, [over(90, 100, 255)] * 3, [250] * 3]


def test_palette_with_transparent_index_and_with_alpha_bytes():
    # palette 0 = black, 1 = white; the file says what is transparent, as a real PNG does
    idx = Image.new("P", (2, 1))
    idx.putpalette([0, 0, 0, 255, 255, 255])
    idx.putpixel((1, 0), 1)
    assert np.array(to_rgb(png_roundtrip(idx, transparency=0))).tolist() == [[[255] * 3, [255] * 3]]
    assert np.array(to_rgb(png_roundtrip(idx, transparency=1))).tolist() == [[[0] * 3, [255] * 3]]
    alpha = png_roundtrip(idx, transparency=bytes([128, 255]))
    assert isinstance(alpha.info["transparency"], bytes)
    assert np.array(to_rgb(alpha)).tolist() == [[[over(0, 128, 255)] * 3, [255] * 3]]


def test_gray_and_rgb_with_a_transparent_colour_key():
    gray = png_roundtrip(Image.fromarray(np.array([[0, 90]], np.uint8), "L"), transparency=0)
    assert np.array(to_rgb(gray)).tolist() == [[[255] * 3, [90] * 3]]
    rgb = png_roundtrip(Image.fromarray(np.array([[[0, 0, 0], [10, 20, 30]]], np.uint8), "RGB"), transparency=(0, 0, 0))
    assert np.array(to_rgb(rgb)).tolist() == [[[255] * 3, [10, 20, 30]]]


def test_palette_with_alpha_mode_pa():
    pa = Image.new("PA", (2, 1))
    pa.putpalette([0, 0, 0])
    pa.putdata([(0, 0), (0, 255)])
    assert np.array(to_rgb(pa)).tolist() == [[[255] * 3, [0] * 3]]


def test_premultiplied_rgba():
    pre = Image.fromarray(np.array([[[0, 0, 0, 0], [30, 30, 30, 60]]], np.uint8), "RGBa")
    plain = np.array(pre.convert("RGBA"))
    assert np.array(to_rgb(pre)).tolist() == np.array(to_rgb(Image.fromarray(plain, "RGBA"))).tolist()


def clear_text(ink, coverage):
    """`ink` text with the given coverage mask on a transparent background (what a design tool exports)."""
    clear = Image.new("RGBA", coverage.size, (ink, ink, ink, 0))
    clear.putalpha(coverage)
    return clear


def test_black_text_on_transparent_is_text_on_white():
    on_white = text_image()
    coverage = Image.eval(on_white.convert("L"), lambda v: 255 - v)
    clear = clear_text(0, coverage)
    assert (np.array(to_rgb(clear)) == np.array(on_white)).all()
    norm, lines = text_lines(clear)
    want_norm, want_lines = text_lines(on_white)
    assert lines == want_lines and len(lines) == 2
    assert (norm == want_norm).all()


def test_white_text_on_transparent_is_text_on_black():
    on_black = text_image(dark_on_light=False)
    coverage = on_black.convert("L").point(lambda v: 255 if v > 100 else 0)  # the glyphs, edges included
    on_black = Image.composite(Image.new("RGB", on_black.size, "white"), Image.new("RGB", on_black.size, "black"), coverage)
    clear = clear_text(255, coverage)
    assert (np.array(to_rgb(clear)) == np.array(on_black)).all()
    norm, lines = text_lines(clear)
    want_norm, want_lines = text_lines(on_black)
    assert lines == want_lines and len(lines) == 2
    assert (norm == want_norm).all()
