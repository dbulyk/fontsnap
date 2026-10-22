import subprocess
import sys
from pathlib import Path

from fontsnap_ref.pipeline import Families, nz
from train.fetch import main as fetch_main
from train.inventory import face_class_id, match_upstream_path, select_static_fonts
from train.paths import LICENSE_ROOT, OUT, ROOT
from train.registry import (
    COLLLETTTIVO_NOT_FONTS,
    FONTSOURCE_ALIAS,
    FONTSOURCE_DEJAVU,
    FONTSOURCE_NON_OFL,
    FONTSOURCE_UNSUITABLE,
    FUSION_DROP,
    FUSION_KEEP,
    OFL_SPDX,
    PHASE1_BY_SOURCE,
    PHASE1_CLASSES,
    VELVETYNE_NON_OFL,
    VELVETYNE_NOTDEF,
    VELVETYNE_OFF_CATALOG,
    WAITING_ON_SITE,
    ExcludeReason,
    Source,
    check,
    dump_exclusions,
    dump_manifest,
    is_ofl_1_1,
    load_exclusions,
    load_manifest,
    reserved_font_names,
    sha256_hex,
)

PLAN_WAITING = frozenset(
    {
        "bianzhidai",
        "cirruscumulus",
        "combat",
        "degheest",
        "hyper-scrypt",
        "karrik",
        "lithops",
        "outward",
        "ouvrieres",
        "picnic",
        "resistance",
        "steps-mono",
        "terminal-grotesque",
        "tiny",
        "typefesse",
        "velvelyne",
    }
)


def test_phase1_counts_and_round_trip():
    records = load_manifest()
    exclusions = load_exclusions()
    assert len(records) == PHASE1_CLASSES
    for source, (families, classes) in PHASE1_BY_SOURCE.items():
        got = [rec for rec in records if rec.source == source]
        assert len(got) == classes
        assert len({rec.family_id for rec in got}) == families
    assert dump_manifest(records) == (ROOT / "data" / "fonts_manifest_v3.tsv").read_text(encoding="utf-8")
    assert dump_exclusions(exclusions) == (ROOT / "data" / "fonts_exclude_v3.tsv").read_text(encoding="utf-8")
    assert len({rec.class_id for rec in records}) == PHASE1_CLASSES


def test_every_family_has_one_ofl_file():
    records = load_manifest()
    paths = {rec.license.path for rec in records}
    assert len(paths) == sum(families for families, _ in PHASE1_BY_SOURCE.values())
    for rec in records:
        assert rec.license.spdx == OFL_SPDX
        assert len(rec.file_sha256) == 64
        assert rec.download.url.startswith("https://")
        assert rec.download.filename.endswith((".ttf", ".otf"))
        data = (ROOT / rec.license.path).read_bytes()
        assert sha256_hex(data) == rec.license.sha256
        assert is_ofl_1_1(data)
    binaries = [path for path in LICENSE_ROOT.rglob("*") if path.suffix.lower() in {".ttf", ".otf", ".woff", ".woff2"}]
    assert binaries == []


def test_exclude_pins():
    exclusions = load_exclusions()
    records = load_manifest()
    by_reason = {reason: {ex.family_id for ex in exclusions if ex.reason == reason} for reason in ExcludeReason}
    assert by_reason[ExcludeReason.WAITING_ON_SITE] == PLAN_WAITING
    assert WAITING_ON_SITE == PLAN_WAITING
    assert len(PLAN_WAITING) == 16
    assert all(ex.dropped_classes is None for ex in exclusions if ex.reason == ExcludeReason.WAITING_ON_SITE)
    assert by_reason[ExcludeReason.ALIAS] == {"firago", "geist-sans", "noto-mono"}
    assert by_reason[ExcludeReason.ALIAS] == FONTSOURCE_ALIAS
    assert by_reason[ExcludeReason.FUSION_MERGED] == FUSION_DROP
    assert len(FUSION_DROP) == 20
    assert {rec.family_id for rec in records if rec.family_id.startswith("fusion-")} == FUSION_KEEP
    assert by_reason[ExcludeReason.OFF_CATALOG] == {path.lower() for path in VELVETYNE_OFF_CATALOG}
    assert FONTSOURCE_UNSUITABLE <= by_reason[ExcludeReason.UNSUITABLE]
    assert VELVETYNE_NOTDEF.lower() in by_reason[ExcludeReason.UNSUITABLE]
    assert sum(1 for family_id in by_reason[ExcludeReason.UNSUITABLE] if family_id.startswith("dseg")) == 11
    assert sum(1 for family_id in by_reason[ExcludeReason.UNSUITABLE] if family_id.startswith("yakuhan")) == 6
    for family_id in ("bravura", "bravura-text", "unifont", "unifontex"):
        assert family_id in by_reason[ExcludeReason.UNSUITABLE]
        assert family_id not in {rec.family_id for rec in records}
    non_ofl = {ex.family_id for ex in exclusions if ex.reason == ExcludeReason.NON_OFL and ex.source == Source.FONTSOURCE}
    assert non_ofl == FONTSOURCE_NON_OFL | FONTSOURCE_DEJAVU
    assert len(non_ofl) == 8
    fontsource = [ex for ex in exclusions if ex.source == Source.FONTSOURCE]

    def dropped(reason: ExcludeReason) -> int:
        return sum(ex.dropped_classes or 0 for ex in fontsource if ex.reason == reason)

    assert dropped(ExcludeReason.NON_OFL) == 55
    assert dropped(ExcludeReason.ALIAS) == 28
    assert dropped(ExcludeReason.UNSUITABLE) == 97
    assert dropped(ExcludeReason.FUSION_MERGED) == 20
    assert dropped(ExcludeReason.DUPLICATE_SOURCE) == 2
    assert {path.lower() for path in VELVETYNE_NON_OFL} <= by_reason[ExcludeReason.NON_OFL]
    assert COLLLETTTIVO_NOT_FONTS <= by_reason[ExcludeReason.NOT_A_FONT]
    manifest_keys = {(rec.source, rec.family_id) for rec in records}
    assert manifest_keys.isdisjoint({(ex.source, ex.family_id) for ex in exclusions})
    assert any(rec.source == Source.COLLLETTTIVO and rec.family_id == "apfel-grotezk" for rec in records)
    assert any(
        ex.source == Source.FONTSOURCE and ex.family_id == "apfel-grotezk" and ex.reason == ExcludeReason.DUPLICATE_SOURCE
        for ex in exclusions
    )


def test_no_model_family_collisions():
    model = set(Families().fams)
    collapsed: dict[str, set[str]] = {}
    for rec in load_manifest():
        key = nz(rec.family)
        collapsed.setdefault(key, set()).add(rec.family)
        assert key not in model
    assert all(len(names) == 1 for names in collapsed.values())


def test_upstream_match_prefers_the_full_face_over_a_variant():
    argentum = [
        "otf/ArgentumSans-Bold.otf",
        "otf/ArgentumSans-CondensedBold.otf",
        "ttf/ArgentumSans-Bold.ttf",
    ]
    assert match_upstream_path("ArgentumSans-Bold", 700, "normal", argentum, "argentum-sans") == "otf/ArgentumSans-Bold.otf"
    hauora = ["fonts/ttf/Hauora-Bold.ttf", "fonts/otf/Hauora-Bold.otf"]
    assert match_upstream_path("HauoraSans-Bold", 700, "normal", hauora, "hauora-sans") == "fonts/otf/Hauora-Bold.otf"
    commit = ["src/fonts/fontlab/CommitMonoV143-700Italic.otf", "src/fonts/fontlab/CommitMonoV143-400Italic.otf"]
    assert (
        match_upstream_path("CommitMono-BoldItalic", 700, "italic", commit, "commit-mono")
        == "src/fonts/fontlab/CommitMonoV143-700Italic.otf"
    )
    monaspace = [
        "fonts/Static Fonts/Monaspace Argon/MonaspaceArgon-Bold.otf",
        "fonts/Frozen Fonts/Monaspace Argon/MonaspaceArgonFrozen-Bold.ttf",
        "fonts/Static Fonts/Monaspace Argon/MonaspaceArgon-SemiWideBold.otf",
    ]
    assert (
        match_upstream_path("MonaspaceArgon-Bold", 700, "normal", monaspace, "monaspace-argon")
        == "fonts/Static Fonts/Monaspace Argon/MonaspaceArgon-Bold.otf"
    )
    assert match_upstream_path("ChunkFive-ExtraBold", 800, "normal", ["ChunkFive-Regular.otf", "Chunk Five Print.otf"], "chunk-five") == (
        "ChunkFive-Regular.otf"
    )
    bagnard = ["Bagnard.otf", "BagnardSans.otf"]
    assert match_upstream_path("Bagnard-Regular", 400, "normal", bagnard, "bagnard") == "Bagnard.otf"
    assert match_upstream_path("BagnardSans-Regular", 400, "normal", bagnard, "bagnard-sans") == "BagnardSans.otf"
    ia = ["iA Writer Duo/Static/iAWriterDuoS-Bold.ttf", "iA Writer Duo/Variable/iAWriterDuoV.ttf"]
    assert match_upstream_path("iAWriterDuo-Bold", 700, "normal", ia, "ia-writer-duo") == "iA Writer Duo/Static/iAWriterDuoS-Bold.ttf"
    lxgw = [
        "fonts/TTF/LXGWWenKai-Light.ttf",
        "fonts/TTF/LXGWWenKai-Medium.ttf",
        "fonts/TTF/LXGWWenKai-Regular.ttf",
        "fonts/TTF/LXGWWenKaiMono-Regular.ttf",
    ]
    assert match_upstream_path("LXGWWenKai-Bold", 700, "normal", lxgw, "lxgw-wenkai") is None
    assert match_upstream_path("LXGWWenKai-Light", 300, "normal", lxgw, "lxgw-wenkai") == "fonts/TTF/LXGWWenKai-Light.ttf"
    uncut = ["Static/UncutSans-RegularItalic.otf", "Static/UncutSans-BookItalic.otf"]
    assert match_upstream_path("UncutSans-Italic", 400, "italic", uncut, "uncut-sans") == "Static/UncutSans-RegularItalic.otf"
    iosevka = ["Iosevka-Regular.ttf", "Iosevka-Heavy.ttf", "Iosevka-ExtraBold.ttf", "Iosevka-Italic.ttf"]
    assert match_upstream_path("Iosevka-Black", 900, "normal", iosevka, "iosevka") == "Iosevka-Heavy.ttf"
    assert match_upstream_path("Iosevka-ExtraBold", 800, "normal", iosevka, "iosevka") == "Iosevka-ExtraBold.ttf"
    assert match_upstream_path("Iosevka-Black", 900, "normal", iosevka + ["Iosevka-Black.ttf"], "iosevka") == "Iosevka-Black.ttf"
    league = [
        "LeagueMono-2.300/static/TTF/LeagueMono-Regular.ttf",
        "LeagueMono-2.300/static/OTF/LeagueMono-UltraLight.otf",
        "LeagueMono-2.300/static/OTF/LeagueMono-NarrowUltraLight.otf",
    ]
    assert (
        match_upstream_path("LeagueMono-ExtraLight", 200, "normal", league, "league-mono")
        == "LeagueMono-2.300/static/OTF/LeagueMono-UltraLight.otf"
    )
    nebula = ["OTF/NebulaSans-Bold.otf", "OTF/NebulaSans-Book.otf", "TTF/NebulaSans-Book.ttf"]
    assert match_upstream_path("NebulaSans-Regular", 400, "normal", nebula, "nebula-sans") == "OTF/NebulaSans-Book.otf"
    nebula_italic = ["OTF/NebulaSans-BoldItalic.otf", "OTF/NebulaSans-BookItalic.otf"]
    assert match_upstream_path("NebulaSans-Italic", 400, "italic", nebula_italic, "nebula-sans") == "OTF/NebulaSans-BookItalic.otf"
    redaction = ["Redaction-Regular.otf", "Redaction-Italic.otf", "Redaction-Bold.otf"]
    assert match_upstream_path("Redaction-BoldItalic", 700, "italic", redaction, "redaction") is None
    cooper = [
        "CooperHewitt-OTF-public/CooperHewitt-Book.otf",
        "CooperHewitt-OTF-public/CooperHewitt-Heavy.otf",
        "CooperHewitt-OTF-public/CooperHewitt-Bold.otf",
    ]
    assert match_upstream_path("CooperHewitt-Regular", 400, "normal", cooper, "cooper-hewitt") == (
        "CooperHewitt-OTF-public/CooperHewitt-Book.otf"
    )
    assert match_upstream_path("CooperHewitt-ExtraBold", 800, "normal", cooper, "cooper-hewitt") == (
        "CooperHewitt-OTF-public/CooperHewitt-Heavy.otf"
    )


def test_package_member_unquotes_spaces():
    from train.inventory import split_package_url

    _base, member = split_package_url("https://example.com/Peace-Sans.zip#Peace%20Sans.otf")
    assert member == "Peace Sans.otf"


def test_script_subsets_follow_the_family():
    from train.registry import subsets_for

    records = load_manifest()
    lxgw = next(rec for rec in records if rec.family_id == "lxgw-wenkai")
    pretendard = next(rec for rec in records if rec.family_id == "pretendard")
    latin = next(rec for rec in records if rec.family_id == "bagnard")
    genjyuu = next(rec for rec in records if rec.family_id == "genjyuu-gothic")
    peace = next(rec for rec in records if rec.family_id == "peace-sans")
    pixel = next(rec for rec in records if rec.family_id == "fusion-pixel-8px-monospaced-jp")
    assert subsets_for("lxgw-wenkai") == lxgw.subsets
    assert "cjk" in lxgw.subsets and "hangul" in lxgw.subsets
    assert "hangul" in pretendard.subsets
    assert "cjk" in genjyuu.subsets and "cyrillic" in genjyuu.subsets
    assert "cyrillic" in peace.subsets
    assert "cjk" in pixel.subsets and "hangul" in pixel.subsets
    assert latin.subsets == ("latin",)


def test_manifest_pins_full_fonts_with_sha256():
    records = load_manifest()
    assert len(records) == PHASE1_CLASSES
    by_id = {rec.class_id: rec for rec in records}
    for rec in records:
        assert rec.file_sha256 and len(rec.file_sha256) == 64
        assert not ("jsdelivr.net/fontsource" in rec.download.url and "/latin-" in rec.download.url)
        if rec.family_id.startswith("iosevka") and rec.weight == 900:
            member = rec.download.url.rsplit("#", 1)[-1]
            assert "Heavy" in member
            assert "Regular" not in member
        if rec.family_id.startswith("redaction"):
            assert not rec.class_id.endswith("BoldItalic")
    assert "UltraLight.otf" in by_id["LeagueMono-ExtraLight"].download.url
    assert by_id["NebulaSans-Regular"].download.url.endswith("OTF/NebulaSans-Book.otf")
    assert by_id["NebulaSans-Italic"].download.url.endswith("OTF/NebulaSans-BookItalic.otf")
    assert by_id["LXGWWenKai-Regular"].weight == 400
    assert by_id["LXGWWenKai-Regular"].download.url.endswith("LXGWWenKai-Regular.ttf")
    assert "LXGWWenKai-Bold" not in by_id
    cooper = [rec for rec in records if rec.family_id == "cooper-hewitt"]
    assert len(cooper) == 14
    assert all(rec.weight != 200 for rec in cooper)
    assert by_id["CooperHewitt-Regular"].download.url.endswith("CooperHewitt-Book.otf")
    assert by_id["CooperHewitt-Italic"].download.url.endswith("CooperHewitt-BookItalic.otf")
    assert by_id["CooperHewitt-ExtraBold"].download.url.endswith("CooperHewitt-Heavy.otf")
    genjyuu = {rec.class_id: rec.download.url for rec in records if rec.family_id == "genjyuu-gothic"}
    assert len(genjyuu) == 7
    assert genjyuu["GenjyuuGothic-Thin"].endswith("GenJyuuGothic-ExtraLight.ttf")
    assert genjyuu["GenjyuuGothic-ExtraLight"].endswith("GenJyuuGothic-Light.ttf")
    assert genjyuu["GenjyuuGothic-Light"].endswith("GenJyuuGothic-Normal.ttf")
    assert genjyuu["GenjyuuGothic-Black"].endswith("GenJyuuGothic-Heavy.ttf")
    assert all("Monospace" not in url and "-P-" not in url for url in genjyuu.values())
    peace = by_id["PeaceSans-Regular"]
    assert peace.download.url.endswith("#Peace%20Sans.otf")
    assert peace.download.filename.endswith(".otf")


def test_open_sauce_uses_source_ttf_not_cdn():
    sauce = [rec for rec in load_manifest() if rec.family_id.startswith("open-sauce-")]
    assert len(sauce) == 42
    for rec in sauce:
        assert "raw.githubusercontent.com/marcologous/Open-Sauce-Fonts/" in rec.download.url
        assert "/fonts/ttf/" in rec.download.url
        assert "jsdelivr.net" not in rec.download.url
        assert rec.download.filename.endswith(".ttf")


def test_generate_check_command():
    assert check() == []
    proc = subprocess.run(
        [sys.executable, "-m", "train", "generate", "--check"],
        cwd=ROOT / "python",
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout.strip() == "ok"


def test_fetch_dry_run_stays_under_out():
    assert fetch_main(["--dry-run"]) == 0
    assert fetch_main(["--cache", str(Path("/tmp/not-out"))]) == 2
    assert fetch_main(["--dry-run", "--cache", str(OUT / "font-cache")]) == 0


def test_static_face_selector_drops_variable_and_web():
    sprat = [f"fonts/Sprat-{name}.otf" for name in ("Regular", "Bold")] + ["fonts/SpratVF.ttf", "fonts/Sprat-Regular.woff2"]
    assert select_static_fonts(sprat) == ["fonts/Sprat-Bold.otf", "fonts/Sprat-Regular.otf"]
    lineal = [
        "fonts/Static/OTF/Lineal-Regular.otf",
        "fonts/Static/TTF/Lineal-Regular.ttf",
        "fonts/Variable/LinealVF.ttf",
        "fonts/Static/WEB/Lineal-Regular.woff2",
    ]
    assert select_static_fonts(lineal) == ["fonts/Static/OTF/Lineal-Regular.otf"]
    format_1452 = [
        "fonts/otf/Format_1452.otf",
        "documentation/specimen/Document fonts/Format_1452.otf",
        "sources/Original folder/Format_1452.otf",
    ]
    assert select_static_fonts(format_1452) == ["fonts/otf/Format_1452.otf"]
    assert select_static_fonts(["fonts/VG5000-Regular.otf", "fonts/webfonts/VG5000-Regular_web.ttf"]) == ["fonts/VG5000-Regular.otf"]


def test_face_names_and_reserved_names():
    assert face_class_id("Adwaita Mono", 400, "italic") == "AdwaitaMono-Italic"
    assert face_class_id("Adwaita Mono", 700, "italic") == "AdwaitaMono-BoldItalic"
    assert face_class_id("Open Sauce Sans", 400, "normal") == "OpenSauceSans-Regular"
    text = 'Copyright 2022 Someone\nwith Reserved Font Names "Amdal", "ⴰⵎⴷⴰⵍ".\n'
    assert reserved_font_names(text) == ("Amdal", "ⴰⵎⴷⴰⵍ")
    ofl = (
        text
        + "\nPREAMBLE\n"
        + '"Reserved Font Name" refers to any names specified as such after the\n'
        + "copyright statement(s).\n"
        + "No Modified Version of the Font Software may use the Reserved Font Name(s) "
        + "unless explicit written permission is granted by the corresponding Copyright Holder.\n"
    )
    assert reserved_font_names(ofl) == ("Amdal", "ⴰⵎⴷⴰⵍ")
    mess = (
        "Copyright (c) 2019, Tezzo Suzuki (info@tezzosuzuki.com),\n"
        "with Reserved Font Name “Mess”\n\n"
        "This Font Software is licensed under the SIL Open Font License, Version 1.1.\n\n"
        "Preamble\n"
        '"Reserved Font Name" refers to any names specified as such after the copyright statement(s).\n'
    )
    assert reserved_font_names(mess) == ("Mess",)
    jgs = "Copyright (c) 2022, Adel Faure,\nwith Reserved Font Name jgs5, jgs7, jgs9.\n\nPreamble\n"
    assert reserved_font_names(jgs) == ("jgs5", "jgs7", "jgs9")
    assert not is_ofl_1_1(b"Fonts are (c) Bitstream. Permission is hereby granted, free of charge.")
