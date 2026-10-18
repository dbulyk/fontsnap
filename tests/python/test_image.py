"""Loading images as RGB (fontsnap_ref.image.to_rgb): alpha is composited, the same way as src/shared/core/image.ts."""

import io
import json
from fractions import Fraction
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


def over(c, a, bg):
    """Independent reference (scalars or arrays): round((c*a + bg*(255-a)) / 255) by quotient and remainder, no ties as 255 is odd."""
    a = np.asarray(a, np.int64)
    q, r = np.divmod(np.asarray(c, np.int64) * a + bg * (255 - a), 255)
    return q + (2 * r > 255)


def test_over_rounds_to_the_nearest_integer():
    # |255 * over - n| <= 127 is |over - n / 255| < 1/2 in integers; a = 0 gives bg, a = 255 gives c.
    axis = np.arange(256, dtype=np.int64)
    bg, a, c = np.meshgrid(np.array([0, 255], np.int64), axis, axis, indexing="ij")
    n = c * a + bg * (255 - a)
    v = over(c, a, bg)
    wrong = np.argwhere((np.abs(255 * v - n) > 127) | ((a == 0) & (v != bg)) | ((a == 255) & (v != c)))
    first = [(int(bg[k]), int(c[k]), int(a[k])) for k in map(tuple, wrong[:10])]
    assert len(wrong) == 0, f"{len(wrong)} mismatches, first 10 (bg, c, a): {first}"
    # A sample (c and a in 0, 17, ..., 255) against exact rational rounding; round() of a Fraction is safe: no ties.
    for b in (0, 255):
        for ai in range(0, 256, 17):
            for ci in range(0, 256, 17):
                assert over(ci, ai, b) == round(Fraction(ci * ai + b * (255 - ai), 255)), (b, ci, ai)


def test_alpha_fixture_agrees_with_the_reference():
    for case in TABLE["cases"]:
        *rgb, a = case["rgba"]
        assert case["rgb"] == [int(over(v, a, TABLE["bg"])) for v in rgb], case


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


def test_to_rgb_composites_every_c_a_pair_like_an_independent_rounding():
    # Row a, column c holds (c, 255 - c, (c + 128) % 256, a): every channel differs from the others, so a channel swap shows.
    a, c = np.meshgrid(np.arange(256, dtype=np.int64), np.arange(256, dtype=np.int64), indexing="ij")
    rgba = np.stack([c, 255 - c, (c + 128) % 256, a], axis=-1)
    expected = over(rgba[..., :3], a[..., None], TABLE["bg"])
    got = np.array(to_rgb(Image.fromarray(rgba.astype(np.uint8), "RGBA")), np.int64)
    assert got.shape == (256, 256, 3)
    wrong = np.argwhere((got != expected).any(axis=-1))
    first = [(int(c[i, j]), int(a[i, j])) for i, j in wrong[:10]]
    assert len(wrong) == 0, f"{len(wrong)} mismatches, first 10 (c, a): {first}"


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
    # transparent black next to opaque white: light content, black backdrop
    assert np.array(to_rgb(png_roundtrip(idx, transparency=0))).tolist() == [[[0] * 3, [255] * 3]]
    # transparent white next to opaque black: dark content, white backdrop
    assert np.array(to_rgb(png_roundtrip(idx, transparency=1))).tolist() == [[[0] * 3, [255] * 3]]
    grays = Image.new("P", (2, 1))
    grays.putpalette([200, 200, 200, 255, 255, 255])
    grays.putpixel((1, 0), 1)
    alpha = png_roundtrip(grays, transparency=bytes([128, 255]))
    assert isinstance(alpha.info["transparency"], bytes)
    assert np.array(to_rgb(alpha)).tolist() == [[[over(200, 128, 0)] * 3, [255] * 3]]


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
