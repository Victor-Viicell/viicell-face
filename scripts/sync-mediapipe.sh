#!/usr/bin/env bash
# Copies the MediaPipe vision runtime into public/ and fetches the face model.
#
# The webview loads these as plain files (public/ is served as-is), so the app
# does not need the npm package at runtime and never downloads a model while
# starting. Re-run this after bumping @mediapipe/tasks-vision.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$root/node_modules/@mediapipe/tasks-vision/wasm"
target_dir="$root/public/mediapipe/wasm"
model="$root/public/models/face_landmarker.task"

if [[ ! -d "$source_dir" ]]; then
  echo "missing $source_dir; run bun install first" >&2
  exit 1
fi

mkdir -p "$target_dir" "$(dirname "$model")"
rm -f "$target_dir"/*.js "$target_dir"/*.wasm

# Only the page variants: the `*_module_internal` files are for module workers,
# which the app does not spawn.
cp "$source_dir"/vision_wasm_internal.js "$source_dir"/vision_wasm_internal.wasm "$target_dir/"
cp "$source_dir"/vision_wasm_nosimd_internal.js "$source_dir"/vision_wasm_nosimd_internal.wasm "$target_dir/"

if [[ ! -s "$model" ]]; then
  curl -fL --retry 3 -o "$model" \
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
fi

echo "mediapipe runtime: $target_dir"
echo "face model:        $model"
