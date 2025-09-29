#!/usr/bin/env python3
import sys
print("[VERIFY] Python", sys.version)

# Torch / MPS
import torch, torchaudio
print("[VERIFY] torch", torch.__version__, "| torchaudio", torchaudio.__version__)
print("[VERIFY] MPS available:", torch.backends.mps.is_available())

# Demucs
from demucs.pretrained import get_model
dm = get_model('htdemucs')
print("[VERIFY] Demucs ok:", type(dm).__name__)

# PANNs CNN14
from panns_inference import AudioTagging
panns = AudioTagging(device='cpu')
print("[VERIFY] PANNs CNN14 ok")

# YAMNet (TF Hub)
import tensorflow as tf
import tensorflow_hub as hub
yamnet = hub.load("https://tfhub.dev/google/yamnet/1")
print("[VERIFY] YAMNet ok; TF", tf.__version__)

# Optional: pass an audio path to exercise PANNs/YAMNet quickly
def load_audio_mono_16k(path, target_sr=16000):
    import soundfile as sf, numpy as np, librosa
    x, sr = sf.read(path, always_2d=False)
    if x.ndim == 2: x = x.mean(axis=1)
    if sr != target_sr: x = librosa.resample(x, orig_sr=sr, target_sr=target_sr)
    return x.astype('float32')

if __name__ == "__main__":
    if len(sys.argv) > 1:
        ap = sys.argv[1]
        print(f"[VERIFY] Test clip: {ap}")
        try:
            wav = load_audio_mono_16k(ap)
            # PANNs
            out = panns.inference(wav[None, :])
            clip = out["clipwise_output"]
            idx = int(clip.argmax())
            print("[VERIFY] PANNs top index:", idx, "score:", float(clip[0, idx]))
            # YAMNet
            t = tf.constant(wav)
            scores, embeddings, spect = yamnet(t)
            print("[VERIFY] YAMNet outputs:", [tuple(x.shape.as_list()) for x in (scores, embeddings, spect)])
        except Exception as e:
            print("[VERIFY] Inference error:", e)
            sys.exit(2)
    print("[VERIFY] SUCCESS")
