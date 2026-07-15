#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export RUSTUP_HOME="$ROOT_DIR/.tools/rustup"
export CARGO_HOME="$ROOT_DIR/.tools/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
TOOLCHAIN="1.97.0"

mkdir -p "$RUSTUP_HOME" "$CARGO_HOME"

if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  INSTALLER=$(mktemp "${TMPDIR:-/tmp}/rustup-init.XXXXXX")
  trap 'rm -f "$INSTALLER"' EXIT HUP INT TERM
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    https://sh.rustup.rs -o "$INSTALLER"
  sh "$INSTALLER" -y --no-modify-path --profile minimal --default-toolchain none
fi

cd "$ROOT_DIR"
rustup set profile minimal
rustup toolchain install "$TOOLCHAIN" --component rustfmt

# A partially downloaded component can be marked installed even when its binary
# is missing. Repair that state before declaring the environment ready.
if ! cargo --version >/dev/null 2>&1; then
  rustup component remove cargo || true
  rustup component add cargo
fi

printf 'Rust toolchain installed in %s\n' "$ROOT_DIR/.tools"
rustc --version
cargo --version
