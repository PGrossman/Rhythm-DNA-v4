#!/usr/bin/env python3
import json, os, sys, platform, datetime
report = {"timestamp": datetime.datetime.utcnow().isoformat() + "Z",
          "host": {"platform": platform.platform(), "machine": platform.machine(), "python": sys.version.split()[0]}}

# ---- PyTorch (PANNs/Demucs) ----
pt = {}
try:
    import torch
    pt["installed"] = True
    pt["version"] = torch.__version__
    pt["mps_available"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    pt["mps_built"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_built())
    pt["cuda_available"] = torch.cuda.is_available()
    pt["cuda_device_count"] = torch.cuda.device_count() if pt["cuda_available"] else 0
    pt["device_selected"] = ("mps" if pt["mps_available"] else ("cuda" if pt["cuda_available"] else "cpu"))
except Exception as e:
    pt = {"installed": False, "error": str(e)}
report["pytorch"] = pt

# ---- ONNX Runtime (node-side models may use it via xenova/ort-web) ----
ort = {}
try:
    import onnxruntime as ortpy
    ort["installed"] = True
    ort["version"] = ortpy.__version__
    sess = ortpy.InferenceSession  # existence check
    providers = getattr(ortpy, "get_all_providers", lambda: [])()
    ort["available_providers"] = providers
except Exception as e:
    ort = {"installed": False, "error": str(e)}
report["onnxruntime_py"] = ort

# ---- Write files ----
out_dir = os.path.join(os.path.dirname(__file__), "..", "Logs")
os.makedirs(out_dir, exist_ok=True)
json_path = os.path.join(out_dir, "accel-report.json")
txt_path  = os.path.join(out_dir, "accel-report.txt")
with open(json_path, "w") as f:
    json.dump(report, f, indent=2)
with open(txt_path, "w") as f:
    f.write(f"[ACCEL REPORT] {report['timestamp']}\n")
    f.write(f"Host: {report['host']['platform']} / {report['host']['machine']} / Python {report['host']['python']}\n")
    f.write("\n[PyTorch]\n")
    f.write(json.dumps(report["pytorch"], indent=2) + "\n")
    f.write("\n[ONNX Runtime (py)]\n")
    f.write(json.dumps(report["onnxruntime_py"], indent=2) + "\n")
print(json_path)
