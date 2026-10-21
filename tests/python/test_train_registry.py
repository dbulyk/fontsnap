import subprocess
import sys
from pathlib import Path

from fontsnap_ref.pipeline import Families, nz
from train.fetch import main as fetch_main
from train.inventory import face_class_id, select_static_fonts
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
    assert len(records) == 606
    assert len(records) == PHASE1_CLASSES
    for source, (families, classes) in PHASE1_BY_SOURCE.items():
        got = [rec for rec in records if rec.source == source]
        assert len(got) == classes
        assert len({rec.family_id for rec in got}) == families
    assert dump_manifest(records) == (ROOT / "data" / "fonts_manifest_v3.tsv").read_text(encoding="utf-8")
    assert dump_exclusions(exclusions) == (ROOT / "data" / "fonts_exclude_v3.tsv").read_text(encoding="utf-8")
    assert len({rec.class_id for rec in records}) == 606


def test_every_family_has_one_ofl_file():
    records = load_manifest()
    paths = {rec.license.path for rec in records}
    assert len(paths) == 66 + 16 + 24
    for rec in records:
        assert rec.license.spdx == OFL_SPDX
        assert rec.file_sha256 == ""
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
