from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if args != ["--check"]:
        print("usage: python -m train generate --check", file=sys.stderr)
        return 2
    from train.registry import check

    errors = check()
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print("ok")
    return 0
