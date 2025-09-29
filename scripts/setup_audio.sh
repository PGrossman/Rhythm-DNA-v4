#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/app/py/.venv"
REQ="${ROOT_DIR}/app/py/requirements.txt"

usage() {
  cat <<EOF
Usage: $(basename "$0") [--venv-only|--warm-only]

No args     : create venv, install requirements, and warm models.
--venv-only : only create venv + install requirements
--warm-only : assume venv exists; only warm model weights
EOF
}

step() { echo -e "\033[1;34m[SETUP]\033[0m $*"; }

create_venv() {
  step "Creating venv at ${VENV_DIR}"
  /usr/bin/env python3 -m venv "${VENV_DIR}"
  # shellcheck disable=SC1091
  source "${VENV_DIR}/bin/activate"
  python -m pip install --upgrade pip setuptools wheel
  step "Installing requirements"
  pip install -r "${REQ}"
}

warm_models() {
  # shellcheck disable=SC1091
  source "${VENV_DIR}/bin/activate"

  step "Warming Demucs (htdemucs)"
  python - <<'PY'
from demucs.pretrained import get_model
m = get_model('htdemucs')  # downloads weights if needed
print("[WARM] Demucs model:", type(m).__name__)
PY

  step "Warming PANNs (CNN14)"
  python - <<'PY'
from panns_inference import AudioTagging
at = AudioTagging(device='cpu')
print("[WARM] PANNs CNN14 ready")
PY

  step "Warming YAMNet (TF Hub)"
  python - <<'PY'
import tensorflow_hub as hub
import tensorflow as tf
m = hub.load("https://tfhub.dev/google/yamnet/1")
import numpy as np
wave = tf.constant(np.zeros(16000, dtype=np.float32))
scores, embeddings, spectrogram = m(wave)
print("[WARM] YAMNet ready; outputs:", [t.shape for t in (scores, embeddings, spectrogram)])
PY
}

main() {
  if [[ "${1:-}" == "--help" ]]; then usage; exit 0; fi
  if [[ "${1:-}" == "--venv-only" ]]; then create_venv; exit 0; fi
  if [[ "${1:-}" == "--warm-only" ]]; then warm_models; exit 0; fi
  create_venv
  warm_models
  step "All good."
}
main "$@"
