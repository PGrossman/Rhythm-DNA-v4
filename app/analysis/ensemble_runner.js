"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

// --- LOGGING MODE SETUP ---
const LOG_MODE = (process.env.RNA_LOG_MODE || 'full').toLowerCase(); // v1.3.0: default to full logs
const SLIM = LOG_MODE === 'slim';

// --- ENSEMBLE DEBUG SETUP (safe, zero-risk) ---
const LOG_DIR = process.env.RNA_LOG_DIR || path.join(os.tmpdir(), 'rhythmdna-logs');
const LOG_FILE = process.env.RNA_LOG_FILE || null; // v1.3.0: when provided, write one file per track

// best-effort: don't ever throw if Logs missing
function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    // swallow
  }
}

// v1.3.0: Ensure log directory exists on startup
ensureLogDir();

function slugifyForFs(s) {
  return String(s || '')
    .replace(/[\/\\:?*"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

let __ENSEMBLE_LOG_FILE = null;
function setEnsembleLogContext(audioPath) {
  ensureLogDir();
  const base = path.basename(audioPath || 'unknown');
  const stamp = nowStamp();
  __ENSEMBLE_LOG_FILE = SLIM ? null : path.join(LOG_DIR, `ensemble-node-${slugifyForFs(base)}-${stamp}.log`);
}

function _writeLogLine(line) {
  if (!__ENSEMBLE_LOG_FILE) return;
  try {
    fs.appendFileSync(__ENSEMBLE_LOG_FILE, line + '\n');
  } catch {}
}

// Always safe console + file mirror
function ELOG(...args) {
  try {
    console.log('[ENSEMBLE]', ...args);
  } catch {}
  try {
    const text = args.map(a => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
    _writeLogLine(text);
  } catch {}
}

// Some code paths were calling `log(...)` directly — provide a safe alias
const log = (...args) => ELOG(...args);

// --- END ENSEMBLE DEBUG SETUP ---

/**
 * Run the Python ensemble analyzer in the app venv.
 * @param {string} audioPath absolute path to audio file
 * @param {{demucs?: boolean, timeoutMs?: number}} opts
 * @returns {Promise<{instruments: string[], scores: object, decision_trace: object, used_demucs: boolean}>}
 */
function analyzeWithEnsemble(audioPath, opts = {}) {
  const demucs = opts.demucs !== false;   // default true
  const timeoutMs = opts.timeoutMs ?? 0;  // 0 = no timeout
  const progressCallback = opts.progressCallback; // v1.0.0: progress callback support

  // Set up debug logging context
  setEnsembleLogContext(audioPath);
  ELOG('BEGIN analysis for', audioPath);

  const venvPy = path.resolve(__dirname, "../py/.venv/bin/python");
  const script = path.resolve(__dirname, "instruments_ensemble.py");

  // Log script path & head safely
  try {
    ELOG('scriptPath:', script);
    if (typeof fs?.statSync === 'function') {
      const st = fs.statSync(script);
      ELOG('script mtime:', st.mtime);
    } else {
      ELOG('WARN: fs.statSync not available in this context');
    }
    try {
      const buf = fs.readFileSync(script, { encoding: 'utf8' });
      const head = buf.split('\n').slice(0, 3).join(' \\ ');
      ELOG('script head:', head);
    } catch (e) {
      ELOG('WARN: cannot read script head:', e?.message || e);
    }
  } catch (e) {
    ELOG('WARN: cannot stat/read instruments_ensemble.py:', e?.message || e);
  }

  return new Promise(async (resolve, reject) => {
    try {
      if (!fs.existsSync(venvPy)) return reject(new Error(`Python venv not found at ${venvPy}`));
      if (!fs.existsSync(script)) return reject(new Error(`Ensemble script not found at ${script}`));

      const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ensemble-"));
      const outPath = path.join(tmpDir, "result.json");

      const args = [script, "--audio", audioPath, "--json-out", outPath, "--demucs", demucs ? "1" : "0"];
      
      // Add diagnostics flag if enabled
      if (process.env.RNA_DIAG_INSTRUMENTS) {
        args.push("--diag");
      }
      
      // Add ensemble trace flag if enabled
      if (process.env.RNA_ENSEMBLE_TRACE) {
        ELOG('RNA_ENSEMBLE_TRACE enabled - will log version and debug dump location');
      }

      // Set up Python environment with log directory
      const pyEnv = Object.assign({}, process.env, {
        ENSEMBLE_LOG_DIR: LOG_DIR  // tells Python where to dump its own debug file(s)
      });

      const baseName = path.basename(audioPath || 'unknown');
      const pyStdoutFile = SLIM ? null : path.join(LOG_DIR, `ensemble-python-stdout-${slugifyForFs(baseName)}-${nowStamp()}.log`);
      const pyStderrFile = SLIM ? null : path.join(LOG_DIR, `ensemble-python-stderr-${slugifyForFs(baseName)}-${nowStamp()}.log`);

      let procError = false;
      // v1.0.0: Emit progress callbacks at key milestones
      if (progressCallback) {
        progressCallback(25, 'Demucs processing');
      }
      
      const child = execFile(venvPy, args, { timeout: timeoutMs, env: pyEnv }, async (err, stdout, stderr) => {
        // Set process error flag
        procError = !!err;
        
        // v1.0.0: Emit progress callbacks during processing
        if (progressCallback) {
          progressCallback(50, 'PANNs analysis');
          progressCallback(75, 'YAMNet analysis');
        }
        
        // Capture stdout/stderr to files conditionally
        if (procError) { // set this boolean based on non-zero exit or thrown error
          if (stdout && pyStdoutFile) fs.appendFileSync(pyStdoutFile, stdout);
          if (stderr && pyStderrFile) fs.appendFileSync(pyStderrFile, stderr);
        } else if (!SLIM) {
          if (stdout && pyStdoutFile) fs.appendFileSync(pyStdoutFile, stdout);
          if (stderr && pyStderrFile) fs.appendFileSync(pyStderrFile, stderr);
        }

        if (err) return reject(new Error(`ensemble exec failed: ${err.message}\n${stderr || ""}`));
        try {
          const raw = await fsp.readFile(outPath, "utf-8");
          const result = JSON.parse(raw);
          
          // Normalize and write debug files
          const parsed = {
            mode: result?.mode || 'mix-only',
            used_demucs: !!result?.used_demucs,
            instruments: Array.isArray(result?.instruments) ? result.instruments.slice() : [],
            decision_trace: (result && typeof result.decision_trace === 'object') ? result.decision_trace : null,
            // keep the original too for debugging
            _raw: result
          };

          function safeJsonWrite(file, obj) {
            try {
              ensureLogDir();
              fs.writeFileSync(file, JSON.stringify(obj, null, 2));
            } catch {}
          }
          
          // v1.3.0: Per-track logging - if LOG_FILE is set, write all logs to that file
          function writeLogIfNeeded(filename, obj) {
            if (LOG_FILE) {
              // Write to per-track log file
              safeJsonWrite(LOG_FILE, obj);
            } else {
              // Write to individual files in LOG_DIR (existing behavior)
              safeJsonWrite(path.join(LOG_DIR, filename), obj);
            }
          }

          writeLogIfNeeded(
            `ensemble-node-parsed-${slugifyForFs(baseName)}-${nowStamp()}.json`,
            parsed
          );
          
          // Write diagnostics JSON if available (only in full mode)
          const wantDiag = !!process.env.RNA_DIAG_INSTRUMENTS && !SLIM;
          if (wantDiag && result && result.__diag) {
            writeLogIfNeeded(
              `ensemble-diag-${slugifyForFs(baseName)}-${nowStamp()}.json`,
              result.__diag
            );
          }

          ELOG(`mode=${parsed.mode} instruments:`, parsed.instruments.length ? parsed.instruments.join(', ') : '(none)');

          // Log any errors from decision_trace but don't treat them as fatal
          if (parsed.decision_trace && Array.isArray(parsed.decision_trace.errors)) {
            if (parsed.decision_trace.errors.length > 0) {
              ELOG('decision_trace.errors:', parsed.decision_trace.errors.join('; '));
            }
          }

          // Log version and debug dump location if RNA_ENSEMBLE_TRACE is enabled
          if (process.env.RNA_ENSEMBLE_TRACE && parsed.decision_trace) {
            ELOG('Ensemble version:', parsed.decision_trace.__version__ || 'unknown');
            ELOG('Debug dump saved to:', path.join(LOG_DIR, `ensemble-node-parsed-${slugifyForFs(baseName)}-${nowStamp()}.json`));
          }

          // Add debug stamp to decision_trace
          try {
            if (parsed.decision_trace) {
              const dt = parsed.decision_trace;
              // minimal, safe debug payload
              dt["__module_file__"] = script; // path to the ensemble module that ran
              dt["__version__"] = "mixrecall-2025-09-21-ww-drum-v1"; // version from the ensemble module
              // optionally mirror the core/woodwind thresholds we actually used, if accessible in code
              dt["__thresholds_debug__"] = {
                "mix_only_core_v2": {
                  "drum_kit": {"mean": 0.006, "pos": 0.015},
                  "electric_guitar": {"mean": 0.006, "pos": 0.023},
                  "acoustic_guitar": {"mean": 0.006, "pos": 0.023},
                  "bass_guitar": "unchanged"
                },
                "mix_only_woodwinds_v1": {
                  "per_instrument": {"mean": 0.0025, "pos": 0.010},
                  "section_min_count": 1,
                  "strong_individual": {"mean": 0.006, "pos": 0.035}
                }
              };
              // Add node runner script stamp
              dt["__node_runner_script"] = script;
              dt["__log_mode"] = LOG_MODE;
            }
          } catch (e) {
            // non-fatal: we still want the run to complete
            if (!parsed.__debug_errors) parsed.__debug_errors = [];
            parsed.__debug_errors.push(`ensemble debug stamp failed: ${e.name}: ${e.message}`);
          }

          // MIX-ONLY RESCUE (only when empty AND decision_trace exists)
          let rescueTriggered = false;
          if ((!parsed.instruments || parsed.instruments.length === 0) && parsed.decision_trace) {
            rescueTriggered = true;
            try {
              const pm = parsed.decision_trace?.per_model || {};
              const panns = pm?.panns || {};
              const yam = pm?.yamnet || {};
              const mP = panns?.mean_probs || {};
              const mY = yam?.mean_probs || {};
              const rP = panns?.pos_ratio || {};
              const rY = yam?.pos_ratio || {};

              const CORE = [
                'acoustic_guitar', 'electric_guitar',
                'bass_guitar', 'drum_kit',
                'piano', 'organ',
                'brass', 'strings'
              ];

              // Conservative, tuned to your debug JSON
              const MEAN_ANY = 0.006;
              const POS_ANY  = 0.020;
              const PANN_POS_BONUS = 0.060;
              const MAX_PICKS = 4;

              const candidates = [];
              for (const k of CORE) {
                const meanCombined = (Number(mP[k] || 0) + Number(mY[k] || 0)) || 0;
                const posCombined  = (Number(rP[k] || 0) + Number(rY[k] || 0)) || 0;
                const posP         = Number(rP[k] || 0);

                const pass = (meanCombined >= MEAN_ANY && posCombined >= POS_ANY) || (posP >= PANN_POS_BONUS);
                if (pass) {
                  const score = meanCombined * 0.7 + posCombined * 0.3;
                  candidates.push({ key: k, score, meanCombined, posCombined, posP });
                }
              }

              candidates.sort((a,b) => b.score - a.score);

              const pretty = (k) => {
                switch (k) {
                  case 'drum_kit': return 'Drum Kit (acoustic)';
                  case 'bass_guitar': return 'Bass Guitar';
                  case 'electric_guitar': return 'Electric Guitar';
                  case 'acoustic_guitar': return 'Acoustic Guitar';
                  case 'piano': return 'Piano';
                  case 'organ': return 'Organ';
                  case 'brass': return 'Brass (section)';
                  case 'strings': return 'Strings (section)';
                  default: return k.replace(/_/g, ' ').replace(/\b\w/g, s => s.toUpperCase());
                }
              };

              const picks = candidates.slice(0, MAX_PICKS).map(x => pretty(x.key));
              if (picks.length > 0) {
                ELOG('mix-only rescue picked (decision_trace):', picks.join(', '));
                parsed.instruments = picks;
              } else {
                ELOG('mix-only rescue: nothing exceeded conservative gates');
              }

              const wantRescue = (!SLIM && rescueTriggered === true);
              if (wantRescue) {
                writeLogIfNeeded(
                  `ensemble-node-rescue-${slugifyForFs(baseName)}-${nowStamp()}.json`,
                  { candidates, picks: parsed.instruments }
                );
              }
            } catch (e) {
              ELOG('mix-only rescue failed:', e?.message || e);
            }
          }

          const finalInstruments = Array.isArray(parsed.instruments) ? parsed.instruments : [];
          ELOG('FINAL instruments:', finalInstruments.join(', '));
          
          resolve(result);
        } catch (e) {
          reject(new Error(`failed to read ensemble JSON: ${e.message}`));
        }
      });
      child.on("error", (e) => reject(e));
    } catch (e) {
      reject(e);
    }
  });
}

function mapResultToAnalysis(js) {
  const out = {
    instrument_source: "ensemble",
    instruments_ensemble: js.instruments || [],
    instrument_scores: js.scores || {},
    instrument_decision_trace: js.decision_trace || {},
    instrument_by_stem: js.by_stem || {},
  };
  // Alias for downstream consumers (CSV/UI expect `analysis.instruments`)
  out.instruments = Array.isArray(out.instruments_ensemble)
    ? out.instruments_ensemble.slice()
    : [];

  // Stamp minimal __source_flags so CSV "Audio Sources" is never blank
  out.__source_flags = {
    sources: {
      ensemble: Array.isArray(out.instruments_ensemble) && out.instruments_ensemble.length > 0,
      probe_rescues: false,
      additional: false,
    }
  };

  // Add debug stamp for merge policy
  out._mergePolicy = "strict-ensemble-first";

          // v1.0.0: Emit final progress callback
          if (progressCallback) {
            progressCallback(100, 'complete');
          }
          
          // Note: Section tags (Brass/Strings) are now derived only for display purposes
          // using deriveSectionTags() function, not stored in analysis.instruments
          return out;
}

module.exports = { analyzeWithEnsemble, mapResultToAnalysis };