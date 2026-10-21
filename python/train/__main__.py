"""`python -m train` — dispatch subcommands without importing torch at startup."""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in {"-h", "--help"}:
        print(
            "commands: generate | fetch | samples | cache | parity | loop | export | "
            "shots | runpod | inventory\n"
            "cwd: python/   (same as python -m fontsnap_ref.evaluate)\n"
            "no paid RunPod create in this package's default path"
        )
        return 0
    cmd, rest = argv[0], argv[1:]
    if cmd == "generate":
        from train.generate import main as m

        return m(rest)
    if cmd == "runpod":
        from train.runpod import main as m

        return m(rest)
    if cmd == "parity":
        from train.parity import main as m

        return m(rest)
    if cmd == "shots":
        from train.shots import main as m

        return m(rest)
    if cmd == "inventory":
        from train.inventory import main as m

        return m(rest)
    if cmd == "samples":
        from train.samples import main as m

        return m(rest)
    if cmd == "loop":
        from train.loop import main as m

        return m(rest)
    if cmd == "export":
        from train.export import main as m

        return m(rest)
    if cmd == "fetch":
        from train.fetch import main as m

        return m(rest)
    if cmd == "cache":
        from train.cache import main as m

        return m(rest)
    print(f"unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
