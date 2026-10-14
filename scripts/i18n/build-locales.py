"""Build extension/_locales/<lang>/messages.json from scripts/i18n/<lang>.txt (one message per line, KEYS order).

The .txt files are the translation source (hand-written; see scripts/i18n/README.md). Placeholders are written
as $NAME$ in the text; their positional mapping comes from PLACEHOLDERS so every locale stays consistent.
"""

import json
import pathlib
import shutil

HERE = pathlib.Path(__file__).parent
OUT = HERE.parent.parent / "extension" / "_locales"
KEYS = (
    "appName appDesc actionTitle ctxImage ctxSelect selectHint resTitle tagline dropHint chooseImage dropTip "
    "modelSees loading analyzing ready noLines readFail captureFail modelFail errorMsg previewLabel previewPh "
    "scoreTitle notOnGF copyCss copied note doneIn doneInLoad wTitle wPinH wPin1 wPin2 wPin3 wPinned wUseH "
    "wUse1 wUse2 wUse3 wUse4 wTry wShowPin wPrivacy"
).split()
PLACEHOLDERS = {
    "captureFail": ["err"],
    "modelFail": ["err"],
    "errorMsg": ["err"],
    "doneIn": ["ms"],
    "doneInLoad": ["total", "load", "ms"],
}
DESCRIPTIONS = {"appName": "Extension name (Chrome Web Store, max 75 chars)", "appDesc": "Short description (max 132 chars)"}
ALIASES = {"en_GB": "en", "en_AU": "en", "en_US": "en"}


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    langs = sorted(p.stem for p in HERE.glob("*.txt")) + sorted(ALIASES)
    for lang in langs:
        lines = (HERE / f"{ALIASES.get(lang, lang)}.txt").read_text(encoding="utf-8").rstrip("\n").split("\n")
        assert len(lines) == len(KEYS), f"{lang}: {len(lines)} lines, expected {len(KEYS)}"
        msgs = {}
        for k, text in zip(KEYS, lines, strict=True):
            m = {"message": text.strip()}
            if k in DESCRIPTIONS:
                m["description"] = DESCRIPTIONS[k]
            if k in PLACEHOLDERS:
                m["placeholders"] = {n: {"content": f"${i + 1}"} for i, n in enumerate(PLACEHOLDERS[k])}
            msgs[k] = m
        d = OUT / lang
        d.mkdir(parents=True)
        (d / "messages.json").write_text(json.dumps(msgs, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(langs)} locales -> {OUT}")


if __name__ == "__main__":
    main()
