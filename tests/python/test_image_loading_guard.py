"""Every loader goes through fontsnap_ref.image.to_rgb: a bare convert("RGB") or convert("L") on a loaded image drops alpha.

This rule was missed once in four places (prep, text_lines, evaluate, make_fixtures), so a test keeps it from coming back.
It looks at the result of Image.open(...) and at the names img, pil, im and image. Image.fromarray(...).convert(...) is fine
(an array has no alpha to lose), and so is fontsnap_ref/image.py, the one place that converts.
"""

import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ALLOWED = {ROOT / "python" / "fontsnap_ref" / "image.py"}
LOADED_NAMES = {"img", "pil", "im", "image"}
FLAT_MODES = {"RGB", "L"}


def violations(source: str) -> list[int]:
    lines = []
    for node in ast.walk(ast.parse(source)):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "convert"):
            continue
        if not (node.args and isinstance(node.args[0], ast.Constant) and node.args[0].value in FLAT_MODES):
            continue
        receiver = node.func.value
        opened = (
            isinstance(receiver, ast.Call)
            and isinstance(receiver.func, ast.Attribute)
            and receiver.func.attr == "open"
            and isinstance(receiver.func.value, ast.Name)
            and receiver.func.value.id == "Image"
        )
        if opened or (isinstance(receiver, ast.Name) and receiver.id in LOADED_NAMES):
            lines.append(node.lineno)
    return lines


def test_the_scanner_sees_what_it_should():
    assert violations('Image.open(p).convert("RGB")') == [1]
    assert violations('x = pil.convert("L")') == [1]
    assert violations('img.convert("RGB")') == [1]
    assert violations('Image.fromarray(a).convert("RGB")') == []
    assert violations('im.convert("RGBA")') == []
    assert violations("to_rgb(Image.open(p))") == []


def test_no_loader_bypasses_to_rgb():
    found = []
    for folder in ("python", "tests"):
        for path in sorted((ROOT / folder).rglob("*.py")):
            if path in ALLOWED or ".venv" in path.parts:
                continue
            found += [f"{path.relative_to(ROOT)}:{n}" for n in violations(path.read_text())]
    assert found == [], "use fontsnap_ref.image.to_rgb, it composites alpha like the extension: " + ", ".join(found)
