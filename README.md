# Rhythm-DNA-v2
Updated Version of Rhythm DNA

## Acceleration Report

Run a comprehensive diagnostic to verify each model's runtime and hardware acceleration status:

```bash
npm run accel:report
```

This generates both human-readable and structured reports in `app/Logs/`:
- `accel-report-node.json|txt` - Node.js/Electron side (TFJS, Xenova, ONNX Runtime)
- `accel-report.json|txt` - Python side (PyTorch, ONNX Runtime)

### What to Look For (Apple Silicon)

**PyTorch (PANNs/Demucs):**
- `"device_selected": "mps"` and `mps_available: true` ✅
- `"device_selected": "cuda"` and `cuda_available: true` ✅ (NVIDIA)
- `"device_selected": "cpu"` ⚠️ (fallback)

**TFJS (YAMNet):**
- Backend `"webgpu"` ✅ (ideal)
- Backend `"webgl"` ✅ (acceptable)
- Backend `"cpu"` ⚠️ (avoid if possible)

**Xenova (CLAP/ONNX):**
- `"backend": "webgpu"` with `"flags.useWebGPU": true` ✅ (ideal)
- `"backend": "wasm"` ✅ (acceptable fallback)

**ONNX Runtime:**
- `CoreMLExecutionProvider` in available providers ✅ (Apple Silicon)
- `WebGPU` via Xenova ✅ (browser/Electron)
- `CPUExecutionProvider` ⚠️ (fallback)

### Troubleshooting

If acceleration isn't working:
1. **PyTorch MPS**: Ensure you have PyTorch 1.12+ with MPS support
2. **TFJS WebGPU**: Check browser/Electron WebGPU support
3. **Xenova WebGPU**: Verify `WEBGPU=1` environment variable
4. **ONNX CoreML**: Install `onnxruntime-silicon` for Apple Silicon
