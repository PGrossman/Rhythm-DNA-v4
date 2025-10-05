// Hardened wrapper for instruments_ensemble.py
// - Fixes: `log is not defined`, `usedDemucs is not defined`, `hints is not defined`
// - Robust snake_case mapping, safe defaults, and keeps debug logging

import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs";               // <-- sync-safe fs
import * as fsp from "node:fs/promises"; // <-- for async writes
import { createHash } from "node:crypto";
import os from "node:os";
import { finalizeInstruments, buildSourceFlags } from "./finalize_instruments.js";

// ---------- diagnostics toggle ----------
const DIAG = !!process.env.RNA_DIAG_INSTRUMENTS;

// ---------- logging ----------
const log = (...args) => console.log("[ENSEMBLE]", ...args);
const warn = (...args) => console.warn("[ENSEMBLE]", ...args);
const err = (...args) => console.error("[ENSEMBLE]", ...args);

// ---------- paths & helpers ----------
const LOG_DIR = "/Volumes/ATOM RAID/Dropbox/_Personal Files/12 - AI Vibe Coding/02 - Cursor Projects/02 - RhythmRNA V3/Logs";

function safeMkdirSync(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}

function writeJsonDebug(basename, obj) {
  try {
    safeMkdirSync(LOG_DIR);
    const file = path.join(LOG_DIR, basename);
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    log("debug file written:", file);
  } catch (e) {
    warn("failed to write debug file:", e?.message || e);
  }
}

function snakeOrCamel(obj, ...keys) {
  // return first present key value among variants (snake/camel)
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return undefined;
}

// Combine/normalize result from Python into a stable shape
function normalizePyResult(parsed) {
  // Normalize core fields with snakeOrCamel helper.
  // We defensively clone the instruments array if present so we can safely mutate it.
  const rawInstruments = snakeOrCamel(parsed, "instruments");
  const instruments = Array.isArray(rawInstruments) ? [...rawInstruments] : [];
  const decisionTrace = snakeOrCamel(parsed, "decision_trace", "decisionTrace") || {};
  const usedDemucs = snakeOrCamel(parsed, "used_demucs", "usedDemucs") ?? false;
  const byStem = snakeOrCamel(parsed, "by_stem", "byStem") || {};
  const instrumentSource = snakeOrCamel(parsed, "instrument_source", "instrumentSource") || "ensemble";
  const scores = snakeOrCamel(parsed, "scores") || {};

  // --- BEGIN: Merge booster 'added' instruments (if any) into instruments ---
  // Rationale: Python boosters may add instruments under decision_trace.boosts.*.added
  // (e.g., "Brass (section)"). Downstream code expects those to be present on the
  // canonical `instruments` array. Merge here where the full parsed payload exists.
  try {
    const boosts = decisionTrace && typeof decisionTrace === "object" ? (decisionTrace.boosts || {}) : {};
    const boosterAdded = [];

    for (const boostEntry of Object.values(boosts || {})) {
      if (!boostEntry || typeof boostEntry !== "object") continue;
      const added = Array.isArray(boostEntry.added) ? boostEntry.added
                  : Array.isArray(boostEntry.add) ? boostEntry.add
                  : [];
      if (!Array.isArray(added)) continue;
      for (const inst of added) {
        // Only push non-empty, non-duplicate instrument strings
        if (inst && typeof inst === "string" && !instruments.includes(inst)) {
          instruments.push(inst);
          boosterAdded.push(inst);
        }
      }
    }

    if (boosterAdded.length) {
      // Use existing log helper (defined at top of file). Fallback is unnecessary here
      // because `log` is present in this module, but keep message concise.
      log(`[ENSEMBLE] Added from boosters: ${boosterAdded.join(", ")}`);
    }
  } catch (e) {
    // Non-fatal: log a warning and continue returning whatever we have
    warn("normalizePyResult booster-merge failed:", e?.message || e);
  }
  // --- END: Merge booster 'added' instruments ---

  // Return unchanged shape, with instruments now potentially augmented by boosters.
  return { instruments, decisionTrace, usedDemucs, byStem, instrumentSource, scores };
}

// Conservative mix-only rescue using decision_trace (kept but fully guarded)
function mixOnlyRescue(decisionTrace) {
  try {
    if (!decisionTrace || typeof decisionTrace !== "object") return [];
    const perModel = decisionTrace.per_model || {};
    const panns = perModel.panns || {};
    const yam = perModel.yamnet || {};
    const pMean = panns.mean_probs || {};
    const yMean = yam.mean_probs || {};
    const pPos  = panns.pos_ratio  || {};
    const yPos  = yam.pos_ratio    || {};

    // thresholds (conservative)
    const MEAN_ANY = 0.006;
    const POS_ANY  = 0.02;
    const PANN_POS_BONUS = 0.06;
    const MAX_PICKS = 4;

    // core instruments we try to salvage in mix-only
    const CANDIDATES = [
      ["electric_guitar", "Electric Guitar"],
      ["acoustic_guitar", "Acoustic Guitar"],
      ["bass_guitar",     "Bass Guitar"],
      ["drum_kit",        "Drum Kit (acoustic)"],
      ["piano",           "Piano"],
      ["organ",           "Organ"],
    ];

    const picks = [];
    for (const [key, label] of CANDIDATES) {
      const mean = (pMean[key] || 0) + (yMean[key] || 0);
      const pos  = (pPos[key]  || 0) + (yPos[key]  || 0);
      const pass = (mean >= MEAN_ANY && pos >= POS_ANY) || (pPos[key] || 0) >= PANN_POS_BONUS;
      if (pass) picks.push({ label, score: mean + pos });
    }
    picks.sort((a,b) => b.score - a.score);
    return picks.slice(0, MAX_PICKS).map(p => p.label);
  } catch (e) {
    warn("mixOnlyRescue failed:", e?.message || e);
    return [];
  }
}

// ---------- main entry ----------
export async function runEnsemble({ audioPath, workdir, pythonBin, demucs = 0 }) {
  const scriptPath = path.join(process.cwd(), "app", "analysis", "instruments_ensemble.py");
  
  // v1.3.0: Per-track logging setup
  const inputPath = audioPath;
  const base = inputPath ? path.basename(inputPath).replace(/\s+/g, "_") : `untitled`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const hash = createHash("md5").update(inputPath || `${Date.now()}`).digest("hex").slice(0,8);
  const logDir = process.env.RNA_LOG_DIR || path.join(os.tmpdir(), "rhythmdna-logs");
  const perTrackLog = path.join(logDir, `${base}-${stamp}-${hash}.json`);
  
  // Ensure log directory exists
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (e) {
    warn("Failed to create log directory:", e?.message || e);
  }

  // Optional: script metadata (no crash if missing)
  try {
    const st = fs.statSync(scriptPath);
    log("scriptPath:", scriptPath);
    log("script mtime:", st.mtime.toISOString());
    try {
      const head = fs.readFileSync(scriptPath, "utf8").slice(0, 120).replace(/\n/g, " ↵ ");
      log("script head:", head);
    } catch {}
  } catch (e) {
    warn("WARN: cannot stat/read instruments_ensemble.py:", e?.message || e);
  }

  return await new Promise((resolve) => {
    const pyArgs = [
      scriptPath,
      "--audio", audioPath,
      "--json-out", path.join(workdir, "ensemble-result.json"),
      "--demucs", String(demucs ? 1 : 0),
    ];
    
    // Add diagnostics flag if enabled
    if (DIAG) {
      pyArgs.push("--diag");
    }
    
    const pyEnv = {
      ...process.env,
      RNA_LOG_MODE: process.env.RNA_LOG_MODE || "full",   // per your request: full logs for debugging
      RNA_LOG_FILE: perTrackLog
    };
    const py = spawn(pythonBin, pyArgs, { stdio: ["ignore", "pipe", "pipe"], env: pyEnv });

    let out = "", errBuf = "";
    py.stdout.on("data", (d) => { out += String(d); });
    py.stderr.on("data", (d) => { errBuf += String(d); });

    py.on("close", async (code) => {
      // Write raw stdout/stderr for debugging
      const base = path.basename(audioPath).replace(/\//g, "_");
      writeJsonDebug(`ensemble-python-stdout-${base}.log`, { stdout: out });
      writeJsonDebug(`ensemble-python-stderr-${base}.log`, { stderr: errBuf });

      let parsed;
      try {
        parsed = JSON.parse(out.trim());
      } catch (e) {
        err("failed to parse python stdout:", e?.message || e);
        // If Python wrote a file, try to read it
        try {
          const file = path.join(workdir, "ensemble-result.json");
          const txt = await fsp.readFile(file, "utf8");
          parsed = JSON.parse(txt);
          log("parsed fallback file ensemble-result.json");
        } catch (e2) {
          err("no parseable output from Python; returning empty instruments");
          return resolve({ instruments: [], instrumentSource: "ensemble", usedDemucs: false });
        }
      }

      // Normalize shapes+names from Python
      const norm = normalizePyResult(parsed);

      // If instruments empty and we're in mix-only → conservative rescue
      let instruments = Array.isArray(norm.instruments) ? [...norm.instruments] : [];
      const usedDemucs = !!norm.usedDemucs; // boolean
      if (!instruments.length && !usedDemucs) {
        const rescue = mixOnlyRescue(norm.decisionTrace);
        if (rescue.length) {
          log(`mix-only rescue picked (decision_trace): ${rescue.join(", ")}`);
          instruments = rescue;
        } else {
          log("mix-only rescue found nothing");
        }
      }

      // Add stable run ID once per analysis
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
      
      // Build a simple provenance flag for downstream consumers
      const instrumentSource = parsed?.instrument_source || "ensemble";
      const sourceFlags = {
        sources: {
          ensemble: instrumentSource === "ensemble",
          probe_rescues: instrumentSource === "probe_rescues",
          additional: instrumentSource === "additional"
        }
      };

      // Compute probe rescues (if any probe hints are available)
      const probeHints = Array.isArray(parsed?.probe?.hints) ? parsed.probe.hints : [];
      
      // Build the canonical list and flags
      const finalList = finalizeInstruments({
        ensembleInstruments: instruments,
        probeRescues: probeHints,
      });
      const flags = buildSourceFlags({
        ensembleInstruments: instruments,
        probeRescues: probeHints,
      });

      // Keep existing fields, but add a canonical final list and flags
      const finalInstruments = Array.isArray(parsed?.instruments) ? parsed.instruments : [];
      
      // Mirror to instruments_ensemble for downstream, preserve source
      const result = {
        instruments,
        instrumentSource: norm.instrumentSource || "ensemble",
        instruments_ensemble: instruments,
        usedDemucs,
        byStem: norm.byStem || {},
        scores: norm.scores || {},
        decision_trace: norm.decisionTrace || {},
        errors: (parsed && parsed.errors) || [],
        // Add canonical final instruments and metadata
        final_instruments: finalList,
        finalInstruments: finalInstruments,
        __run_id: runId,
        __source_flags: sourceFlags,
      };

      // Extra debug drop
      writeJsonDebug(`ensemble-node-parsed-${base}.json`, result);
      
      // v1.3.0: Write per-track log with Node-side wrapper
      try {
        const wrapper = {
          node_wrapper: {
            when: new Date().toISOString(),
            input: inputPath || null,
            usedDemucs: Boolean(result?.usedDemucs || result?.usedDemucs),
            finalInstruments: result?.instruments || result?.finalInstruments || [],
          }
        };
        const existing = fs.existsSync(perTrackLog) ? JSON.parse(fs.readFileSync(perTrackLog, "utf8")) : {};
        const merged = { ...existing, ...result, ...wrapper };
        fs.writeFileSync(perTrackLog, JSON.stringify(merged, null, 2));
        log("Per-track log written:", perTrackLog);
      } catch (e) {
        warn("Failed to write per-track log:", e?.message || e);
      }
      
      // Write diagnostics JSON if available
      if (DIAG && parsed && parsed.__diag) {
        writeJsonDebug(`ensemble-diag-${base}.json`, parsed.__diag);
      }

      // Never throw here—always resolve something stable
      return resolve(result);
    });
  });
}
