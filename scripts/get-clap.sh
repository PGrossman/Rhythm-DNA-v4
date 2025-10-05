#!/usr/bin/env bash
set -euo pipefail

DEST="app/models/xenova/Xenova/clap-htsat-unfused"
mkdir -p "$DEST/onnx"

BASE="${HF_BASE:-https://huggingface.co}"
REPO="$BASE/Xenova/clap-htsat-unfused/resolve/main"

echo "[GET-CLAP] Downloading CLAP model (~400MB)..."
echo "[GET-CLAP] Destination: $DEST"

# Small configs
curl -fsSL "$REPO/config.json" -o "$DEST/config.json"
curl -fsSL "$REPO/preprocessor_config.json" -o "$DEST/preprocessor_config.json"
curl -fsSL "$REPO/tokenizer_config.json" -o "$DEST/tokenizer_config.json"
curl -fsSL "$REPO/tokenizer.json" -o "$DEST/tokenizer.json"

echo "[GET-CLAP] Downloading model.onnx (this will take a few minutes)..."
curl -fL "$REPO/onnx/model.onnx" -o "$DEST/onnx/model.onnx"

SZ=$(wc -c < "$DEST/onnx/model.onnx")
if [ "$SZ" -lt 400000000 ]; then
  echo "[GET-CLAP] ERROR: model too small ($SZ bytes), download may have failed"
  exit 1
fi

echo "[GET-CLAP] Success! Model size: $((SZ/1024/1024))MB"
echo "[GET-CLAP] CLAP model ready for offline use"


