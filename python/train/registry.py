from __future__ import annotations

import csv
import hashlib
import io
import re
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from train.paths import EXCLUDE_TSV, LICENSE_ROOT, MANIFEST_TSV, ROOT

HTTP_USER_AGENT = "FontSnapTrain/0.1 (inventory; +https://github.com/dbulyk/fontsnap)"

OFL_SPDX = "OFL-1.1"
PHASE1_CLASSES = 597
_SHA = re.compile(r"[0-9a-f]{64}")
_FAMILY_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_CLASS_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_STYLES = frozenset({"normal", "italic", "oblique"})

MANIFEST_COLUMNS = (
    "class_id",
    "family",
    "family_id",
    "source",
    "category",
    "weight",
    "style",
    "filename",
    "download_url",
    "file_sha256",
    "license_path",
    "license_sha256",
    "license",
    "reserved_font_names",
    "designer",
    "version",
    "source_url",
)

EXCLUDE_COLUMNS = (
    "source",
    "family_id",
    "family",
    "reason",
    "dropped_classes",
    "note",
)


class Source(Enum):
    FONTSOURCE = "fontsource"
    COLLLETTTIVO = "collletttivo"
    VELVETYNE = "velvetyne"


class ExcludeReason(Enum):
    NON_OFL = "non-ofl"
    DUPLICATE_SOURCE = "duplicate-source"
    UNSUITABLE = "unsuitable"
    ALIAS = "alias"
    FUSION_MERGED = "fusion-merged"
    OFF_CATALOG = "off-catalog"
    WAITING_ON_SITE = "waiting-on-site"
    NO_LICENSE = "no-license"
    NOT_A_FONT = "not-a-font"


WAITING_ON_SITE = frozenset(
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

FONTSOURCE_ALIAS = frozenset({"firago", "geist-sans", "noto-mono"})
FONTSOURCE_DUPLICATE = frozenset({"apfel-grotezk"})
FONTSOURCE_NON_OFL = frozenset({"aileron", "clear-sans", "comic-mono", "metropolis"})
FONTSOURCE_DEJAVU = frozenset({"dejavu-math", "dejavu-mono", "dejavu-sans", "dejavu-serif"})
FONTSOURCE_UNSUITABLE = frozenset(
    {
        "bravura",
        "bravura-text",
        "dseg-weather",
        "dseg14-classic",
        "dseg14-classic-mini",
        "dseg14-modern",
        "dseg14-modern-mini",
        "dseg7-classic",
        "dseg7-classic-mini",
        "dseg7-modern",
        "dseg7-modern-mini",
        "dseg7-segg-chan",
        "dseg7-segg-chan-mini",
        "unifont",
        "unifontex",
        "yakuhanjp",
        "yakuhanjps",
        "yakuhanmp",
        "yakuhanmps",
        "yakuhanrp",
        "yakuhanrps",
    }
)

_FUSION_PIXEL = tuple(
    f"fusion-pixel-{px}px-{spacing}-{loc}"
    for px in ("8", "10", "12")
    for spacing in ("monospaced", "proportional")
    for loc in ("jp", "kr", "sc", "tc")
)
FUSION_KEEP = frozenset(i for i in _FUSION_PIXEL if i.endswith("-jp")) | {"fusion-kai-g"}
FUSION_DROP = frozenset(i for i in _FUSION_PIXEL if not i.endswith("-jp")) | {"fusion-kai-j", "fusion-kai-t"}

FONTSOURCE_FACES = {
    "adwaita-mono": 4,
    "adwaita-sans": 18,
    "argentum-sans": 18,
    "bagnard": 1,
    "bagnard-sans": 1,
    "blackout-midnight": 1,
    "blackout-sunrise": 1,
    "blackout-two-am": 1,
    "bluu-next": 2,
    "chunk-five": 1,
    "commit-mono": 12,
    "cooper-hewitt": 14,
    "fusion-kai-g": 1,
    "fusion-pixel-10px-monospaced-jp": 1,
    "fusion-pixel-10px-proportional-jp": 1,
    "fusion-pixel-12px-monospaced-jp": 1,
    "fusion-pixel-12px-proportional-jp": 1,
    "fusion-pixel-8px-monospaced-jp": 1,
    "fusion-pixel-8px-proportional-jp": 1,
    "genjyuu-gothic": 7,
    "hauora-sans": 7,
    "ia-writer-duo": 4,
    "ia-writer-mono": 4,
    "ia-writer-quattro": 4,
    "iosevka": 18,
    "iosevka-aile": 18,
    "iosevka-curly": 18,
    "iosevka-curly-slab": 18,
    "iosevka-etoile": 18,
    "junction": 3,
    "karmilla": 2,
    "league-mono": 8,
    "lextrall": 9,
    "lxgw-wenkai": 3,
    "maple-mono": 16,
    "monaspace-argon": 14,
    "monaspace-krypton": 14,
    "monaspace-neon": 14,
    "monaspace-radon": 14,
    "monaspace-xenon": 14,
    "mononoki": 4,
    "nebula-sans": 12,
    "norwester": 1,
    "open-runde": 4,
    "peace-sans": 1,
    "open-sauce-one": 14,
    "open-sauce-sans": 14,
    "open-sauce-two": 14,
    "opendyslexic": 4,
    "ostrich-sans": 4,
    "pitagon-sans": 6,
    "pitagon-sans-mono": 16,
    "pitagon-sans-text": 14,
    "pitagon-serif": 18,
    "pretendard": 9,
    "redaction": 3,
    "redaction-10": 3,
    "redaction-100": 3,
    "redaction-20": 3,
    "redaction-35": 3,
    "redaction-50": 3,
    "redaction-70": 3,
    "rubik-one": 1,
    "syne-italic": 1,
    "uncut-sans": 10,
    "win95fa": 1,
}

# Variable fonts published as one file per style; weight classes need fvar instances.
VF_WEIGHT_FAMILIES = frozenset({"adwaita-sans"})

# Measured from cmap of the cached full fonts. CJK is U+4E00..U+9FFF. Hangul is U+AC00..U+D7AF.
CJK_FAMILIES = frozenset(
    {
        "fusion-kai-g",
        "fusion-pixel-10px-monospaced-jp",
        "fusion-pixel-10px-proportional-jp",
        "fusion-pixel-12px-monospaced-jp",
        "fusion-pixel-12px-proportional-jp",
        "fusion-pixel-8px-monospaced-jp",
        "fusion-pixel-8px-proportional-jp",
        "genjyuu-gothic",
        "lxgw-wenkai",
    }
)
HANGUL_FAMILIES = frozenset(
    {
        "fusion-pixel-10px-monospaced-jp",
        "fusion-pixel-10px-proportional-jp",
        "fusion-pixel-12px-monospaced-jp",
        "fusion-pixel-12px-proportional-jp",
        "fusion-pixel-8px-monospaced-jp",
        "fusion-pixel-8px-proportional-jp",
        "lxgw-wenkai",
        "pretendard",
    }
)
# Measured from cmap of the cached full fonts (U+0400..U+04FF).
CYRILLIC_FAMILIES = frozenset(
    {
        "adwaita-mono",
        "adwaita-sans",
        "apfel-grotezk",
        "argentum-sans",
        "facade-font",
        "fusion-kai-g",
        "fusion-pixel-10px-proportional-jp",
        "fusion-pixel-12px-monospaced-jp",
        "fusion-pixel-12px-proportional-jp",
        "genjyuu-gothic",
        "grotesk",
        "hauora-sans",
        "ia-writer-duo",
        "ia-writer-mono",
        "ia-writer-quattro",
        "iosevka",
        "iosevka-aile",
        "iosevka-curly",
        "iosevka-curly-slab",
        "iosevka-etoile",
        "lxgw-wenkai",
        "maple-mono",
        "monaspace-argon",
        "monaspace-krypton",
        "monaspace-neon",
        "monaspace-radon",
        "monaspace-xenon",
        "mononoki",
        "mourier",
        "murmure",
        "nebula-sans",
        "open-runde",
        "opendyslexic",
        "ouroboros",
        "peace-sans",
        "pitagon-sans-mono",
        "pretendard",
        "rubik-one",
        "sinistre",
        "sneaky-times",
    }
)


def subsets_for(family_id: str) -> tuple[str, ...]:
    scripts = ["latin"]
    if family_id in CYRILLIC_FAMILIES:
        scripts.append("cyrillic")
    if family_id in CJK_FAMILIES:
        scripts.append("cjk")
    if family_id in HANGUL_FAMILIES:
        scripts.append("hangul")
    return tuple(scripts)


COLLLETTTIVO_FACES = {
    "absans": 1,
    "apfel-grotezk": 5,
    "aujournuit": 5,
    "borges": 1,
    "coconat": 3,
    "halibut": 6,
    "mattone": 3,
    "mazius-display": 4,
    "messapia": 2,
    "necto-mono": 1,
    "ortica": 4,
    "ribes": 3,
    "ronzino": 6,
    "sinistre": 3,
    "sneaky-times": 1,
    "sprat": 18,
}
COLLLETTTIVO_NOT_FONTS = frozenset({"cltoools", "word-o-mat"})

# GitLab project paths as published (case is part of the URL).
VELVETYNE_KEEP = frozenset(
    {
        "amdal",
        "anthony",
        "Avara",
        "backout",
        "basteleur",
        "compagnon",
        "Facade-font",
        "feroniapi",
        "flor-des-ruina",
        "format-1452",
        "grotesk",
        "Gulax",
        "interlope",
        "jgs",
        "kaerukaeru",
        "letters",
        "lineal",
        "Mess",
        "mourier",
        "murmure",
        "ouroboros",
        "sligoil",
        "Trickster",
        "vg5000",
    }
)
VELVETYNE_FACES = {
    "amdal": 1,
    "anthony": 1,
    "avara": 4,
    "backout": 1,
    "basteleur": 2,
    "compagnon": 5,
    "facade-font": 4,
    "feroniapi": 1,
    "flor-des-ruina": 5,
    "format-1452": 1,
    "grotesk": 4,
    "gulax": 1,
    "interlope": 1,
    "jgs": 4,
    "kaerukaeru": 1,
    "letters": 2,
    "lineal": 7,
    "mess": 1,
    "mourier": 1,
    "murmure": 1,
    "ouroboros": 1,
    "sligoil": 3,
    "trickster": 1,
    "vg5000": 1,
}
VELVETYNE_OFF_CATALOG = frozenset({"cantique", "imago-mundi-mei", "Happy-Times-at-the-IKOB", "Sporting-Grotesque"})
VELVETYNE_NON_OFL = frozenset({"fungal", "pilowlava3D"})
VELVETYNE_NO_LICENSE = frozenset({"lack"})
VELVETYNE_NOT_A_FONT = frozenset({"Velvetyne-Standard-Character-Set", "velvetyne-libre-friends"})
VELVETYNE_NOTDEF = "Velvetyne-Notdef"

PHASE1_BY_SOURCE = {
    Source.FONTSOURCE: (len(FONTSOURCE_FACES), sum(FONTSOURCE_FACES.values())),
    Source.COLLLETTTIVO: (len(COLLLETTTIVO_FACES), sum(COLLLETTTIVO_FACES.values())),
    Source.VELVETYNE: (len(VELVETYNE_FACES), sum(VELVETYNE_FACES.values())),
}


def _require_tables() -> None:
    if len(WAITING_ON_SITE) != 16:
        raise RuntimeError("WAITING_ON_SITE must name 16 families")
    if len(FUSION_DROP) != 20 or len(FUSION_KEEP) != 7:
        raise RuntimeError("fusion tables must keep 7 and drop 20")
    if {k for k in FONTSOURCE_FACES if k.startswith("fusion-")} != FUSION_KEEP:
        raise RuntimeError("fusion keep ids disagree with the face table")
    overlap = set(FONTSOURCE_FACES) & (
        FONTSOURCE_ALIAS | FONTSOURCE_UNSUITABLE | FONTSOURCE_NON_OFL | FONTSOURCE_DEJAVU | FONTSOURCE_DUPLICATE | FUSION_DROP
    )
    if overlap:
        raise RuntimeError(f"included faces overlap excludes: {sorted(overlap)}")
    if sum(n for _, n in PHASE1_BY_SOURCE.values()) != PHASE1_CLASSES:
        raise RuntimeError(f"phase-1 face tables do not sum to {PHASE1_CLASSES}")
    if {p.lower() for p in VELVETYNE_KEEP} != set(VELVETYNE_FACES):
        raise RuntimeError("velvetyne keep paths disagree with face counts")
    if WAITING_ON_SITE & set(VELVETYNE_FACES):
        raise RuntimeError("a waiting family is also in the velvetyne keep set")
    groups = (
        {p.lower() for p in VELVETYNE_KEEP},
        {p.lower() for p in VELVETYNE_OFF_CATALOG},
        {p.lower() for p in VELVETYNE_NON_OFL},
        {p.lower() for p in VELVETYNE_NO_LICENSE},
        {p.lower() for p in VELVETYNE_NOT_A_FONT},
        {VELVETYNE_NOTDEF.lower()},
    )
    flat: list[str] = []
    for group in groups:
        flat.extend(group)
    if len(flat) != len(set(flat)):
        raise RuntimeError("velvetyne policy ids overlap")


_require_tables()


@dataclass(frozen=True)
class DownloadRecipe:
    url: str
    filename: str

    def __post_init__(self) -> None:
        if not self.url.startswith("https://") or not self.filename:
            raise ValueError(f"bad download recipe: {self.url} {self.filename}")
        if "\n" in self.url or "\t" in self.url or " " in self.url:
            raise ValueError(f"download url is not TSV-safe: {self.url}")
        if Path(self.filename).name != self.filename or self.filename.startswith("."):
            raise ValueError(f"bad download filename: {self.filename}")
        if Path(self.filename).suffix.lower() not in {".ttf", ".otf"}:
            raise ValueError(f"download is not a static ttf/otf: {self.filename}")


@dataclass(frozen=True)
class LicenseRef:
    path: str
    sha256: str
    spdx: str
    reserved_font_names: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.spdx != OFL_SPDX or not _SHA.fullmatch(self.sha256):
            raise ValueError(f"bad license ref: {self.spdx} {self.sha256}")
        if any("|" in name or "\t" in name or "\n" in name for name in self.reserved_font_names):
            raise ValueError(f"reserved names are not TSV-safe: {self.reserved_font_names}")


@dataclass(frozen=True)
class FontClassRecord:
    class_id: str
    family: str
    family_id: str
    source: Source
    category: str
    weight: int | None
    style: str
    download: DownloadRecipe
    file_sha256: str
    license: LicenseRef
    designer: str
    version: str
    source_url: str

    def __post_init__(self) -> None:
        if not _CLASS_ID.fullmatch(self.class_id):
            raise ValueError(f"bad class id: {self.class_id}")
        if not _FAMILY_ID.fullmatch(self.family_id) or not self.family or not self.designer or not self.version:
            raise ValueError(f"bad family fields on {self.class_id}")
        if self.style not in _STYLES:
            raise ValueError(f"bad style on {self.class_id}: {self.style}")
        if self.weight is not None and not 1 <= self.weight <= 1000:
            raise ValueError(f"bad weight on {self.class_id}")
        if self.file_sha256 and not _SHA.fullmatch(self.file_sha256):
            raise ValueError(f"bad file sha256 on {self.class_id}")
        if not self.source_url.startswith("https://"):
            raise ValueError(f"bad source url on {self.class_id}")
        expected = f"data/licenses/v3/{self.source.value}/{self.family_id}/OFL.txt"
        if self.license.path != expected:
            raise ValueError(f"{self.class_id} license path {self.license.path} != {expected}")
        if "\t" in self.designer or "\n" in self.designer or "\t" in self.family or "\n" in self.category:
            raise ValueError(f"TSV-unsafe text on {self.class_id}")

    @property
    def subsets(self) -> tuple[str, ...]:
        return subsets_for(self.family_id)

    @property
    def instance(self) -> tuple[tuple[str, float], ...]:
        """Named axis coords for shared variable-font files (one file, many weights)."""
        if self.family_id not in VF_WEIGHT_FAMILIES or self.weight is None:
            return ()
        return (("wght", float(self.weight)),)


@dataclass(frozen=True)
class Exclusion:
    source: Source
    family_id: str
    family: str
    reason: ExcludeReason
    dropped_classes: int | None
    note: str

    def __post_init__(self) -> None:
        if not _FAMILY_ID.fullmatch(self.family_id) or not self.family or not self.note:
            raise ValueError(f"bad exclusion: {self.family_id}")
        if "\t" in self.note or "\n" in self.note or "\t" in self.family:
            raise ValueError(f"TSV-unsafe exclusion note: {self.family_id}")
        if self.reason == ExcludeReason.WAITING_ON_SITE:
            if self.dropped_classes is not None:
                raise ValueError("waiting-on-site has no known face count")
        elif self.dropped_classes is None or self.dropped_classes < 0:
            raise ValueError(f"dropped_classes required for {self.family_id}")


# TrueType, CFF OpenType, and the old Mac "true" sfnt. Type 1 PFB is not an sfnt.
SFNT_MAGIC = (b"\x00\x01\x00\x00", b"OTTO", b"true")


def is_sfnt(header: bytes) -> bool:
    return len(header) >= 4 and header[:4] in SFNT_MAGIC


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def is_ofl_1_1(data: bytes) -> bool:
    text = data.decode("utf-8-sig", errors="replace").lower()
    if "sil open font license" not in text:
        return False
    if "version 1.1" not in text and "v1.1" not in text:
        return False
    return "preamble" in text and "font software" in text


def _ofl_header(text: str) -> str:
    """Copyright block. The OFL body defines Reserved Font Name and must not be scanned."""
    lower = text.lower()
    cut = len(text)
    for marker in ("this font software is licensed", "preamble"):
        idx = lower.find(marker)
        if idx != -1:
            cut = min(cut, idx)
    return text[:cut]


# Declarations end at a period or a blank line. Mess has curly quotes and no period.
_RFN_CLAUSE = re.compile(r"reserved font names?\b\s*(.+?)(?:\.|\n\s*\n|$)", re.IGNORECASE | re.DOTALL)
_QUOTED_RFN = re.compile(r'["“«„]([^"“”«»„]+)["”»]')


def reserved_font_names(text: str) -> tuple[str, ...]:
    found: list[str] = []
    header = _ofl_header(text)
    for match in _RFN_CLAUSE.finditer(header):
        clause = match.group(1)
        if re.match(r"refers to\b", clause, re.IGNORECASE):
            continue
        names = _QUOTED_RFN.findall(clause)
        if not names:
            rest = re.sub(r"\s+and\s+", ",", clause, flags=re.IGNORECASE)
            names = [part.strip(" \"'“”«»„") for part in rest.split(",") if part.strip(" \"'“”«»„")]
        found.extend(names)
    seen: list[str] = []
    for name in found:
        if name and name not in seen:
            seen.append(name)
    return tuple(seen)


def copyright_line(text: str) -> str:
    header = _ofl_header(text)
    for blob in (header, text):
        for line in blob.splitlines():
            if "copyright" in line.lower() and line.strip():
                return line.strip()
    for line in text.splitlines():
        if line.strip():
            return line.strip()
    return ""


def license_path_for(source: Source, family_id: str) -> str:
    return f"data/licenses/v3/{source.value}/{family_id}/OFL.txt"


def _tsv(header: tuple[str, ...], rows: list[list[str]]) -> str:
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, delimiter="\t", lineterminator="\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(header)
    writer.writerows(rows)
    return buf.getvalue()


def _rows(text: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(text), delimiter="\t"))


def _record_row(rec: FontClassRecord) -> list[str]:
    return [
        rec.class_id,
        rec.family,
        rec.family_id,
        rec.source.value,
        rec.category,
        "" if rec.weight is None else str(rec.weight),
        rec.style,
        rec.download.filename,
        rec.download.url,
        rec.file_sha256,
        rec.license.path,
        rec.license.sha256,
        rec.license.spdx,
        "|".join(rec.license.reserved_font_names),
        rec.designer,
        rec.version,
        rec.source_url,
    ]


def dump_manifest(records: tuple[FontClassRecord, ...] | list[FontClassRecord]) -> str:
    ordered = sorted(records, key=lambda r: (_source_ord(r.source), r.family_id, r.class_id))
    return _tsv(MANIFEST_COLUMNS, [_record_row(r) for r in ordered])


def parse_manifest(text: str) -> tuple[FontClassRecord, ...]:
    rows = _rows(text)
    if not rows or tuple(rows[0]) != MANIFEST_COLUMNS:
        raise ValueError("manifest header does not match the registry schema")
    records: list[FontClassRecord] = []
    seen: set[str] = set()
    for raw in rows[1:]:
        if not raw or all(not cell for cell in raw):
            continue
        if len(raw) != len(MANIFEST_COLUMNS):
            raise ValueError(f"manifest row has {len(raw)} columns: {raw[:3]}")
        col = dict(zip(MANIFEST_COLUMNS, raw, strict=True))
        weight = int(col["weight"]) if col["weight"] else None
        rec = FontClassRecord(
            class_id=col["class_id"],
            family=col["family"],
            family_id=col["family_id"],
            source=Source(col["source"]),
            category=col["category"],
            weight=weight,
            style=col["style"],
            download=DownloadRecipe(col["download_url"], col["filename"]),
            file_sha256=col["file_sha256"],
            license=LicenseRef(
                path=col["license_path"],
                sha256=col["license_sha256"],
                spdx=col["license"],
                reserved_font_names=tuple(part for part in col["reserved_font_names"].split("|") if part),
            ),
            designer=col["designer"],
            version=col["version"],
            source_url=col["source_url"],
        )
        if rec.class_id in seen:
            raise ValueError(f"duplicate class id {rec.class_id}")
        seen.add(rec.class_id)
        records.append(rec)
    _require_shared_license(records)
    return tuple(records)


def _require_shared_license(records: list[FontClassRecord]) -> None:
    seen: dict[tuple[Source, str], LicenseRef] = {}
    for rec in records:
        key = (rec.source, rec.family_id)
        prev = seen.get(key)
        if prev is None:
            seen[key] = rec.license
        elif prev != rec.license:
            raise ValueError(f"{rec.family_id} does not share one license file")


def dump_exclusions(rows: tuple[Exclusion, ...] | list[Exclusion]) -> str:
    ordered = sorted(rows, key=lambda e: (_source_ord(e.source), e.reason.value, e.family_id))
    out = []
    for ex in ordered:
        dropped = "" if ex.dropped_classes is None else str(ex.dropped_classes)
        out.append([ex.source.value, ex.family_id, ex.family, ex.reason.value, dropped, ex.note])
    return _tsv(EXCLUDE_COLUMNS, out)


def parse_exclusions(text: str) -> tuple[Exclusion, ...]:
    rows = _rows(text)
    if not rows or tuple(rows[0]) != EXCLUDE_COLUMNS:
        raise ValueError("exclude header does not match the registry schema")
    found: list[Exclusion] = []
    seen: set[tuple[str, str]] = set()
    for raw in rows[1:]:
        if not raw or all(not cell for cell in raw):
            continue
        if len(raw) != len(EXCLUDE_COLUMNS):
            raise ValueError(f"exclude row has {len(raw)} columns: {raw[:3]}")
        col = dict(zip(EXCLUDE_COLUMNS, raw, strict=True))
        dropped = int(col["dropped_classes"]) if col["dropped_classes"] else None
        ex = Exclusion(
            source=Source(col["source"]),
            family_id=col["family_id"],
            family=col["family"],
            reason=ExcludeReason(col["reason"]),
            dropped_classes=dropped,
            note=col["note"],
        )
        key = (ex.source.value, ex.family_id)
        if key in seen:
            raise ValueError(f"duplicate exclusion {key}")
        seen.add(key)
        found.append(ex)
    return tuple(found)


def load_manifest(path: Path = MANIFEST_TSV) -> tuple[FontClassRecord, ...]:
    return parse_manifest(path.read_text(encoding="utf-8"))


def load_exclusions(path: Path = EXCLUDE_TSV) -> tuple[Exclusion, ...]:
    return parse_exclusions(path.read_text(encoding="utf-8"))


def _source_ord(source: Source) -> int:
    return (Source.FONTSOURCE, Source.COLLLETTTIVO, Source.VELVETYNE).index(source)


def _family_count(records: tuple[FontClassRecord, ...], source: Source) -> int:
    return len({r.family_id for r in records if r.source == source})


def check() -> list[str]:
    from fontsnap_ref.pipeline import Families, nz

    errors: list[str] = []
    try:
        manifest_text = MANIFEST_TSV.read_text(encoding="utf-8")
        exclude_text = EXCLUDE_TSV.read_text(encoding="utf-8")
        records = parse_manifest(manifest_text)
        exclusions = parse_exclusions(exclude_text)
    except (OSError, ValueError) as exc:
        return [f"catalog unreadable: {exc}"]
    if dump_manifest(records) != manifest_text:
        errors.append("manifest is not the canonical dump of its rows")
    if dump_exclusions(exclusions) != exclude_text:
        errors.append("exclude table is not the canonical dump of its rows")
    if len(records) != PHASE1_CLASSES:
        errors.append(f"expected {PHASE1_CLASSES} classes, found {len(records)}")
    for source, (families, classes) in PHASE1_BY_SOURCE.items():
        got = sum(1 for r in records if r.source == source)
        if got != classes or _family_count(records, source) != families:
            errors.append(
                f"{source.value}: expected {families} families / {classes} classes, found {_family_count(records, source)} / {got}"
            )

    by_reason: dict[ExcludeReason, set[str]] = {reason: set() for reason in ExcludeReason}
    for ex in exclusions:
        if ex.family_id in by_reason[ex.reason]:
            errors.append(f"duplicate exclude id {ex.family_id}")
        by_reason[ex.reason].add(ex.family_id)
    if by_reason[ExcludeReason.WAITING_ON_SITE] != WAITING_ON_SITE:
        errors.append("waiting-on-site ids are not the 16 catalog slugs")
    if any(ex.source != Source.VELVETYNE for ex in exclusions if ex.reason == ExcludeReason.WAITING_ON_SITE):
        errors.append("waiting-on-site rows must be velvetyne")
    if by_reason[ExcludeReason.ALIAS] != FONTSOURCE_ALIAS:
        errors.append(f"alias ids {sorted(by_reason[ExcludeReason.ALIAS])}")
    if by_reason[ExcludeReason.FUSION_MERGED] != FUSION_DROP:
        errors.append("fusion-merged ids are not the dropped locale cuts")
    if by_reason[ExcludeReason.OFF_CATALOG] != {p.lower() for p in VELVETYNE_OFF_CATALOG}:
        errors.append("off-catalog ids drifted")
    if by_reason[ExcludeReason.DUPLICATE_SOURCE] != FONTSOURCE_DUPLICATE:
        errors.append("duplicate-source ids drifted")
    unsuitable = FONTSOURCE_UNSUITABLE | {VELVETYNE_NOTDEF.lower()}
    if by_reason[ExcludeReason.UNSUITABLE] != unsuitable:
        errors.append(f"unsuitable ids drifted: {sorted(by_reason[ExcludeReason.UNSUITABLE] ^ unsuitable)}")
    non_ofl = FONTSOURCE_NON_OFL | FONTSOURCE_DEJAVU | {p.lower() for p in VELVETYNE_NON_OFL}
    if by_reason[ExcludeReason.NON_OFL] != non_ofl:
        errors.append(f"non-ofl ids drifted: {sorted(by_reason[ExcludeReason.NON_OFL] ^ non_ofl)}")
    if by_reason[ExcludeReason.NO_LICENSE] != {p.lower() for p in VELVETYNE_NO_LICENSE}:
        errors.append("no-license ids drifted")
    if by_reason[ExcludeReason.NOT_A_FONT] != {p.lower() for p in VELVETYNE_NOT_A_FONT} | COLLLETTTIVO_NOT_FONTS:
        errors.append("not-a-font ids drifted")

    excluded_keys = {(ex.source, ex.family_id) for ex in exclusions}
    manifest_keys = {(r.source, r.family_id) for r in records}
    overlap = manifest_keys & excluded_keys
    if overlap:
        errors.append(f"excluded families are in the manifest: {sorted((s.value, i) for s, i in overlap)}")
    if {r.family_id for r in records if r.source == Source.FONTSOURCE} != set(FONTSOURCE_FACES):
        errors.append("fontsource manifest families are not the phase-1 include list")
    fusion_ids = {r.family_id for r in records if r.family_id.startswith("fusion-")}
    if fusion_ids != FUSION_KEEP:
        errors.append(f"fusion classes kept {sorted(fusion_ids)}")

    by_digest_instance: dict[tuple[str, tuple[tuple[str, float], ...]], str] = {}
    for rec in records:
        if not rec.file_sha256:
            continue
        key = (rec.file_sha256, rec.instance)
        prev = by_digest_instance.get(key)
        if prev is not None:
            errors.append(f"{rec.class_id} shares file+instance with {prev}")
        else:
            by_digest_instance[key] = rec.class_id
        if rec.family_id in VF_WEIGHT_FAMILIES and rec.weight is not None and not rec.instance:
            errors.append(f"{rec.class_id} is a variable weight without an instance")

    sums = {
        ExcludeReason.UNSUITABLE: 97,
        ExcludeReason.ALIAS: 28,
        ExcludeReason.FUSION_MERGED: 20,
        ExcludeReason.DUPLICATE_SOURCE: 2,
    }
    for reason, expect in sums.items():
        got = sum(ex.dropped_classes or 0 for ex in exclusions if ex.reason == reason and ex.source == Source.FONTSOURCE)
        if got != expect:
            errors.append(f"fontsource {reason.value} drops {got}, expected {expect}")
    non_ofl_faces = sum(
        ex.dropped_classes or 0 for ex in exclusions if ex.reason == ExcludeReason.NON_OFL and ex.source == Source.FONTSOURCE
    )
    if non_ofl_faces != 55:
        errors.append(f"fontsource non-ofl drops {non_ofl_faces}, expected 55")

    model = set(Families().fams)
    collapsed: dict[str, set[str]] = {}
    for rec in records:
        key = nz(rec.family)
        collapsed.setdefault(key, set()).add(rec.family)
        if key in model:
            errors.append(f"{rec.family} normalizes to model family {key}")
        if rec.family_id.startswith("open-sauce-"):
            url = rec.download.url
            if "jsdelivr.net" in url or "/fonts/ttf/" not in url:
                errors.append(f"{rec.class_id} must come from the Open Sauce git ttf tree, not the CDN")
    for key, names in collapsed.items():
        if len(names) > 1:
            errors.append(f"families {sorted(names)} collapse to {key}")

    licenses: dict[str, str] = {}
    for rec in records:
        licenses.setdefault(rec.license.path, rec.license.sha256)
    if len(licenses) != sum(families for families, _ in PHASE1_BY_SOURCE.values()):
        errors.append(f"expected one license file per family, found {len(licenses)}")
    for rel, digest in sorted(licenses.items()):
        path = ROOT / rel
        if not path.is_file():
            errors.append(f"missing license {rel}")
            continue
        data = path.read_bytes()
        if sha256_hex(data) != digest:
            errors.append(f"license sha256 mismatch {rel}")
        if not is_ofl_1_1(data):
            errors.append(f"license is not OFL-1.1: {rel}")
    if LICENSE_ROOT.is_dir():
        for path in LICENSE_ROOT.rglob("*"):
            if path.is_file() and path.suffix.lower() in {".ttf", ".otf", ".woff", ".woff2", ".ttc"}:
                errors.append(f"font binary in the license tree: {path}")
    return errors
