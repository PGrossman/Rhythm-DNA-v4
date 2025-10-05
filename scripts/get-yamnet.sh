#!/usr/bin/env bash
set -euo pipefail

DEST="app/models/xenova/Xenova/yamnet"
BASE="${HF_BASE:-https://huggingface.co}"
REPO="$BASE/Xenova/yamnet/resolve/main"

echo "[GET-YAMNET] Downloading to $DEST"
mkdir -p "$DEST/onnx"

curl -L "$REPO/config.json" -o "$DEST/config.json"
curl -L "$REPO/preprocessor_config.json" -o "$DEST/preprocessor_config.json"
curl -L "$REPO/onnx/model.onnx" -o "$DEST/onnx/model.onnx"

echo "[GET-YAMNET] Done - 3 files downloaded"
ls -la "$DEST" || true

