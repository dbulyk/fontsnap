"""Public web-negative bank: URL hygiene + train-time layout (no screenshots in-repo)."""

from __future__ import annotations

import csv
from pathlib import Path
from urllib.parse import urlparse

import pytest

REPO = Path(__file__).resolve().parents[2]


def _realset3_domains() -> set[str]:
    used: set[str] = set()
    labels = REPO / "data" / "realset3" / "labels.csv"
    if labels.is_file():
        with labels.open(encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                domain = (row.get("domain") or "").strip().lower().removeprefix("www.")
                url = (row.get("url") or "").strip()
                if domain:
                    used.add(domain)
                if url:
                    used.add(urlparse(url).netloc.lower().removeprefix("www."))
    for path in (REPO / "data" / "realset3").glob("sites*.txt"):
        for line in path.read_text(encoding="utf-8").splitlines():
            url = line.strip()
            if url:
                used.add(urlparse(url).netloc.lower().removeprefix("www."))
    return used


def test_public_urls_avoid_realset3_domains():
    from train.web_bank import BANK_SOURCE, PUBLIC_URLS, TARGET_SHOTS

    assert BANK_SOURCE.startswith("public-web-url-list")
    assert len(PUBLIC_URLS) >= 40
    assert TARGET_SHOTS >= 100
    banned = _realset3_domains()
    overlap = []
    for url in PUBLIC_URLS:
        host = urlparse(url).netloc.lower().removeprefix("www.")
        assert url.startswith("https://"), url
        if host in banned:
            overlap.append(host)
    assert overlap == [], overlap


def test_ensure_web_bank_reuses_local_shots_without_fetch(tmp_path, monkeypatch):
    from PIL import Image

    monkeypatch.setattr("train.paths.OUT", tmp_path)
    bank = tmp_path / "web-bank"
    bank.mkdir()
    Image.new("RGB", (80, 30), (255, 255, 255)).save(bank / "a.png")
    monkeypatch.setenv("FONTSNAP_WEB_BANK", str(bank))

    from train.web_bank import BANK_SOURCE, WebNegativeBank, ensure_web_bank, prepared_shot_chw

    root, count = ensure_web_bank(fetch=False)
    assert root == bank.resolve()
    assert count == 1
    chw = prepared_shot_chw(bank / "a.png", textcrop="pack")
    assert chw.shape == (3, 320, 320)
    views = WebNegativeBank()
    assert len(views) == 2  # pack + crop


def test_web_bank_logged_source_mentions_count(tmp_path, monkeypatch, capsys):
    from PIL import Image

    monkeypatch.setattr("train.paths.OUT", tmp_path)
    bank = tmp_path / "web-bank"
    bank.mkdir()
    Image.new("RGB", (60, 24), (200, 200, 200)).save(bank / "b.png")
    monkeypatch.setenv("FONTSNAP_WEB_BANK", str(bank))

    from train.web_bank import BANK_SOURCE, ensure_web_bank

    ensure_web_bank(fetch=False)
    out = capsys.readouterr().out
    assert BANK_SOURCE in out
    assert "shots=1" in out


def test_container_script_installs_playwright_chromium():
    from train.runpod import CALIBRATE, container_script, pinned_commit

    script = container_script(CALIBRATE, commit=pinned_commit())
    assert "playwright install" in script
    assert "chromium" in script


def test_softplus_not_tied_to_replay_labels():
    """Step A: softplus runs on web_iter, not on labels < BASE_CLASSES."""
    import inspect

    from train import loop

    src = inspect.getsource(loop.train)
    assert "web_iter" in src
    assert "labels < BASE_CLASSES" not in src
