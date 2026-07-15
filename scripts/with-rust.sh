#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export RUSTUP_HOME="$ROOT_DIR/.tools/rustup"
export CARGO_HOME="$ROOT_DIR/.tools/cargo"
export PATH="$CARGO_HOME/bin:$PATH"

if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
  printf 'Project Rust toolchain is missing. Run: npm run rust:setup\n' >&2
  exit 1
fi

cd "$ROOT_DIR"
exec "$@"
