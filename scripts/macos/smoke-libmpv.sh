#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="${LIBMPV_BUILD_DIR:-${HOME}/Library/Caches/offline-video-caption-annotator/libmpv-build}"
RUNTIME="${ROOT_DIR}/src-tauri/frameworks/libmpv.2.dylib"
OUTPUT="${TMPDIR:-/tmp}/offline-video-caption-annotator-libmpv-smoke"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 VIDEO_PATH" >&2
  exit 2
fi
test -f "${RUNTIME}"
test -f "${WORK_DIR}/prefix/include/mpv/client.h"
python3 "${ROOT_DIR}/scripts/macos/check-libmpv-dlopen.py" "${RUNTIME}"

xcrun clang -std=c11 -Wall -Wextra -Werror \
  -I"${WORK_DIR}/prefix/include" \
  "${ROOT_DIR}/scripts/macos/libmpv-smoke.c" \
  "${RUNTIME}" \
  -Wl,-rpath,"${ROOT_DIR}/src-tauri/frameworks" \
  -o "${OUTPUT}"
"${OUTPUT}" "$1"
