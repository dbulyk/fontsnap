from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from train.paths import EXCLUDE_TSV, LICENSE_ROOT, MANIFEST_TSV, ROOT
from train.registry import (
    COLLLETTTIVO_FACES,
    COLLLETTTIVO_NOT_FONTS,
    FONTSOURCE_ALIAS,
    FONTSOURCE_DEJAVU,
    FONTSOURCE_DUPLICATE,
    FONTSOURCE_FACES,
    FONTSOURCE_NON_OFL,
    FONTSOURCE_UNSUITABLE,
    FUSION_DROP,
    HTTP_USER_AGENT,
    OFL_SPDX,
    VELVETYNE_FACES,
    VELVETYNE_KEEP,
    VELVETYNE_NO_LICENSE,
    VELVETYNE_NON_OFL,
    VELVETYNE_NOT_A_FONT,
    VELVETYNE_NOTDEF,
    VELVETYNE_OFF_CATALOG,
    WAITING_ON_SITE,
    DownloadRecipe,
    ExcludeReason,
    Exclusion,
    FontClassRecord,
    LicenseRef,
    Source,
    check,
    copyright_line,
    dump_exclusions,
    dump_manifest,
    is_ofl_1_1,
    is_sfnt,
    license_path_for,
    reserved_font_names,
    sha256_hex,
)

AVARA_REGULAR_COMMIT = "bcf69372"
AVARA_REGULAR_PATH = "fonts/Avara.otf"

WEIGHT_LABEL = {
    100: "Thin",
    200: "ExtraLight",
    300: "Light",
    400: "Regular",
    500: "Medium",
    600: "SemiBold",
    700: "Bold",
    800: "ExtraBold",
    900: "Black",
}

_SKIP_DIRS = frozenset(
    {
        "webfonts",
        "webfont",
        "web",
        "webs",
        "_web",
        "variable",
        "_variable",
        "vf",
        "webspecimen",
        "web-specimen",
        "documentation",
        "docs",
        "doc",
        "sources",
        "source",
        "specimen",
        "specimens",
        "woff",
        "woff2",
    }
)
_EXT_RANK = {".otf": 0, ".ttf": 1, ".woff": 2, ".woff2": 3}

DISPLAY = {
    "absans": "Absans",
    "apfel-grotezk": "Apfel Grotezk",
    "aujournuit": "Aujournuit",
    "borges": "Borges",
    "coconat": "Coconat",
    "halibut": "Halibut",
    "mattone": "Mattone",
    "mazius-display": "Mazius Display",
    "messapia": "Messapia",
    "necto-mono": "Necto Mono",
    "ortica": "Ortica",
    "ribes": "Ribes",
    "ronzino": "Ronzino",
    "sinistre": "Sinistre",
    "sneaky-times": "Sneaky Times",
    "sprat": "Sprat",
    "amdal": "Amdal",
    "anthony": "Anthony",
    "avara": "Avara",
    "backout": "BackOut",
    "basteleur": "Basteleur",
    "compagnon": "Compagnon",
    "facade-font": "Facade",
    "feroniapi": "Feroniapi",
    "flor-des-ruina": "Flor de Ruina",
    "format-1452": "Format 1452",
    "grotesk": "Grotesk",
    "gulax": "Gulax",
    "interlope": "Interlope",
    "jgs": "jgs Font",
    "kaerukaeru": "Kaeru Kaeru",
    "letters": "Letters",
    "lineal": "Lineal",
    "mess": "Mess",
    "mourier": "Mourier",
    "murmure": "Le Murmure",
    "ouroboros": "Ouroboros",
    "sligoil": "Sligoil",
    "trickster": "Trickster",
    "vg5000": "VG5000",
    "cantique": "Cantique",
    "imago-mundi-mei": "Imago Mundi Mei",
    "happy-times-at-the-ikob": "Happy Times at the IKOB",
    "sporting-grotesque": "Sporting Grotesque",
    "fungal": "Fungal",
    "pilowlava3d": "Pilowlava",
    "lack": "Lack",
    "velvetyne-notdef": "Velvetyne Notdef",
    "velvetyne-standard-character-set": "Velvetyne Standard Character Set",
    "velvetyne-libre-friends": "Velvetyne Libre Friends",
    "cltoools": "CLTools",
    "word-o-mat": "Word-o-mat",
}

_ALIAS_NOTE = {
    "firago": "render alias of GF Fira Sans",
    "geist-sans": "render alias of GF Geist",
    "noto-mono": "render alias of GF Noto Sans Mono",
}
_LIC_RANK = {
    "ofl.txt": 0,
    "ofl.md": 1,
    "license.txt": 2,
    "license.md": 3,
    "license": 4,
    "licence.txt": 5,
    "licence.md": 6,
    "licence": 7,
}


def read_url(url: str, limit: int | None = None, timeout: int = 60, accept: str = "*/*") -> bytes:
    headers = {"User-Agent": HTTP_USER_AGENT, "Accept": accept}
    last: Exception | None = None
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = response.read() if limit is None else response.read(limit + 1)
            if limit is not None and len(data) > limit:
                raise RuntimeError(f"{url} exceeds {limit} bytes")
            return data
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in {429, 500, 502, 503, 504} or attempt == 3:
                raise RuntimeError(f"GET {url} -> {exc.code}") from exc
        except urllib.error.URLError as exc:
            last = exc
            if attempt == 3:
                raise RuntimeError(f"GET {url} failed: {exc}") from exc
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def read_prefix(url: str, size: int = 16) -> bytes:
    headers = {"User-Agent": HTTP_USER_AGENT, "Accept": "*/*"}
    last: Exception | None = None
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read(size)
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code not in {429, 500, 502, 503, 504} or attempt == 3:
                raise RuntimeError(f"GET {url} -> {exc.code}") from exc
        except urllib.error.URLError as exc:
            last = exc
            if attempt == 3:
                raise RuntimeError(f"GET {url} failed: {exc}") from exc
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def get_json(url: str) -> object:
    data = json.loads(read_url(url, accept="application/json"))
    if isinstance(data, dict) and set(data) == {"message"}:
        raise RuntimeError(f"{url} -> {data['message']}")
    return data


def github_json(path: str) -> object:
    proc = subprocess.run(
        ["gh", "api", path, "-H", f"User-Agent: {HTTP_USER_AGENT}", "-H", "Accept: application/vnd.github+json"],
        check=False,
        capture_output=True,
    )
    if proc.returncode != 0:
        detail = proc.stderr.decode(errors="replace")[:400]
        raise RuntimeError(f"github {path} failed: {detail}")
    return json.loads(proc.stdout)


def face_class_id(family: str, weight: int, style: str) -> str:
    stem = "".join(ch for ch in family if ch.isalnum())
    label = WEIGHT_LABEL[weight]
    if style == "italic":
        suffix = "Italic" if weight == 400 else f"{label}Italic"
    elif style == "oblique":
        suffix = "Oblique" if weight == 400 else f"{label}Oblique"
    elif style == "normal":
        suffix = label
    else:
        raise ValueError(f"unknown style {style}")
    return f"{stem}-{suffix}"


def select_static_fonts(paths: list[str]) -> list[str]:
    best: dict[str, tuple[tuple[int, int, str], str]] = {}
    for path in paths:
        pure = PurePosixPath(path)
        ext = pure.suffix.lower()
        if ext not in _EXT_RANK:
            continue
        if any(part.lower() in _SKIP_DIRS for part in pure.parts[:-1]):
            continue
        stem = pure.stem.lower()
        if stem.endswith("vf") or "variable" in stem or stem.endswith("_web") or stem.endswith("-web"):
            continue
        rank = (_EXT_RANK[ext], len(pure.parts), path.lower())
        current = best.get(stem)
        if current is None or rank < current[0]:
            best[stem] = (rank, path)
    return sorted(path for _, path in best.values())


def _display(family_id: str) -> str:
    try:
        return DISPLAY[family_id]
    except KeyError as exc:
        raise RuntimeError(f"no display name for {family_id}") from exc


def _family_license(source: Source, family_id: str, data: bytes) -> tuple[LicenseRef, str]:
    if not is_ofl_1_1(data):
        raise RuntimeError(f"{source.value}/{family_id} license file is not OFL-1.1")
    text = data.decode("utf-8-sig", errors="replace")
    designer = copyright_line(text)
    if not designer:
        raise RuntimeError(f"{family_id} license has no copyright line")
    try:
        ref = LicenseRef(
            path=license_path_for(source, family_id),
            sha256=sha256_hex(data),
            spdx=OFL_SPDX,
            reserved_font_names=reserved_font_names(text),
        )
    except ValueError as exc:
        raise RuntimeError(f"{source.value}/{family_id}: {exc}") from exc
    return ref, designer


def _pick_license(paths: list[str]) -> str | None:
    best: tuple[tuple[int, int, str], str] | None = None
    for path in paths:
        name = PurePosixPath(path).name.lower()
        if name not in _LIC_RANK:
            continue
        rank = (path.count("/"), _LIC_RANK[name], path.lower())
        if best is None or rank < best[0]:
            best = (rank, path)
    return None if best is None else best[1]


def _pool(fn, items: list, workers: int = 8) -> list:
    if not items:
        return []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(fn, items))


def _pin_latest(url: str, version: str) -> str:
    if "@latest/" not in url and not url.rstrip("/").endswith("@latest"):
        if f"@{version}" in url:
            return url
        raise RuntimeError(f"cdn url has no @latest pin point: {url}")
    return url.replace("@latest", f"@{version}", 1)


def _variant_url(detail: dict, weight: int, style: str) -> str:
    subsets = detail["variants"][str(weight)][style]
    subset = detail.get("defSubset") or "latin"
    if subset not in subsets:
        subset = "latin" if "latin" in subsets else sorted(subsets)[0]
    urls = subsets[subset]["url"]
    for key in ("ttf", "otf"):
        if key in urls:
            return str(urls[key])
    raise RuntimeError(f"{detail['id']} {weight} {style} has no ttf or otf url")


def _npm_license(family_id: str, npm_version: str) -> bytes:
    base = f"https://cdn.jsdelivr.net/npm/@fontsource/{family_id}@{npm_version}"
    last = ""
    for name in ("LICENSE", "LICENSE.txt", "OFL.txt"):
        url = f"{base}/{name}"
        try:
            return read_url(url, limit=256_000)
        except RuntimeError as exc:
            last = str(exc)
            if "-> 404" not in last:
                raise
    raise RuntimeError(f"no LICENSE in @fontsource/{family_id}@{npm_version}: {last}")


def _fs_exclusion(fam: dict, reason: ExcludeReason, note: str) -> Exclusion:
    dropped = len(fam["weights"]) * len(fam["styles"])
    return Exclusion(Source.FONTSOURCE, fam["id"], fam["family"], reason, dropped, note)


def _unsuitable_note(family_id: str) -> str:
    if family_id.startswith("bravura"):
        return "music notation (SMuFL), not text"
    if family_id.startswith("dseg"):
        return "segment display, not text"
    if family_id.startswith("yakuhan"):
        return "CJK punctuation only"
    if family_id.startswith("unifont"):
        return "bitmap coverage font"
    return "unsuitable for text recognition"


def _fusion_target(family_id: str) -> str:
    if family_id.startswith("fusion-kai-"):
        return "fusion-kai-g"
    head, _, _loc = family_id.rpartition("-")
    return f"{head}-jp"


def _open_sauce_files() -> tuple[str, list[str]]:
    repo = github_json("repos/marcologous/Open-Sauce-Fonts")
    branch = str(repo["default_branch"])
    sha = str(github_json(f"repos/marcologous/Open-Sauce-Fonts/commits/{branch}")["sha"])
    listing = github_json("repos/marcologous/Open-Sauce-Fonts/contents/fonts/ttf?ref=" + sha)
    if not isinstance(listing, list):
        raise RuntimeError("Open Sauce fonts/ttf listing is not a file list")
    names = sorted(str(item["name"]) for item in listing if str(item["name"]).lower().endswith(".ttf"))
    return sha, names


def _style_weight_from_stem(stem: str) -> tuple[int, str]:
    _family, _, face = stem.partition("-")
    if not face:
        raise RuntimeError(f"Open Sauce filename has no face: {stem}")
    style = "normal"
    if face.endswith("Italic"):
        style = "italic"
        face = face[: -len("Italic")]
    elif face.endswith("Oblique"):
        style = "oblique"
        face = face[: -len("Oblique")]
    if not face:
        face = "Regular"
    weights = {label: weight for weight, label in WEIGHT_LABEL.items()}
    if face not in weights:
        raise RuntimeError(f"Open Sauce face {stem} is not a known weight")
    return weights[face], style


def build_fontsource() -> tuple[list[FontClassRecord], list[Exclusion], dict[str, bytes]]:
    catalog = get_json("https://api.fontsource.org/v1/fonts")
    if not isinstance(catalog, list):
        raise RuntimeError("fontsource catalog is not a list")
    other = [fam for fam in catalog if fam.get("type") == "other"]
    by_id = {str(fam["id"]): fam for fam in other}
    expected = (
        set(FONTSOURCE_FACES)
        | FONTSOURCE_ALIAS
        | FONTSOURCE_UNSUITABLE
        | FONTSOURCE_NON_OFL
        | FONTSOURCE_DEJAVU
        | FONTSOURCE_DUPLICATE
        | FUSION_DROP
    )
    if set(by_id) != expected:
        extra = sorted(set(by_id) - expected)
        missing = sorted(expected - set(by_id))
        raise RuntimeError(f"fontsource other set drifted extra={extra} missing={missing}")

    exclusions: list[Exclusion] = []
    for family_id, fam in sorted(by_id.items()):
        faces = len(fam["weights"]) * len(fam["styles"])
        if family_id in FONTSOURCE_FACES and faces != FONTSOURCE_FACES[family_id]:
            raise RuntimeError(f"{family_id} has {faces} faces, plan says {FONTSOURCE_FACES[family_id]}")
        if family_id in FONTSOURCE_ALIAS:
            exclusions.append(_fs_exclusion(fam, ExcludeReason.ALIAS, _ALIAS_NOTE[family_id]))
        elif family_id in FONTSOURCE_DUPLICATE:
            exclusions.append(_fs_exclusion(fam, ExcludeReason.DUPLICATE_SOURCE, "use the Collletttivo family (5 cuts)"))
        elif family_id in FONTSOURCE_UNSUITABLE:
            exclusions.append(_fs_exclusion(fam, ExcludeReason.UNSUITABLE, _unsuitable_note(family_id)))
        elif family_id in FUSION_DROP:
            target = _fusion_target(family_id)
            exclusions.append(_fs_exclusion(fam, ExcludeReason.FUSION_MERGED, f"merged into {target}"))
        elif family_id in FONTSOURCE_NON_OFL:
            stated = str(fam.get("license", ""))
            if stated.upper() == "OFL-1.1":
                raise RuntimeError(f"{family_id} metadata is OFL; the non-ofl exclude would be wrong")
            exclusions.append(_fs_exclusion(fam, ExcludeReason.NON_OFL, f"catalog license {stated}"))

    need = sorted(set(FONTSOURCE_FACES) | FONTSOURCE_DEJAVU)

    def _detail(family_id: str) -> dict:
        payload = get_json(f"https://api.fontsource.org/v1/fonts/{family_id}")
        if not isinstance(payload, dict):
            raise RuntimeError(f"{family_id} detail is not an object")
        return payload

    details = {family_id: detail for family_id, detail in zip(need, _pool(_detail, need), strict=True)}
    sauce_sha, sauce_names = _open_sauce_files()
    records: list[FontClassRecord] = []
    licenses: dict[str, bytes] = {}
    sniff: list[str] = []

    for family_id in sorted(FONTSOURCE_DEJAVU):
        detail = details[family_id]
        data = _npm_license(family_id, str(detail["npmVersion"]))
        if is_ofl_1_1(data):
            raise RuntimeError(f"{family_id} LICENSE is OFL; metadata warning does not apply")
        exclusions.append(
            _fs_exclusion(
                by_id[family_id],
                ExcludeReason.NON_OFL,
                "npm LICENSE is not OFL-1.1; Fontsource metadata says OFL-1.1",
            )
        )

    for family_id in sorted(FONTSOURCE_FACES):
        detail = details[family_id]
        if str(detail.get("id")) != family_id:
            raise RuntimeError(f"detail id mismatch for {family_id}")
        data = _npm_license(family_id, str(detail["npmVersion"]))
        ref, designer = _family_license(Source.FONTSOURCE, family_id, data)
        licenses[ref.path] = data
        family = str(by_id[family_id]["family"])
        category = str(detail.get("category") or "")
        version = str(detail.get("version") or detail["npmVersion"])
        source_url = str(detail.get("source") or f"https://fontsource.org/fonts/{family_id}")
        if not source_url.startswith("https://"):
            source_url = f"https://fontsource.org/fonts/{family_id}"
        if family_id.startswith("open-sauce-"):
            records.extend(_open_sauce_records(family_id, family, category, designer, ref, sauce_sha, sauce_names, source_url))
            continue
        made = _cdn_records(detail, family, category, designer, ref, version, source_url)
        if len(made) != FONTSOURCE_FACES[family_id]:
            raise RuntimeError(f"{family_id} produced {len(made)} classes, plan says {FONTSOURCE_FACES[family_id]}")
        records.extend(made)
        sniff.extend(rec.download.url for rec in made)

    _require_sfnt_urls(sniff)
    return records, exclusions, licenses


def _open_sauce_records(
    family_id: str,
    family: str,
    category: str,
    designer: str,
    ref: LicenseRef,
    sha: str,
    names: list[str],
    source_url: str,
) -> list[FontClassRecord]:
    prefix = "".join(ch for ch in family if ch.isalnum()) + "-"
    chosen = [name for name in names if name.startswith(prefix)]
    if len(chosen) != FONTSOURCE_FACES[family_id]:
        raise RuntimeError(f"{family_id} git ttf count {len(chosen)} != {FONTSOURCE_FACES[family_id]}: {chosen}")
    records = []
    for name in chosen:
        stem = PurePosixPath(name).stem
        weight, style = _style_weight_from_stem(stem)
        class_id = face_class_id(family, weight, style)
        if class_id != stem:
            raise RuntimeError(f"{name} does not match class id {class_id}")
        url = f"https://raw.githubusercontent.com/marcologous/Open-Sauce-Fonts/{sha}/fonts/ttf/{quote(name)}"
        records.append(
            FontClassRecord(
                class_id=class_id,
                family=family,
                family_id=family_id,
                source=Source.FONTSOURCE,
                category=category,
                weight=weight,
                style=style,
                download=DownloadRecipe(url, f"{class_id}.ttf"),
                file_sha256="",
                license=ref,
                designer=designer,
                version=sha,
                source_url=source_url
                if source_url.startswith("https://github.com/")
                else "https://github.com/marcologous/Open-Sauce-Fonts",
            )
        )
    _require_sfnt_urls([rec.download.url for rec in records])
    return records


def _cdn_records(
    detail: dict,
    family: str,
    category: str,
    designer: str,
    ref: LicenseRef,
    version: str,
    source_url: str,
) -> list[FontClassRecord]:
    family_id = str(detail["id"])
    npm = str(detail["npmVersion"])
    records = []
    for weight in sorted(int(w) for w in detail["weights"]):
        for style in sorted(str(s) for s in detail["styles"]):
            class_id = face_class_id(family, weight, style)
            url = _pin_latest(_variant_url(detail, weight, style), npm)
            ext = Path(url.split("?", 1)[0]).suffix.lower() or ".ttf"
            records.append(
                FontClassRecord(
                    class_id=class_id,
                    family=family,
                    family_id=family_id,
                    source=Source.FONTSOURCE,
                    category=category,
                    weight=weight,
                    style=style,
                    download=DownloadRecipe(url, f"{class_id}{ext}"),
                    file_sha256="",
                    license=ref,
                    designer=designer,
                    version=version,
                    source_url=source_url,
                )
            )
    return records


def _require_sfnt_urls(urls: list[str]) -> None:
    def _one(url: str) -> None:
        header = read_prefix(url)
        if not is_sfnt(header):
            raise RuntimeError(f"not a static sfnt ({header[:12]!r}): {url}")

    _pool(_one, urls, workers=12)


def _github_raw(owner: str, repo: str, sha: str, path: str) -> str:
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{sha}/{quote(path, safe='/')}"


def _foundry_records(
    source: Source,
    family_id: str,
    family: str,
    paths: list[str],
    sha: str,
    source_url: str,
    url_for,
    license_ref: LicenseRef,
    designer: str,
    expected: int,
) -> list[FontClassRecord]:
    chosen = select_static_fonts(paths)
    if len(chosen) != expected:
        raise RuntimeError(f"{family_id} static faces {len(chosen)} != {expected}: {chosen}")
    records = []
    for path in chosen:
        ext = PurePosixPath(path).suffix.lower()
        stem = PurePosixPath(path).stem
        records.append(
            FontClassRecord(
                class_id=stem,
                family=family,
                family_id=family_id,
                source=source,
                category="",
                weight=None,
                style=_infer_style(stem),
                download=DownloadRecipe(url_for(sha, path), f"{stem}{ext}"),
                file_sha256="",
                license=license_ref,
                designer=designer,
                version=sha,
                source_url=source_url,
            )
        )
    return records


def _infer_style(stem: str) -> str:
    low = stem.lower()
    if "italic" in low:
        return "italic"
    if "oblique" in low:
        return "oblique"
    return "normal"


def build_collletttivo() -> tuple[list[FontClassRecord], list[Exclusion], dict[str, bytes]]:
    repos = github_json("users/collletttivo/repos?per_page=100")
    if not isinstance(repos, list):
        raise RuntimeError("collletttivo repo list is not a list")
    by_name = {str(repo["name"]): repo for repo in repos}
    expected = set(COLLLETTTIVO_FACES) | COLLLETTTIVO_NOT_FONTS
    if set(by_name) != expected:
        raise RuntimeError(f"collletttivo repos drifted: {sorted(set(by_name) ^ expected)}")
    exclusions = [
        Exclusion(
            Source.COLLLETTTIVO,
            name,
            _display(name),
            ExcludeReason.NOT_A_FONT,
            0,
            "repository is not a typeface",
        )
        for name in sorted(COLLLETTTIVO_NOT_FONTS)
    ]
    fetched = _pool(lambda name: _github_repo("collletttivo", name, str(by_name[name]["default_branch"])), sorted(COLLLETTTIVO_FACES))
    records: list[FontClassRecord] = []
    licenses: dict[str, bytes] = {}
    for name, sha, blobs in fetched:
        license_path = _pick_license(blobs)
        if license_path is None:
            raise RuntimeError(f"{name} has no license file")
        data = read_url(_github_raw("collletttivo", name, sha, license_path), limit=256_000)
        ref, designer = _family_license(Source.COLLLETTTIVO, name, data)
        licenses[ref.path] = data
        records.extend(
            _foundry_records(
                Source.COLLLETTTIVO,
                name,
                _display(name),
                blobs,
                sha,
                f"https://github.com/collletttivo/{name}",
                lambda commit, path, repo=name: _github_raw("collletttivo", repo, commit, path),
                ref,
                designer,
                COLLLETTTIVO_FACES[name],
            )
        )
    return records, exclusions, licenses


def _github_repo(owner: str, repo: str, branch: str) -> tuple[str, str, list[str]]:
    sha = str(github_json(f"repos/{owner}/{repo}/commits/{branch}")["sha"])
    tree = github_json(f"repos/{owner}/{repo}/git/trees/{sha}?recursive=1")
    if not isinstance(tree, dict) or tree.get("truncated"):
        raise RuntimeError(f"{owner}/{repo} tree is truncated or not an object")
    blobs = [str(item["path"]) for item in tree["tree"] if item.get("type") == "blob"]
    return repo, sha, blobs


def _gitlab_raw(project_path: str, sha: str, path: str) -> str:
    return f"https://gitlab.com/velvetyne/{project_path}/-/raw/{sha}/{quote(path, safe='/')}"


def build_velvetyne() -> tuple[list[FontClassRecord], list[Exclusion], dict[str, bytes]]:
    projects = get_json("https://gitlab.com/api/v4/groups/velvetyne/projects?per_page=100&include_subgroups=true")
    if not isinstance(projects, list):
        raise RuntimeError("velvetyne group is not a list")
    by_path = {str(project["path"]): project for project in projects}
    expected = VELVETYNE_KEEP | VELVETYNE_OFF_CATALOG | VELVETYNE_NON_OFL | VELVETYNE_NO_LICENSE | VELVETYNE_NOT_A_FONT | {VELVETYNE_NOTDEF}
    if set(by_path) != expected:
        raise RuntimeError(f"velvetyne group drifted: {sorted(set(by_path) ^ expected)}")
    if {path.lower() for path in by_path} & WAITING_ON_SITE:
        raise RuntimeError("a waiting-on-site family now has a foundry repo")

    fetched = {
        path: payload
        for path, payload in zip(
            sorted(by_path),
            _pool(lambda path: _gitlab_project(by_path[path]), sorted(by_path), workers=4),
            strict=True,
        )
    }
    exclusions: list[Exclusion] = []
    records: list[FontClassRecord] = []
    licenses: dict[str, bytes] = {}
    reference_ofl: bytes | None = None
    avara: tuple[str, list[str], str | None, int] | None = None

    for path in sorted(by_path):
        family_id = path.lower()
        sha, blobs, license_bytes, fontinfo = fetched[path]
        if path == "Avara":
            avara = (sha, blobs, fontinfo, int(by_path[path]["id"]))
            continue
        chosen = select_static_fonts(blobs)
        if path in VELVETYNE_NOT_A_FONT:
            exclusions.append(Exclusion(Source.VELVETYNE, family_id, _display(family_id), ExcludeReason.NOT_A_FONT, 0, _vel_note(path)))
            continue
        if path == VELVETYNE_NOTDEF:
            exclusions.append(
                Exclusion(
                    Source.VELVETYNE,
                    family_id,
                    _display(family_id),
                    ExcludeReason.UNSUITABLE,
                    len(chosen),
                    ".notdef service font, no license file",
                )
            )
            continue
        if path in VELVETYNE_NO_LICENSE:
            if license_bytes is not None:
                raise RuntimeError(f"{path} unexpectedly has a license file")
            exclusions.append(
                Exclusion(
                    Source.VELVETYNE,
                    family_id,
                    _display(family_id),
                    ExcludeReason.NO_LICENSE,
                    len(chosen),
                    "no license file in the repository",
                )
            )
            continue
        if license_bytes is None:
            raise RuntimeError(f"{path} has no license file")
        ofl = is_ofl_1_1(license_bytes)
        if path in VELVETYNE_NON_OFL:
            if ofl:
                raise RuntimeError(f"{path} license is OFL; the non-ofl exclude would be wrong")
            note = "Bitstream Vera / DejaVu license" if path == "fungal" else "Free Art License, no shipped font files"
            exclusions.append(Exclusion(Source.VELVETYNE, family_id, _display(family_id), ExcludeReason.NON_OFL, len(chosen), note))
            continue
        if not ofl:
            raise RuntimeError(f"{path} license file is not OFL-1.1")
        if reference_ofl is None:
            reference_ofl = license_bytes
        if path in VELVETYNE_OFF_CATALOG:
            exclusions.append(
                Exclusion(
                    Source.VELVETYNE,
                    family_id,
                    _display(family_id),
                    ExcludeReason.OFF_CATALOG,
                    len(chosen),
                    "foundry catalog does not list this family",
                )
            )
            continue
        ref, designer = _family_license(Source.VELVETYNE, family_id, license_bytes)
        licenses[ref.path] = license_bytes
        project_path = path
        records.extend(
            _foundry_records(
                Source.VELVETYNE,
                family_id,
                _display(family_id),
                blobs,
                sha,
                f"https://gitlab.com/velvetyne/{project_path}",
                lambda commit, file_path, project=project_path: _gitlab_raw(project, commit, file_path),
                ref,
                designer,
                VELVETYNE_FACES[family_id],
            )
        )

    if avara is None or reference_ofl is None:
        raise RuntimeError("Avara payload or a reference OFL body is missing")
    avara_records, avara_license = _avara_records(*avara, reference_ofl)
    records.extend(avara_records)
    licenses[license_path_for(Source.VELVETYNE, "avara")] = avara_license

    off = [(ex.family_id, ex.dropped_classes) for ex in exclusions if ex.reason == ExcludeReason.OFF_CATALOG]
    if sum(count or 0 for _, count in off) != 7:
        raise RuntimeError(f"off-catalog faces are not 7: {off}")
    fungal = next(ex for ex in exclusions if ex.family_id == "fungal")
    if fungal.dropped_classes != 21:
        raise RuntimeError(f"fungal faces {fungal.dropped_classes} != 21")

    for family_id in sorted(WAITING_ON_SITE):
        exclusions.append(
            Exclusion(
                Source.VELVETYNE,
                family_id,
                family_id,
                ExcludeReason.WAITING_ON_SITE,
                None,
                "catalog family with no foundry repository while velvetyne.fr is down",
            )
        )
    return records, exclusions, licenses


def _vel_note(path: str) -> str:
    if path == "Velvetyne-Standard-Character-Set":
        return "MIT character-set specimen, not a font"
    return "no font files"


def _gitlab_blobs(project_id: int, sha: str, project_path: str) -> list[str]:
    blobs: list[str] = []
    pending = [""]
    while pending:
        directory = pending.pop()
        page = 1
        while page <= 20:
            url = f"https://gitlab.com/api/v4/projects/{project_id}/repository/tree?per_page=100&page={page}&ref={quote(sha, safe='')}"
            if directory:
                url += f"&path={quote(directory, safe='/')}"
            chunk = get_json(url)
            if not isinstance(chunk, list):
                raise RuntimeError(f"{project_path} tree page is not a list")
            for item in chunk:
                kind = item.get("type")
                path = str(item["path"])
                if kind == "blob":
                    blobs.append(path)
                elif kind == "tree" and str(item.get("name", "")).lower() not in _SKIP_DIRS:
                    pending.append(path)
            if len(chunk) < 100:
                break
            page += 1
        else:
            where = directory or "/"
            raise RuntimeError(f"{project_path} directory {where} exceeded 20 pages")
    return blobs


def _gitlab_project(project: dict) -> tuple[str, list[str], bytes | None, str | None]:
    project_id = project["id"]
    branch = str(project["default_branch"])
    commit = get_json(f"https://gitlab.com/api/v4/projects/{project_id}/repository/commits/{quote(branch, safe='')}")
    sha = str(commit["id"])
    blobs = _gitlab_blobs(int(project_id), sha, str(project["path"]))
    license_path = _pick_license(blobs)
    license_bytes = None
    if license_path is not None:
        license_bytes = read_url(_gitlab_raw(str(project["path"]), sha, license_path), limit=256_000)
    fontinfo = None
    if str(project["path"]) == "Avara" and "FONTINFO.json" in blobs:
        fontinfo = read_url(_gitlab_raw("Avara", sha, "FONTINFO.json"), limit=256_000).decode("utf-8", errors="replace")
    return sha, blobs, license_bytes, fontinfo


def _avara_records(
    sha: str,
    blobs: list[str],
    fontinfo: str | None,
    project_id: int,
    reference: bytes,
) -> tuple[list[FontClassRecord], bytes]:
    if not fontinfo:
        raise RuntimeError("Avara FONTINFO.json is missing")
    data = _avara_license(reference, fontinfo)
    ref, designer = _family_license(Source.VELVETYNE, "avara", data)
    head = _foundry_records(
        Source.VELVETYNE,
        "avara",
        _display("avara"),
        blobs,
        sha,
        "https://gitlab.com/velvetyne/Avara",
        lambda commit, file_path: _gitlab_raw("Avara", commit, file_path),
        ref,
        designer,
        3,
    )
    got = {rec.class_id for rec in head}
    if got != {"Avara-Black", "Avara-Bold", "Avara-BoldItalic"}:
        raise RuntimeError(f"Avara HEAD cuts are {sorted(got)}")
    commit = get_json(f"https://gitlab.com/api/v4/projects/{project_id}/repository/commits/{AVARA_REGULAR_COMMIT}")
    regular_sha = str(commit["id"])
    url = _gitlab_raw("Avara", regular_sha, AVARA_REGULAR_PATH)
    header = read_prefix(url)
    if not is_sfnt(header):
        raise RuntimeError(f"Avara Regular is not an sfnt: {header[:12]!r}")
    regular = FontClassRecord(
        class_id="Avara-Regular",
        family=_display("avara"),
        family_id="avara",
        source=Source.VELVETYNE,
        category="",
        weight=None,
        style="normal",
        download=DownloadRecipe(url, "Avara-Regular.otf"),
        file_sha256="",
        license=ref,
        designer=designer,
        version=regular_sha,
        source_url="https://gitlab.com/velvetyne/Avara",
    )
    return head + [regular], data


def _avara_license(reference: bytes, fontinfo: str) -> bytes:
    text = reference.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
    marker = next((line for line in text.splitlines(keepends=True) if line.lower().startswith("sil open font license")), None)
    if marker is None or "preamble" not in text.lower():
        raise RuntimeError("reference OFL has no SIL body")
    body = text[text.lower().find(marker.lower().strip()) :]
    authors = re.search(r'"authors"\s*:\s*\[(.*?)\]', fontinfo, re.DOTALL)
    year = re.search(r'"creation-date"\s*:\s*"(\d{4})"', fontinfo)
    names = re.findall(r'"([^"]+)"', authors.group(1)) if authors else []
    if not names or year is None:
        raise RuntimeError("Avara FONTINFO has no authors or year")
    preamble = (
        f"Copyright {year.group(1)} {', '.join(names)} (https://gitlab.com/velvetyne/Avara)\n"
        "\n"
        "This Font Software is licensed under the SIL Open Font License, Version 1.1.\n"
        "This license is copied below, and is also available with a FAQ at:\n"
        "https://openfontlicense.org\n"
        "\n"
        "\n"
    )
    data = (preamble + body).encode("utf-8")
    if not is_ofl_1_1(data):
        raise RuntimeError("constructed Avara OFL failed the OFL check")
    return data


def build_catalog() -> tuple[tuple[FontClassRecord, ...], tuple[Exclusion, ...], dict[str, bytes]]:
    print("inventory: fontsource", file=sys.stderr)
    font_records, font_ex, font_lic = build_fontsource()
    print("inventory: collletttivo", file=sys.stderr)
    coll_records, coll_ex, coll_lic = build_collletttivo()
    print("inventory: velvetyne", file=sys.stderr)
    vel_records, vel_ex, vel_lic = build_velvetyne()
    records = tuple(font_records + coll_records + vel_records)
    exclusions = tuple(font_ex + coll_ex + vel_ex)
    licenses = {**font_lic, **coll_lic, **vel_lic}
    if len(records) != 606:
        raise RuntimeError(f"built {len(records)} classes, expected 606")
    ids = [rec.class_id for rec in records]
    if len(ids) != len(set(ids)):
        raise RuntimeError("class ids are not unique")
    if set(licenses) != {rec.license.path for rec in records}:
        raise RuntimeError("license bytes do not match the records")
    return records, exclusions, licenses


def write_catalog(records: tuple[FontClassRecord, ...], exclusions: tuple[Exclusion, ...], licenses: dict[str, bytes]) -> None:
    wanted: set[Path] = set()
    root = LICENSE_ROOT.resolve()
    for rel, data in licenses.items():
        path = (ROOT / rel).resolve()
        if root not in path.parents:
            raise RuntimeError(f"license path escapes the tree: {rel}")
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.is_file() or path.read_bytes() != data:
            path.write_bytes(data)
        wanted.add(path)
    if LICENSE_ROOT.exists():
        for path in sorted(LICENSE_ROOT.rglob("*"), reverse=True):
            if path.is_file() and path.resolve() not in wanted:
                path.unlink()
            elif path.is_dir() and not any(path.iterdir()):
                path.rmdir()
    _atomic_text(MANIFEST_TSV, dump_manifest(records))
    _atomic_text(EXCLUDE_TSV, dump_exclusions(exclusions))


def _atomic_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def _summary(records: tuple[FontClassRecord, ...], exclusions: tuple[Exclusion, ...]) -> str:
    lines = []
    for source in (Source.FONTSOURCE, Source.COLLLETTTIVO, Source.VELVETYNE):
        faces = [rec for rec in records if rec.source == source]
        families = len({rec.family_id for rec in faces})
        lines.append(f"{source.value} {families} families / {len(faces)} classes")
    lines.append(f"total {len(records)} classes")
    for reason in ExcludeReason:
        rows = [ex for ex in exclusions if ex.reason == reason]
        dropped = sum(ex.dropped_classes or 0 for ex in rows)
        lines.append(f"exclude {reason.value}: {len(rows)} families, {dropped} classes")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args:
        print("usage: python -m train inventory", file=sys.stderr)
        return 2
    try:
        records, exclusions, licenses = build_catalog()
        write_catalog(records, exclusions, licenses)
        errors = check()
    except Exception:
        traceback.print_exc()
        return 1
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(_summary(records, exclusions))
    return 0
