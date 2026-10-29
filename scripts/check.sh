#!/usr/bin/env bash
# The one gate every session must pass before committing.
# Fast (no bundling, no release profile). Exits non-zero on the first failure
# but still prints each stage's verdict so the report can quote it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

fail=0
stage() { printf '\n=== %s ===\n' "$1"; }
verdict() {
  if [[ "$1" -ne 0 ]]; then
    printf 'FAIL %s\n' "$2"
    fail=1
  else
    printf 'ok   %s\n' "$2"
  fi
}

stage "typescript"
out=$(bunx tsc --noEmit 2>&1); rc=$?
[[ $rc -ne 0 ]] && printf '%s\n' "$out" | tail -30
verdict $rc "tsc --noEmit"

stage "unit tests"
out=$(bun test 2>&1); rc=$?
printf '%s\n' "$out" | tail -5
verdict $rc "bun test"

stage "frontend build"
out=$(bunx vite build 2>&1); rc=$?
[[ $rc -ne 0 ]] && printf '%s\n' "$out" | tail -30
verdict $rc "vite build"

stage "rust"
out=$(cd src-tauri && cargo test --lib --quiet 2>&1); rc=$?
[[ $rc -ne 0 ]] && printf '%s\n' "$out" | tail -40
verdict $rc "cargo test --lib"

out=$(cd src-tauri && cargo check --quiet 2>&1); rc=$?
[[ $rc -ne 0 ]] && printf '%s\n' "$out" | tail -40
verdict $rc "cargo check"

# Windows compile gate exists only once the target is installed; a skipped gate
# must be visible, not silently green.
if rustup target list --installed 2>/dev/null | grep -q 'x86_64-pc-windows-msvc'; then
  stage "windows compile gate"
  out=$(cd src-tauri && cargo check --quiet --target x86_64-pc-windows-msvc 2>&1); rc=$?
  [[ $rc -ne 0 ]] && printf '%s\n' "$out" | tail -40
  verdict $rc "cargo check --target x86_64-pc-windows-msvc"
else
  printf '\nSKIP windows compile gate (rustup target add x86_64-pc-windows-msvc)\n'
fi

printf '\n'
if [[ $fail -ne 0 ]]; then
  echo "CHECK FAILED — do not commit."
  exit 1
fi
echo "CHECK GREEN"
