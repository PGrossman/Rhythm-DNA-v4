#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/app/models/xenova/Xenova/ast-finetuned-audioset-10-10-0.4593"

echo "[GET-AST] Downloading AST model into:"
echo "         $DEST"
mkdir -p "$DEST/onnx"

# Use HF CLI if present (preferred — handles redirects + mirrors)
if command -v hf >/dev/null 2>&1; then
  hf download Xenova/ast-finetuned-audioset-10-10-0.4593 \
    --include "config.json" \
    --include "preprocessor_config.json" \
    --include "onnx/model.onnx" \
    --local-dir "$DEST" \
    --local-dir-use-symlinks False
else
  # Fallback to curl
  BASE="https://huggingface.co/Xenova/ast-finetuned-audioset-10-10-0.4593/resolve/main"
  curl -L "$BASE/config.json"              -o "$DEST/config.json"
  curl -L "$BASE/preprocessor_config.json" -o "$DEST/preprocessor_config.json"
  curl -L "$BASE/onnx/model.onnx"         -o "$DEST/onnx/model.onnx"
fi

echo "[GET-AST] Done. Verifying:"
ls -lh "$DEST/config.json" "$DEST/preprocessor_config.json" "$DEST/onnx/model.onnx" || true


