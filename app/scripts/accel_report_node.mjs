import fs from "fs";
import os from "os";
import path from "path";
const __root = path.resolve(process.cwd(), "app");

const outDir = path.join(__root, "Logs");
fs.mkdirSync(outDir, { recursive: true });
const outJson = path.join(outDir, "accel-report-node.json");
const outTxt  = path.join(outDir, "accel-report-node.txt");

const report = {
  timestamp: new Date().toISOString(),
  host: { platform: os.platform(), arch: os.arch(), node: process.version, electron: process.versions.electron || null }
};

// ---- TFJS (YAMNet) ----
try {
  const tf = await import("@tensorflow/tfjs-node"); // fallback CPU
  report.tfjs = { package: "@tensorflow/tfjs-node", backend: "tensorflow (node)", version: tf.version_core || tf.version_core?.tfjs || "unknown" };
} catch {
  try {
    const tf = await import("@tensorflow/tfjs");
    // Try webgpu first, then webgl, then wasm
    if (tf.backend && typeof tf.backend === "function") {
      // already set by env; just read
      report.tfjs = { package: "@tensorflow/tfjs", backend: tf.getBackend() };
    } else {
      report.tfjs = { package: "@tensorflow/tfjs", backend: "unknown" };
    }
  } catch (e) {
    report.tfjs = { error: String(e) };
  }
}

// ---- Xenova transformers (CLAP / ONNX) ----
try {
  const env = await import("@xenova/transformers/env");
  const ts  = await import("@xenova/transformers");
  report.xenova = {
    backend: env.env?.BACKEND || "unknown", // 'wasm' or 'webgpu'
    device:  env.env?.WEBGPU ? "webgpu" : "wasm",
    version: ts.version || null,
    flags: { useWebGPU: !!env.env?.WEBGPU, useProxy: !!env.env?.USE_PROXY }
  };
} catch (e) {
  report.xenova = { error: String(e) };
}

// ---- ONNX Runtime (node) if present ----
try {
  const ort = await import("onnxruntime-node");
  report.onnxruntime_node = { version: ort.version || null, available_providers: ort.getAvailableProviders ? ort.getAvailableProviders() : [] };
} catch (e) {
  report.onnxruntime_node = { installed: false };
}

fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
fs.writeFileSync(outTxt, [
  `[ACCEL REPORT - NODE] ${report.timestamp}`,
  `Host: ${report.host.platform}/${report.host.arch} Node ${report.host.node} Electron ${report.host.electron || "n/a"}`,
  "",
  "[TFJS]",
  JSON.stringify(report.tfjs, null, 2),
  "",
  "[Xenova/transformers]",
  JSON.stringify(report.xenova, null, 2),
  "",
  "[ONNX Runtime (node)]",
  JSON.stringify(report.onnxruntime_node, null, 2),
  ""
].join("\n"));

console.log(outJson);
