import json
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from fontsnap_ref.evaluate import score
from fontsnap_ref.image import to_rgb
from fontsnap_ref.pipeline import DATA, MODEL, Families, merge_family, nz, prep, softmax
from fontsnap_ref.textcrop import crop_normalize, text_lines


def text_image(dark_on_light=True, w=600, h=160):
    bg, fg = ((255, 255, 255), (20, 20, 20)) if dark_on_light else ((20, 30, 60), (240, 240, 240))
    im = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(im)
    try:
        f = ImageFont.truetype("DejaVuSans.ttf", 48)
    except OSError:
        f = ImageFont.load_default(size=48)
    d.text((20, 20), "Hello Fonts", font=f, fill=fg)
    d.text((20, 90), "Quick brown", font=f, fill=fg)
    return im


@pytest.mark.parametrize("dark", [True, False])
def test_text_lines_finds_two_lines_both_polarities(dark):
    norm, lines = text_lines(text_image(dark))
    assert len(lines) == 2
    assert norm.mean() > 200  # normalized to dark text on white


@pytest.mark.parametrize("mode", ["pack", "crop"])
def test_crop_normalize_line_height(mode):
    out = np.array(crop_normalize(text_image(), mode).convert("L"))
    assert out.shape[0] >= 96 and (out < 128).any()


def test_blank_image_fallback():
    out = crop_normalize(Image.new("RGB", (80, 40), "white"))
    assert out.size == (80, 40)


def test_prep_shape_and_padding():
    x = prep(Image.new("RGB", (100, 20), "black"))
    assert x.shape == (1, 3, 320, 320) and x.dtype == np.float32
    assert x[0, 0, 0, 0] == pytest.approx((1 - 0.485) / 0.229, abs=1e-5)
    assert x[0, 0, 160, 160] == pytest.approx(-0.485 / 0.229, abs=1e-5)


def test_softmax():
    p = softmax([1000.0, 1001.0])
    assert p.sum() == pytest.approx(1) and p[1] > p[0]


def test_merge_family():
    assert merge_family("intertight") == "inter"
    assert merge_family("notosanssymbols") == "notosans"
    assert merge_family("notosansjp") == "notosansjp"
    assert merge_family("lato") == "lato"
    assert nz("IBM Plex Sans") == "ibmplexsans"


@pytest.fixture(scope="module")
def fam():
    return Families(DATA)


def test_families_mapping(fam):
    assert len(fam.class_fam) == 3665
    assert len(fam.fams) == 1845
    assert fam.rank.min() >= 1


def test_aggregation_prior_merge(fam):
    p = np.zeros(len(fam.class_fam))
    idx = {f: i for i, f in enumerate(fam.fams)}
    cls = lambda f: int(np.flatnonzero(fam.class_fam == idx[f])[0])  # noqa: E731
    p[cls("intertight")] = 0.6
    p[cls("roboto")] = 0.4
    assert fam.rank_families([p], alpha=0, merge=False)[0] == "intertight"
    assert fam.rank_families([p], alpha=0, merge=True)[0] == "inter"
    # popularity prior favours the far more popular Roboto over Inter Tight
    assert fam.rank_families([p], alpha=0.5, merge=False)[0] == "roboto"


def test_score():
    preds = {"a.png": {"bare": ["lato", "inter"], "best": ["inter", "lato"]}}
    m = score(preds, [("a.png", "Inter Tight")])
    assert m["best"]["top1"] == 100.0 and m["bare"]["top5"] == 0.0


@pytest.mark.skipif(not MODEL.exists() or MODEL.stat().st_size < 1_000_000, reason="model not pulled (git lfs pull)")
def test_model_runs_on_sample():
    from fontsnap_ref.pipeline import Model, predict_variants

    p = predict_variants(Model(), text_image())
    assert set(p) == {"pack", "crop"} and p["pack"].shape == (3665,)
    assert p["pack"].sum() == pytest.approx(1, abs=1e-4)


def test_meta_json_is_generated():
    """model/meta.json must equal build_meta output (data/gf_extra.json included)."""
    import json

    from fontsnap_ref.build_meta import build
    from fontsnap_ref.pipeline import ROOT

    assert json.load(open(ROOT / "model" / "meta.json")) == json.loads(json.dumps(build()))


ALPHA_FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "alpha-composite.json").read_text())
ALPHA_TABLE = ALPHA_FIXTURE["cases"]
# The backdrop the fixture and the grid composite over (white in production).
ALPHA_BG = ALPHA_FIXTURE["bg"]


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
    for case in ALPHA_TABLE:
        *rgb, a = case["rgba"]
        assert case["rgb"] == [int(over(v, a, ALPHA_BG)) for v in rgb], case


def test_to_rgb_composites_over_white_like_js():
    im = Image.fromarray(np.array([c["rgba"] for c in ALPHA_TABLE], np.uint8)[None], "RGBA")
    assert (np.array(to_rgb(im)) == np.array([c["rgb"] for c in ALPHA_TABLE], np.uint8)[None]).all()


def test_to_rgb_composites_every_c_a_pair_like_an_independent_rounding():
    # Row a, column c holds (c, 255 - c, (c + 128) % 256, a): every channel differs from the others, so a channel swap shows.
    a, c = np.meshgrid(np.arange(256, dtype=np.int64), np.arange(256, dtype=np.int64), indexing="ij")
    rgba = np.stack([c, 255 - c, (c + 128) % 256, a], axis=-1)
    expected = over(rgba[..., :3], a[..., None], ALPHA_BG)
    got = np.array(to_rgb(Image.fromarray(rgba.astype(np.uint8), "RGBA")), np.int64)
    assert got.shape == (256, 256, 3)
    wrong = np.argwhere((got != expected).any(axis=-1))
    first = [(int(c[i, j]), int(a[i, j])) for i, j in wrong[:10]]
    assert len(wrong) == 0, f"{len(wrong)} mismatches, first 10 (c, a): {first}"


def test_to_rgb_composites_gray_with_alpha_and_palette_transparency():
    la = Image.fromarray(np.array([[[0, 0], [0, 255], [90, 100]]], np.uint8), "LA")
    assert np.array(to_rgb(la))[0].tolist() == [[255] * 3, [0] * 3, [over(90, 100, 255)] * 3]
    pal = Image.new("P", (1, 1), 0)
    pal.putpalette([0, 0, 0])
    pal.info["transparency"] = 0
    assert np.array(to_rgb(pal)).tolist() == [[[255, 255, 255]]]


def test_to_rgb_leaves_opaque_images_alone():
    im = Image.fromarray(np.random.default_rng(0).integers(0, 256, (8, 8, 3), dtype=np.uint8))
    assert (np.array(to_rgb(im)) == np.array(im)).all()
    rgba = im.convert("RGBA")
    assert (np.array(to_rgb(rgba)) == np.array(im)).all()


def test_transparent_black_text_reads_like_text_on_white():
    on_white = text_image()
    mask = Image.eval(on_white.convert("L"), lambda v: 255 - v)
    clear = Image.new("RGBA", on_white.size, (0, 0, 0, 0))
    clear.putalpha(mask)
    assert (np.array(prep(clear)) == np.array(prep(to_rgb(clear)))).all()
    norm, lines = text_lines(clear)
    assert len(lines) == 2 and norm.mean() > 200
