# Translations

`<lang>.txt` holds one message per line in the key order of `build-locales.py` (`en.txt` is the source).
Placeholders are written as `$ERR$`, `$MS$`, `$TOTAL$`, `$LOAD$`. Rebuild with:

    python3 scripts/i18n/build-locales.py

`en_GB`, `en_AU`, `en_US` reuse `en.txt`. Limits checked by `tests/js/unit/locales.test.mjs`:
name ≤ 75, short description ≤ 132 characters, the name keeps "FontSnap".
Translations were written by hand (no Localizer / machine API).
