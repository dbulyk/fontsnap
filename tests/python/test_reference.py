import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from fontsnap_ref.evaluate import score
from fontsnap_ref.pipeline import DATA, MODEL, Families, merge_family, nz, prep, softmax, to_rgb
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


def rgba_px(r, g, b, a):
    return Image.new("RGBA", (1, 1), (r, g, b, a))


def test_to_rgb_composites_over_white():
    px = lambda *c: tuple(to_rgb(rgba_px(*c)).getpixel((0, 0)))  # noqa: E731
    assert px(0, 0, 0, 0) == (255, 255, 255)
    assert px(12, 34, 56, 0) == (255, 255, 255)
    assert px(0, 0, 0, 255) == (0, 0, 0)
    assert px(10, 20, 30, 255) == (10, 20, 30)
    assert px(0, 0, 0, 128) == (127, 127, 127)
    assert px(255, 0, 0, 64) == (255, 191, 191)


def test_to_rgb_matches_the_rounded_formula_for_every_colour_and_alpha():
    a, c = np.meshgrid(np.arange(256), np.arange(256), indexing="ij")
    rgba = np.stack([c, c, c, a], -1).astype(np.uint8)
    got = np.array(to_rgb(Image.fromarray(rgba, "RGBA")))[..., 0]
    assert (got == np.floor((c * a + 255 * (255 - a) + 127) / 255)).all()
    assert (got == np.rint((c * a + 255 * (255 - a)) / 255)).all()


def test_to_rgb_leaves_opaque_and_alpha_free_images_alone():
    rng = np.random.default_rng(1)
    rgb = Image.fromarray(rng.integers(0, 256, (8, 9, 3), dtype=np.uint8), "RGB")
    opaque = rgb.convert("RGBA")
    assert np.array_equal(np.array(to_rgb(opaque)), np.array(opaque.convert("RGB")))
    assert np.array_equal(np.array(to_rgb(rgb)), np.array(rgb))
    gray = rgb.convert("L")
    assert np.array_equal(np.array(to_rgb(gray)), np.array(gray.convert("RGB")))


def test_to_rgb_handles_gray_alpha_and_palette_transparency():
    la = Image.new("LA", (1, 1), (0, 0))
    assert tuple(to_rgb(la).getpixel((0, 0))) == (255, 255, 255)
    pal = Image.new("P", (2, 1), 0)
    pal.putpalette([0, 0, 0, 10, 20, 30] + [0] * 750)
    pal.putpixel((1, 0), 1)
    pal.info["transparency"] = 0
    out = np.array(to_rgb(pal))
    assert out[0, 0].tolist() == [255, 255, 255] and out[0, 1].tolist() == [10, 20, 30]


def test_black_text_on_transparent_background_reads_like_the_same_text_on_white():
    on_white = text_image(True)
    mask = on_white.convert("L").point(lambda v: 255 - v)  # ink coverage
    transparent = Image.new("RGBA", on_white.size, (0, 0, 0, 0))
    transparent.putalpha(mask)
    assert len(text_lines(transparent)[1]) == len(text_lines(on_white)[1]) == 2
    assert np.array_equal(prep(transparent), prep(to_rgb(transparent)))
    assert np.abs(np.array(to_rgb(transparent)).astype(int) - np.array(on_white).astype(int)).max() <= 20


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
