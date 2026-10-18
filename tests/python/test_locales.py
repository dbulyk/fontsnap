"""scripts/i18n/build-locales.py must reproduce public/_locales byte for byte (the sources had drifted once)."""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_builder():
    spec = importlib.util.spec_from_file_location("build_locales", ROOT / "scripts" / "i18n" / "build-locales.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_build_locales_reproduces_every_committed_messages_json(tmp_path, monkeypatch):
    builder = load_builder()
    out = tmp_path / "_locales"
    monkeypatch.setattr(builder, "OUT", out)
    builder.main()
    committed = ROOT / "public" / "_locales"
    built = sorted(p.name for p in out.iterdir())
    assert built == sorted(p.name for p in committed.iterdir())
    assert len(built) == 55
    for locale in built:
        assert (out / locale / "messages.json").read_bytes() == (committed / locale / "messages.json").read_bytes(), locale


def test_the_builder_writes_to_public_locales_by_default():
    assert load_builder().OUT == ROOT / "public" / "_locales"
