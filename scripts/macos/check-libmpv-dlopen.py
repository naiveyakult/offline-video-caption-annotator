#!/usr/bin/env python3
"""Load libmpv with the same eager symbol resolution used by the app."""

from __future__ import annotations

import ctypes
import os
from pathlib import Path
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {Path(sys.argv[0]).name} LIBMPV_PATH", file=sys.stderr)
        return 2

    runtime = Path(sys.argv[1]).resolve()
    if not runtime.is_file():
        print(f"libmpv runtime not found: {runtime}", file=sys.stderr)
        return 1

    mode = os.RTLD_NOW | os.RTLD_LOCAL
    try:
        ctypes.CDLL(str(runtime), mode=mode)
    except OSError as error:
        print(f"libmpv RTLD_NOW check failed: {error}", file=sys.stderr)
        return 1

    print(f"libmpv RTLD_NOW check passed: {runtime}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
