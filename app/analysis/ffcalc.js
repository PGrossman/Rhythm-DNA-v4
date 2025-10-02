'use strict';

let __acfConfidence = null; // last ACF confidence (0..1) for the most recent fallback run
// Toggle verbose tempo debugging (byte counts, window starts, widen retries).
// Enable by running the app with TEMPO_DEBUG=1 (or "true").
const TEMPO_DEBUG =
  process.env.TEMPO_DEBUG === '1' ||
  process.env.TEMPO_DEBUG === 'true';
const tempoDbg = (...args) => { if (TEMPO_DEBUG) console.log(...args); };

// CSV writing toggle: default OFF; set RNA_WRITE_CSV=1 to re-enable
const WRITE_CSV = (process.env.RNA_WRITE_CSV === "1");

// app/analysis/ffcalc.js - CommonJS module for ffmpeg analysis
const { spawn } = require('child_process');
const path = require('node:path');
const { analyzeWithEnsemble, mapResultToAnalysis } = require('./ensemble_runner');
const fs = require('node:fs');               // for statSync/readFileSync
const fsp = require('node:fs/promises');     // keep async fs if used elsewhere
const os = require('node:os');
const { BrowserWindow } = require("electron");
const { shouldWriteCsv } = require('../utils/csvWriter');

// v1.0.0: Orchestration mode toggle
const INSTRUMENTATION_MODE = process.env.RNA_INSTRUMENTATION_MODE || "CONCURRENT"; // "SEQUENTIAL" or "CONCURRENT"

// v1.2.0: Background processing queue (simple semaphore for concurrency control)
let activeBackgroundTasks = 0;
const MAX_BACKGROUND_CONCURRENCY = 4; // Max concurrent Creative+Instrumentation pairs
const backgroundQueue = [];

// v1.2.0: Process next queued background task
function processNextBackgroundTask() {
  if (activeBackgroundTasks >= MAX_BACKGROUND_CONCURRENCY || backgroundQueue.length === 0) {
    return;
  }
  
  const task = backgroundQueue.shift();
  activeBackgroundTasks++;
  console.log(`[BACKGROUND-QUEUE] Starting task (active: ${activeBackgroundTasks}/${MAX_BACKGROUND_CONCURRENCY}, queued: ${backgroundQueue.length})`);
  
  task()
    .catch(err => {
      console.error('[BACKGROUND-QUEUE] Task failed:', err);
    })
    .finally(() => {
      activeBackgroundTasks--;
      console.log(`[BACKGROUND-QUEUE] Task complete (active: ${activeBackgroundTasks}/${MAX_BACKGROUND_CONCURRENCY}, queued: ${backgroundQueue.length})`);
      processNextBackgroundTask(); // Start next task if available
    });
}

// v1.2.0: Enqueue background task with concurrency control
function enqueueBackgroundTask(taskFn) {
  backgroundQueue.push(taskFn);
  console.log(`[BACKGROUND-QUEUE] Task queued (active: ${activeBackgroundTasks}/${MAX_BACKGROUND_CONCURRENCY}, queued: ${backgroundQueue.length})`);
  processNextBackgroundTask();
}

// v2.1.0: Instrumentation progress helper
function sendInstrProgress(file, pct, label) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  win.webContents.send("instrumentation:progress", { file, pct, label });
}

// v1.0.0: Instrumentation progress helper (legacy)
function emitInstrumentationProgress(win, filePath, pct, label = null) {
  if (win) {
    win.webContents.send('instrumentation:progress', {
      file: filePath,
      pct: pct,
      label: label
    });
  }
}

// v2.1.0: Run instrumentation analysis with KISS progress checkpoints
async function runInstrumentationAnalysis(filePath, win, audioHints = {}, creativeData = null) {
  try {
    console.log('[INSTRUMENTATION] Starting analysis for:', path.basename(filePath));
    console.log('[INSTRUMENTATION] Full file path:', filePath);
    
    // v3.0.0: Send explicit start event and 0% checkpoint
    if (win) {
      console.log('[INSTRUMENTATION] win exists:', !!win);
      console.log('[INSTRUMENTATION] win.isDestroyed:', win?.isDestroyed?.());
      console.log('[INSTRUMENTATION] webContents exists:', !!win?.webContents);
      console.log('[INSTRUMENTATION] Sending analysis:instrumentation:start event');
      win.webContents.send('analysis:instrumentation:start', { file: filePath });
      console.log('[INSTRUMENTATION] Start event sent');
    } else {
      console.error('[INSTRUMENTATION] No window reference provided!');
    }
    
    // Debug sendInstrProgress window
    const progressWin = BrowserWindow.getAllWindows()[0];
    console.log('[INSTRUMENTATION] sendInstrProgress window exists:', !!progressWin);
    console.log('[INSTRUMENTATION] sendInstrProgress window === win:', progressWin === win);
    
    console.log('[INSTRUMENTATION] Sending 0% progress event');
    sendInstrProgress(filePath, 0, "processing");
    console.log('[INSTRUMENTATION] 0% progress event sent');
    
    // v1.5.0: Prepare creative hints for fallback if available
    const creativeHints = creativeData ? { suggestedInstruments: creativeData.suggestedInstruments || [] } : {};
    if (creativeHints.suggestedInstruments && creativeHints.suggestedInstruments.length > 0) {
      console.log(`[INSTRUMENTATION] Passing ${creativeHints.suggestedInstruments.length} creative suggestions for fallback`);
    }
    
    // Run ensemble analysis with progress callbacks and creative hints
    const result = await analyzeWithEnsemble(filePath, { 
      demucs: true,
      creativeHints: creativeHints,
      progressCallback: (pct, stage) => {
        // Map ensemble progress to our KISS checkpoints
        if (pct >= 25) sendInstrProgress(filePath, 25); // After Demucs
        if (pct >= 50) sendInstrProgress(filePath, 50); // After PANNs
        if (pct >= 75) sendInstrProgress(filePath, 75); // After YAMNet
      }
    });
    
    // 100% - Complete
    sendInstrProgress(filePath, 100);
    
    return result;
  } catch (error) {
    console.error('[INSTRUMENTATION] Error:', error);
    sendInstrProgress(filePath, 100);
    return { error: error.message, instruments: [] };
  }
}

// --- ENSEMBLE LOGGING (local, crash-proof) -------------------------------
const LOG_DIR = '/Volumes/ATOM RAID/Dropbox/_Personal Files/12 - AI Vibe Coding/02 - Cursor Projects/02 - RhythmRNA V3/Logs';
function ensureDirSafe(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
function writeJsonSafe(file, obj) {
  try { ensureDirSafe(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (_) {}
}
// [1] ADD these utility defs near the top of the file (after imports/require)
const TAG = '[ENSEMBLE]';
const log  = (...args) => console.log(TAG, ...args);
const warn = (...args) => console.warn(TAG, ...args);
const err  = (...args) => console.error(TAG, ...args);

// --- CREATIVE LOGGING (local, crash-proof) -------------------------------
function _creativeLogDir() {
  // Keep logs alongside the other app logs:
  // app/Logs relative to this file's directory.
  // (Matches the ensemble debug location pattern.)
  return path.resolve(__dirname, "../Logs");
}
function _ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch (_) {}
}
function _stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function _writeCreativeDebug(baseName, contents) {
  const dir = _creativeLogDir();
  _ensureDir(dir);
  const file = path.join(dir, `${baseName}.log`);
  try { fs.writeFileSync(file, contents ?? "", "utf8"); } catch (_) {}
  return file;
}

// Heuristic JSON extractor/repairer:
// - strips code fences
// - extracts the largest {...} block
// - removes trailing commas before } and ]
// - normalizes fancy quotes
// - tries again if the first parse fails
function safeParseCreative(rawText, context = {}) {
  const ctx = {
    file: context.file || "unknown_file",
    model: context.model || "unknown_model",
    temp: context.temp ?? "n/a",
  };

  const stamp = _stamp();
  const base = `creative-raw-${stamp}`;
  _writeCreativeDebug(base, `--- RAW LLM OUTPUT (${ctx.model} @ temp=${ctx.temp}) for ${ctx.file} ---\n${rawText}\n`);

  let t = String(rawText || "");

  // Strip code fences ```json ... ``` or ``` ... ```
  t = t.replace(/```json[\s\S]*?```/gi, m => m.replace(/```json|```/gi, "")).trim();
  t = t.replace(/```[\s\S]*?```/g, m => m.replace(/```/g, "")).trim();

  // Normalize curly quotes to regular quotes
  t = t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

  // If there is extra prose around JSON, grab the largest JSON object substring.
  // Find the first { and last } and slice.
  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    t = t.slice(firstBrace, lastBrace + 1);
  }

  const tryParse = (s) => {
    return JSON.parse(s);
  };

  // First attempt
  try {
    const parsed = tryParse(t);
    _writeCreativeDebug(`${base}-parsed-ok`, JSON.stringify(parsed, null, 2));
    return parsed;
  } catch (e1) {
    // Attempt light repairs, then parse again
    let repaired = t;

    // Remove trailing commas before } or ]
    repaired = repaired.replace(/,\s*([}\]])/g, "$1");

    // Quote unquoted keys (simple, conservative: keys without quotes followed by :)
    // e.g., mood: []  ->  "mood": []
    repaired = repaired.replace(/(\{|,)\s*([A-Za-z0-9_\-]+)\s*:/g, '$1 "$2":');

    // Convert single-quoted strings to double-quoted (avoid touching contractions inside text by doing only JSON-looking segments)
    // This is still heuristic; we keep it limited
    repaired = repaired.replace(/:\s*'([^']*)'/g, ': "$1"');

    try {
      const parsed2 = tryParse(repaired);
      _writeCreativeDebug(`${base}-parsed-repaired-ok`, JSON.stringify(parsed2, null, 2));
      return parsed2;
    } catch (e2) {
      _writeCreativeDebug(`${base}-parse-error`, [
        "--- ORIGINAL TEXT ---",
        t,
        "",
        "--- FIRST ERROR ---",
        String(e1 && e1.stack || e1),
        "",
        "--- REPAIRED TEXT ---",
        repaired,
        "",
        "--- SECOND ERROR ---",
        String(e2 && e2.stack || e2),
        ""
      ].join("\n"));
      const err = new Error("Creative JSON parse failed after repair");
      err._creative_raw_file = `${base}.log`;
      err._creative_err_file = `${base}-parse-error.log`;
      throw err;
    }
  }
}
const ELOG = (...args) => console.log('[ENSEMBLE]', ...args);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const num = v => (isNum(v) ? v : 0);
const get = (obj, key, fallback) => (obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback);

// Safe helpers so undefined never explodes downstream
function safeDict(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
function safeArr(v)  { return Array.isArray(v) ? v : []; }
function safeBool(v) { return Boolean(v); }

// Write a tiny debug file so we can inspect the raw Python JSON quickly
function writeDebugDump(basename, payload) {
  try {
    // Create Logs directory if it doesn't exist
    const logsDir = path.join(__dirname, '..', 'Logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    const outPath = path.join(logsDir, `ensemble-debug-${basename.replace(/\W+/g,'_')}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
    log('debug dump:', outPath);
  } catch (e) {
    warn('debug dump failed:', String(e && e.stack || e));
  }
}

// ---------- [ENSEMBLE RESCUE HELPERS - BEGIN] ----------

const ENSEMBLE_RESCUE_PRIORITY = [
  'Electric Guitar',
  'Acoustic Guitar',
  'Bass Guitar',
  'Drum Kit (acoustic)',
  'Piano',
  'Organ',
  'Brass (section)',
  'Strings',
];

function _bool(v) {
  return !!(v === true || v === 'true' || v === 1 || v === '1' || v === 'yes');
}

function _deriveUsedDemucs(ens) {
  if (!ens || typeof ens !== 'object') return false;
  return _bool(
    ens.usedDemucs ??
    ens.used_demucs ??
    ens.demucsUsed ??
    ens.meta?.used_demucs ??
    ens.meta?.usedDemucs ??
    ens.meta?.demucsUsed
  );
}

// Preferred display names we'll consider when rescuing from AUDIO_PROBE
const PROBE_TO_DISPLAY = {
  'electric guitar': 'Electric Guitar',
  'acoustic guitar': 'Acoustic Guitar',
  'bass': 'Bass Guitar',
  'drumkit': 'Drum Kit (acoustic)',
  'piano': 'Piano',
  'organ': 'Organ',
  // Optional sections (we keep conservative)
  'brass': 'Brass (section)',
  'strings': 'Strings',
};

function _rescueFromProbe(probe) {
  if (!probe || typeof probe !== 'object') return [];
  // probe.detected is already logged as: [AUDIO_PROBE] Detected: a, b, c
  const detected = Array.isArray(probe.detected) ? probe.detected : [];
  if (!detected.length) return [];
  // Map lower-case probe names to display names, filter unknown
  const mapped = [];
  for (const raw of detected) {
    const k = String(raw).toLowerCase();
    if (k in PROBE_TO_DISPLAY) mapped.push(PROBE_TO_DISPLAY[k]);
  }
  // De-dup and sort by rescue priority, cap to 4 to stay conservative
  const uniq = Array.from(new Set(mapped));
  uniq.sort((a, b) => ENSEMBLE_RESCUE_PRIORITY.indexOf(a) - ENSEMBLE_RESCUE_PRIORITY.indexOf(b));
  return uniq.slice(0, 4);
}
// ---------- [ENSEMBLE RESCUE HELPERS - END] ----------

// [2] In the function that runs the Python analyzer (e.g., runEnsemble / analyzeEnsemble / execEnsemble),
//     ensure options and hints are safely defaulted, and remove use of undeclared variables.
async function runEnsemble(audioPath, options = {}) {
  // SAFETY DEFAULTS
  const {
    demucs = false,
    timeoutMs = 120000,
    env = {},
    hints = {},            // <— was throwing "hints is not defined" in some paths
  } = options || {};

  // Use the existing analyzeWithEnsemble function
  const result = await analyzeWithEnsemble(audioPath, { demucs });

  // After the process exits, parse and normalize:
  let raw;
  try {
    raw = result; // result is already parsed JSON from analyzeWithEnsemble
  } catch (e) {
    err('JSON parse failed; result =>', String(result).slice(0, 400));
    throw e;
  }

  // Hard normalization (so later code can't crash)
  const normalized = safeDict(raw);
  const instruments = safeArr(normalized.instruments);
  const by_stem = safeDict(normalized.by_stem);
  const decision = safeDict(normalized.decision_trace);
  const used_demucs = safeBool(normalized.used_demucs);
  const mode = normalized.mode || (used_demucs ? 'stems' : 'mix-only');

  // Emit a compact log and a full dump for this track
  const base = path.basename(audioPath, path.extname(audioPath));
  log(`mode=${mode} used_demucs=${used_demucs} instruments: ${instruments.length ? instruments.join(', ') : '(none)'}`);
  writeDebugDump(base, { parsed: { mode, used_demucs, instruments, by_stem_keys: Object.keys(by_stem), decision_trace_present: !!Object.keys(decision).length }, raw: normalized });

  // [3] NEVER reference undeclared names; only use the locals above.
  //     If you have existing code that logs `usedDemucs` (camelCase), replace it with `used_demucs`.
  //     If you have code that logs with `log(...)`, it now exists (see [1]).

  // [4] Optional: if you still have any "strict empty" guard, gate it so it never throws.
  //     Keep it conservative; do not mutate JSON shape if not needed.
  let finalInstruments = instruments;
  if (!finalInstruments.length) {
    // If Python delivered a suggested rescue list, use it; otherwise leave empty.
    const rescue = safeArr(normalized.rescue || []);
    if (rescue.length) {
      log('mix-only rescue picked:', rescue.join(', '));
      finalInstruments = rescue;
    }
  }

  // Return a stable shape upward (so renderer/db writer can't crash)
  return {
    mode,
    used_demucs,
    instruments: finalInstruments,
    by_stem,
    decision_trace: decision,
  };
}

const pyVenv = path.join(__dirname, 'py', '.venv', 'bin', 'python');
const scriptPath = path.join(__dirname, 'instruments_ensemble.py');
try {
  const st = fs.statSync(scriptPath);
  const head = (() => {
    try {
      const b = fs.readFileSync(scriptPath, {encoding: 'utf8'}).slice(0, 160).replace(/\n/g, ' ↵ ');
      return b;
    } catch { return '(head unreadable)'; }
  })();
  log('scriptPath:', scriptPath);
  log('script mtime:', st.mtime?.toISOString?.() || String(st.mtime));
  log('script head:', head);
} catch (e) {
  warn('cannot stat/read instruments_ensemble.py:', String(e && e.message));
}
const MusicTempo = require('music-tempo');
const http = require('http');
const mm = require('music-metadata');
const { runAudioProbes } = require('./probes/index.js');

// --- Tempo helpers ---
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function roundBpm(n) { return (Number.isFinite(n) && n > 0) ? Math.round(n) : null; }

async function bpmFromWindow(filePath, startSec, durSec) {
  return new Promise((resolve) => {
    const args = [
      '-ss', String(startSec),
      '-t', String(durSec),
      '-i', filePath,
      '-ac', '1',
      '-ar', '44100',
      '-f', 'f32le',
      '-hide_banner', '-loglevel', 'error',
      'pipe:1'
    ];
    const cp = spawn('ffmpeg', args);
    const chunks = [];

    cp.stdout.on('data', c => chunks.push(c));
    cp.stderr.on('data', e => {
      // helpful when windows fail
      const msg = e.toString().trim();
      if (msg) console.log('[FFMPEG]', msg);
    });
    cp.on('error', () => resolve(null));
    cp.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 4) return resolve(null);

        // music-tempo wants a numeric array
        const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        const mt = new MusicTempo(Array.from(f32)); // default constructor
        resolve(roundBpm(mt.tempo));
      } catch {
        resolve(null);
      }
    });
  });
}

function generateCandidates(raw) {
  const r = Number(raw);
  if (!Number.isFinite(r) || r <= 0) return [];
  // explore equivalence around x0.5 / x1 / x2 / x1.5 / x(2/3)
  const cands = [r, r/2, r*2, (3*r)/2, (2*r)/3]
    .map(roundBpm)
    .filter(b => b && b >= 50 && b <= 200);
  return Array.from(new Set(cands));
}

function pickTempo(candidates, hasPerc) {
  if (!candidates.length) return null;

  const score = new Map();
  for (const bpm of candidates) {
    let s = 100;

    // band preference
    if (hasPerc) {
      if (bpm >= 90 && bpm <= 180) s += 40;
    } else {
      if (bpm >= 60 && bpm <= 120) s += 40;
    }

    // gentle pull to common anchors
    const anchors = [60, 75, 90, 100, 110, 120, 128, 140, 150, 160];
    const nearest = anchors.reduce((a, b) => Math.abs(b - bpm) < Math.abs(a - bpm) ? b : a, anchors[0]);
    s += Math.max(0, 20 - Math.abs(nearest - bpm)); // within ±20 → bonus

    score.set(bpm, (score.get(bpm) || 0) + s);
  }

  const best = Math.max(...score.values());
  const tied = [...score.entries()].filter(([,v]) => v === best).map(([k]) => k);
  if (tied.length === 1) return tied[0];

  // tie-break by closeness to median of candidates
  const sorted = candidates.slice().sort((a,b)=>a-b);
  const m = sorted.length % 2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2 - 1] + sorted[sorted.length/2]) / 2;
  return tied.reduce((a,b)=> Math.abs(b - m) < Math.abs(a - m) ? b : a, tied[0]);
}

// Fold any tempo into a sane band so windows are comparable
function foldToRange(bpm, lo = 70, hi = 180) {
  let t = Number(bpm) || 0;
  if (!Number.isFinite(t) || t <= 0) return NaN;
  while (t < lo) t *= 2;
  while (t > hi) t /= 2;
  return t;
}

// Percussion-aware normalization for a single window
function resolveTempoWindow(rawBpm, hasPerc) {
  let t = foldToRange(rawBpm); // 70..180
  if (!Number.isFinite(t)) return NaN;

  // With drums: prefer double-time if folded tempo lands low (70-95)
  if (hasPerc && t >= 70 && t <= 95) {
    const dbl = t * 2;
    if (dbl >= 100 && dbl <= 190) t = dbl;
  }

  // Without drums: prefer half-time if folded tempo lands high (135-170)
  if (!hasPerc && t >= 135 && t <= 170) {
    const half = t / 2;
    if (half >= 68 && half <= 100) t = half;
  }

  // Keep t in reasonable band
  if (t > 190) t = Math.round(t / 2);
  return Math.round(t);
}

async function extractPcmWindow(filePath, startSec, durationSec) {
  const args = [
    '-ss', String(startSec),
    '-t', String(durationSec),
    '-i', filePath,
    '-ac', '1',
    '-ar', '44100',
    '-f', 'f32le',
    '-hide_banner', '-loglevel', 'error',
    'pipe:1'
  ];
  return new Promise((resolve) => {
    const chunks = [];
    const cp = spawn('ffmpeg', args);
    cp.stdout.on('data', (b) => chunks.push(b));
    cp.stderr.on('data', () => {}); // quiet
    cp.on('error', () => resolve(null));
    cp.on('close', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const buf = Buffer.concat(chunks);
        if (buf.length < 8) return resolve(null);
        // Interpret as Float32 PCM
        const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
        resolve(f32);
      } catch {
        resolve(null);
      }
    });
  });
}

async function tempoForWindow(filePath, startSec, durationSec) {
  const pcm = await extractPcmWindow(filePath, startSec, durationSec);
  if (!pcm || pcm.length < 128) return NaN;
  // MusicTempo expects an audio-like envelope; this works fine for coarse BPM
  const mt = new MusicTempo(Array.from(pcm));
  const raw = Number(mt.tempo) || NaN;
  return (Number.isFinite(raw) && raw > 0) ? raw : NaN;
}

// Parse ID3 TBPM safely. Returns an integer BPM (1..399) or null if absent/invalid.
function parseId3BpmSafe(id3Tags) {
  const v = id3Tags?.bpm;
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    const n = Number(v);
    return (Number.isFinite(n) && n > 0 && n < 400) ? Math.round(n) : null;
  }
  if (typeof v === 'string') {
    // Accept strings like "148", "148.2", even "148 bpm"
    const m = v.match(/([0-9]+(?:\.[0-9]+)?)/);
    if (!m) return null;
    const n = Number(m[1]);
    return (Number.isFinite(n) && n > 0 && n < 400) ? Math.round(n) : null;
  }
  return null;
}

// Mutates `analysis` to persist BPM fields and returns a CSV-friendly BPM difference string.
// Safe to call only AFTER `analysis` has been created.
function applyBpmToAnalysis(analysis, finalBpm, id3Tags) {
  if (!analysis) return '';
  if (finalBpm == null || !Number.isFinite(finalBpm)) {
    analysis.estimated_tempo_bpm = null;
    analysis.tempo_bpm = null;
    analysis.bpm = null; // legacy field for downstream writers/logs
    return '';
  }
  const est = Math.round(Number(finalBpm));
  analysis.estimated_tempo_bpm = est;
  analysis.tempo_bpm = est; // keep both names in sync for callers expecting either
  analysis.bpm = est;       // legacy field used by some JSON writers/logs
  const id3Parsed = parseId3BpmSafe(id3Tags);
  if (id3Parsed != null) return Math.abs(id3Parsed - est);
  return '';
}

// --- Fallback: onset/ACF tempo estimator (high-res, no 2/3 folding) ---
// Uses a longer center window and autocorrelation of a simple onset envelope.
// Returns an integer BPM in [50, 200] or null if it cannot estimate.
async function estimateTempoACF(filePath, durationSec, hints = {}) {
  __acfConfidence = null; // reset per call
  const dur = Number(durationSec) || 0;
  const win = Math.min(60, Math.max(20, Math.floor(dur * 0.4))); // 20–60s or ~40% of track
  const start = (dur > win + 10) ? Math.max(0, Math.floor((dur - win) / 2) - 5) : 0;
  const pcm = await extractPcmWindow(filePath, start, win);
  if (!pcm || pcm.length < 2048) return null;

  // ↑ Increase resolution so raw lands closer to the true pulse (e.g., 147–148).
  const DS = 2;                 // was 4 (now ~22.05 kHz)
  const frame = 1024, hop = 256; // was 512 (2× finer hop)
  const SR = 44100 / DS;

  // Downsample (keep it simple and deterministic)
  const dsLen = Math.floor(pcm.length / DS);
  const ds = new Float32Array(dsLen);
  for (let i = 0, j = 0; j < dsLen; i += DS, j++) ds[j] = pcm[i];

  // Simple onset envelope: rectified frame-energy differences
  const nFrames = Math.floor((ds.length - frame) / hop);
  if (nFrames < 10) return null;
  const flux = new Float32Array(nFrames);
  let prevE = 0;
  for (let i = 0; i < nFrames; i++) {
    const off = i * hop;
    let e = 0;
    for (let k = 0; k < frame; k++) e += Math.abs(ds[off + k]);
    const d = e - prevE;
    flux[i] = d > 0 ? d : 0;
    prevE = e;
  }
  // Normalize envelope
  let max = 0;
  for (let i = 0; i < flux.length; i++) if (flux[i] > max) max = flux[i];
  if (max > 0) for (let i = 0; i < flux.length; i++) flux[i] /= max;

  // Autocorrelation across 50–200 BPM
  const fps = SR / hop;
  const minBpm = 50, maxBpm = 200;
  const minLag = Math.floor(fps * 60 / maxBpm);
  const maxLag = Math.floor(fps * 60 / minBpm);
  let bestLag = 0, bestScore = 0, secondScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < flux.length; i++) s += flux[i] * flux[i + lag];
    if (s > bestScore) { secondScore = bestScore; bestScore = s; bestLag = lag; }
    else if (s > secondScore) { secondScore = s; }
  }
  if (!bestLag) return null;
  const bpmRaw = 60 * fps / bestLag;
  // confidence in [0..1]: peak prominence via best/(best+second)
  if (bestScore > 0) {
    __acfConfidence = Math.max(0, Math.min(1, bestScore / (bestScore + (secondScore || 0))));
  }

  // Only allow {raw, half, double}. NO 2/3 or 3/2 folding in fallback.
  const cand = [bpmRaw, bpmRaw * 0.5, bpmRaw * 2]
    .map(v => Math.max(minBpm, Math.min(maxBpm, v)));
  // pick the candidate closest to raw
  let best = cand[0], bestDiff = Math.abs(cand[0] - bpmRaw);
  for (let i = 1; i < cand.length; i++) {
    const d = Math.abs(cand[i] - bpmRaw);
    if (d < bestDiff) { best = cand[i]; bestDiff = d; }
  }

  // Light rock bias: if guitars/brass present and chosen BPM < 110 while raw ≥ 120, snap to raw.
  const rockBias = !!(hints.guitar || hints['electric guitar'] || hints.brass);
  if (best < 110 && bpmRaw >= 120 && rockBias) {
    const snapped = Math.round(bpmRaw);
    console.log(`[TEMPO-ACF] Rock-bias snap ${best.toFixed(0)} → ${snapped} (raw ${bpmRaw.toFixed(1)})`);
    return snapped;
  }
  const out = Math.round(best);
  const c = (__acfConfidence == null) ? '' : `, conf ${__acfConfidence.toFixed(2)}`;
  console.log(`[TEMPO-ACF] Fallback BPM: ${out} (raw ${bpmRaw.toFixed(1)}${c})`);
  return out;
}
async function estimateTempoThirds(filePath, durationSec, hints = {}) {
  const dur = Number(durationSec) || 0;
  if (dur <= 8) return null;
  // constant used only for logging; extractPcmWindow uses -ar 44100
  const __SR = 44100;

  const third = dur / 3;
  const win = clamp(third * 0.25, 8, 30);
  const midOff = (third - win) / 2;

  const windows = [0,1,2].map(i => {
    const start = clamp(i * third + midOff, 0, Math.max(0, dur - win));
    return { start, win };
  });

  let best = null;
  for (let i = 0; i < 3; i++) {
    let thisWin = win;
    let s;
    if (i === 0) {
      s = 0;
    } else if (i === 1) {
      s = Math.max(0, Math.floor((dur - thisWin) / 2));
    } else {
      s = Math.max(0, Math.floor(dur - thisWin));
    }
    let pcm = await extractPcmWindow(filePath, s, thisWin);

    // Log raw sample count and approx seconds for each window
    const secs = pcm ? (pcm.length / __SR) : 0;
    tempoDbg(`[TEMPO-THIRDS] w${i + 1} start=${s}s dur=${thisWin}s samples=${pcm ? pcm.length : 0} (~${secs.toFixed(2)}s)`);

    // If we got a starved window, try a single widen attempt (×1.5 up to 60s)
    if (!pcm || pcm.length < (__SR * 6)) {
      const widened = Math.min(60, Math.floor(thisWin * 1.5));
      if (widened > thisWin) {
        tempoDbg(`[TEMPO-THIRDS] w${i + 1} starving → widen ${thisWin}s → ${widened}s and retry`);
        thisWin = widened;
        if (i === 1) s = Math.max(0, Math.floor((dur - thisWin) / 2));
        if (i === 2) s = Math.max(0, Math.floor(dur - thisWin));
        pcm = await extractPcmWindow(filePath, s, thisWin);
        const secs2 = pcm ? (pcm.length / __SR) : 0;
        tempoDbg(`[TEMPO-THIRDS] w${i + 1} retry samples=${pcm ? pcm.length : 0} (~${secs2.toFixed(2)}s)`);
      }
    }
    if (!pcm || pcm.length < 2048) {
      tempoDbg(`[TEMPO-THIRDS] w${i + 1} empty/too-small after retry, skipping`);
      continue;
    }

    // window-level BPM
    const bpm = await bpmFromWindow(filePath, s, thisWin);
    if (Number.isFinite(bpm) && bpm > 0) {
      if (!best) best = bpm;
      else best = (best + bpm) / 2; // simple average
      tempoDbg(`[TEMPO-THIRDS] w${i + 1} bpm=${Math.round(bpm)} merged=${Math.round(best)}`);
    } else {
      tempoDbg(`[TEMPO-THIRDS] w${i + 1} failed to produce bpm`);
    }
  }

  return best ?? null;
}


// --- helpers (place once) ---
const pickMax = (arr) => arr.length ? Math.max(...arr) : 0;

// Family maps to catch synonyms/sections from CLAP labels
const FAMILY = {
  brass:   ['brass', 'trumpet', 'trombone', 'horn', 'french horn', 'tuba'],
  strings: ['strings', 'string section', 'violin', 'viola', 'cello', 'double bass'],
  drums:   ['drums', 'drumkit', 'snare', 'snare drum', 'tom-tom', 'tom', 'hi-hat', 'kick drum'],
  cymbals: ['cymbal', 'ride cymbal', 'crash cymbal', 'splash cymbal'],
  timpani: ['timpani', 'kettle drum'],
};

function setIf(scores, keys, threshold) {
  return keys.some(k => (scores[k] || 0) >= threshold);
}

// ---------- Instrument mapping & thresholds ----------
const INSTR_ALIASES = new Map([
  // Percussion family & subtypes
  ['drum kit', 'drumkit'], ['drums', 'drumkit'], ['snare drum', 'snare'],
  ['snare', 'snare'], ['cymbal', 'cymbals'], ['cymbals', 'cymbals'],
  ['timpani', 'timpani'], ['orchestral drums', 'timpani'],

  // Brass
  ['brass instrument', 'brass'], ['brass', 'brass'],
  ['trumpet', 'brass'], ['trombone', 'brass'], ['horn', 'brass'], ['french horn', 'brass'],

  // Strings
  ['strings', 'strings'], ['string section', 'strings'],
  ['violin', 'strings'], ['viola', 'strings'], ['cello', 'strings'],
  ['orchestra', 'strings'],

  // Keyboards / guitars / etc.
  ['piano', 'piano'], ['grand piano', 'piano'], ['keyboard', 'keyboard'], ['electric piano', 'keyboard'],
  ['guitar', 'guitar'], ['electric guitar', 'guitar'], ['acoustic guitar', 'guitar'],
  ['bass', 'bass'], ['double bass', 'bass'],
  ['organ', 'organ'], ['synth', 'synth'], ['synth pad', 'synth'],
  ['vocals', 'vocals'], ['voice', 'vocals'], ['singing', 'vocals']
]);

const PERC_SUBTYPES = new Set(['snare', 'cymbals', 'timpani']);
const CLAP_THRESH = { generic: 0.08, perc: 0.06, vocals: 0.13, strong: 0.12 };

// Utility: normalize arbitrary model label to our canonical instrument bucket
function normalizeInstrumentLabel(label) {
  if (!label) return null;
  const s = String(label).toLowerCase().trim();
  if (INSTR_ALIASES.has(s)) return INSTR_ALIASES.get(s);
  // loose contains: map "string section", "french horn", etc.
  for (const [k, v] of INSTR_ALIASES.entries()) {
    if (s.includes(k)) return v;
  }
  return null;
}

// ---- Aggregate CLAP/AST into stable instrument hints ----
function aggregateInstrumentsPerTrack(windows) {
  // windows = [{ clapTop: [{label, score}, ...], astLabels: ['Trumpet','...'] }, ...]
  const voteCount = new Map();     // canonical -> count across windows
  const maxScore  = new Map();     // canonical -> max CLAP score
  const details   = new Set();     // subtypes like snare/cymbals/timpani (if seen anywhere)

  for (const w of windows) {
    const seenThisWindow = new Set();

    // 1) CLAP top-K voting
    for (const it of (w.clapTop || [])) {
      const canon = normalizeInstrumentLabel(it.label);
      if (!canon) continue;
      // collect max score
      maxScore.set(canon, Math.max(maxScore.get(canon) || 0, it.score || 0));
      // per-window single vote per canon
      if (!seenThisWindow.has(canon)) {
        voteCount.set(canon, (voteCount.get(canon) || 0) + 1);
        seenThisWindow.add(canon);
      }
      if (PERC_SUBTYPES.has(canon)) details.add(canon);
    }

    // 2) AST label fallback (keyword contains), low weight → only for details & weak vote
    for (const lbl of (w.astLabels || [])) {
      const canon = normalizeInstrumentLabel(lbl);
      if (!canon) continue;
      // give a weak vote only if we have zero votes so far for this canon
      if (!seenThisWindow.has(canon) && !voteCount.has(canon)) {
        voteCount.set(canon, 1); // single weak vote in the whole track unless CLAP already voted
      }
      if (PERC_SUBTYPES.has(canon)) details.add(canon);
    }
  }

  // 3) Decide presence using thresholds + majority
  const hints = {
    piano: false, guitar: false, bass: false, organ: false, synth: false, keyboard: false,
    brass: false, strings: false, drumkit: false, percussion: false, vocals: false
  };

  const windowsN = Math.max(1, windows.length);
  const present = (canon, minVotes, minScore) =>
    (voteCount.get(canon) || 0) >= minVotes || (maxScore.get(canon) || 0) >= minScore;

  // Pitched families
  hints.piano    = present('piano',   2, CLAP_THRESH.generic);
  hints.guitar   = present('guitar',  2, CLAP_THRESH.generic);
  hints.bass     = present('bass',    2, CLAP_THRESH.generic);
  hints.organ    = present('organ',   2, CLAP_THRESH.generic);
  hints.synth    = present('synth',   2, CLAP_THRESH.generic) || present('keyboard', 2, CLAP_THRESH.generic);
  hints.keyboard = present('keyboard',2, CLAP_THRESH.generic);

  // Orchestral families
  hints.brass    = present('brass',   2, CLAP_THRESH.generic);
  hints.strings  = present('strings', 2, CLAP_THRESH.generic);

  // Percussion families (more forgiving; short transients)
  const percHit  = present('snare', 1, CLAP_THRESH.perc) || present('cymbals', 1, CLAP_THRESH.perc) || present('timpani', 1, CLAP_THRESH.perc);
  hints.percussion = percHit;
  // Drumkit = needs stronger evidence (either majority or strong score)
  hints.drumkit    = present('drumkit', Math.ceil(windowsN * 0.66), CLAP_THRESH.strong);

  // Vocals – be strict (avoid false positives on orchestral cues)
  hints.vocals  = present('vocals', Math.ceil(windowsN * 0.66), CLAP_THRESH.vocals);

  return { hints, details: Array.from(details) };
}




function run(bin, args, { collect = 'stdout' } = {}) {
  return new Promise((resolve, reject) => {
    const cp = spawn(bin, args, { windowsHide: true });
    let out = '', err = '';
    cp.stdout?.on('data', d => (out += d.toString()));
    cp.stderr?.on('data', d => (err += d.toString()));
    cp.on('error', reject);
    cp.on('close', code => {
      if (code !== 0 && collect === 'stdout') return reject(new Error(err || `Exit ${code}`));
      resolve(collect === 'stderr' ? err : out);
    });
  });
}

async function ffprobeJson(filePath) {
  const args = [
    '-v', 'error', '-hide_banner',
    '-print_format', 'json',
    '-show_entries', 'format=duration,bit_rate:stream=index,codec_type,codec_name,sample_rate,channels',
    filePath
  ];
  const out = await run('ffprobe', args);
  const j = JSON.parse(out);
  const fmt = j.format || {};
  const audio = (j.streams || []).find(s => s.codec_type === 'audio') || {};
  
  return {
    duration_sec: Number(fmt.duration || 0),
    bit_rate: Number(fmt.bit_rate || 0),
    sample_rate: Number(audio.sample_rate || 0),
    channels: Number(audio.channels || 0),
    codec: audio.codec_name || 'unknown'
  };
}


// loudness calculation removed for performance




async function checkWavExists(mp3Path) {
  const wavPath = mp3Path.replace(/\.mp3$/i, '.wav');
  try {
    await fsp.access(wavPath);
    return true;
  } catch {
    return false;
  }
}

// Check if Ollama model is installed
async function checkOllamaModel(model) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/tags',
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.models || []).map(m => m.name);
          const hasModel = models.some(m => m === model || m.startsWith(model + ':'));
          console.log(`[OLLAMA] Available models: ${models.join(', ')}`);
          console.log(`[OLLAMA] Requested model '${model}' ${hasModel ? 'found' : 'NOT FOUND'}`);
          resolve(hasModel);
        } catch (e) {
          console.log('[OLLAMA] Failed to check models:', e.message);
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// Full creative analysis with Envato taxonomy
async function runCreativeAnalysis(baseName, bpm, model = 'qwen3:8b', audioHints = null) {
  console.log('[CREATIVE] Running full creative analysis...');
  
  // Check if model is installed
  const modelInstalled = await checkOllamaModel(model);
  if (!modelInstalled) {
    console.log(`[CREATIVE] Model '${model}' not installed. Please run: ollama pull ${model}`);
    return { 
      error: true, 
      offline: false,
      modelMissing: true,
      data: getDefaultCreative() 
    };
  }
  
  // Expanded Envato taxonomy with comprehensive instruments
  const ENVATO_TAXONOMY = {
    mood: ["Upbeat/Energetic", "Happy/Cheerful", "Inspiring/Uplifting", "Epic/Powerful", 
           "Dramatic/Emotional", "Chill/Mellow", "Funny/Quirky", "Angry/Aggressive"],
    genre: ["Cinematic", "Corporate", "Hip hop/Rap", "Rock", "Electronic", "Ambient", "Funk", "Classical"],
    theme: ["Corporate", "Documentary", "Action", "Lifestyle", "Sports", "Drama", "Nature", "Technology"],
    instrument: [
      // Keyboards
      "Piano","Grand Piano","Upright Piano","Electric Piano (Rhodes)","Wurlitzer","Organ (Hammond)","Harpsichord","Clavinet","Celesta",
      // Guitars
      "Acoustic Guitar","12-String Acoustic","Nylon Guitar","Electric Guitar","Electric Guitar (clean)","Electric Guitar (crunch)","Electric Guitar (distorted)","Slide Guitar","Steel Guitar","Banjo","Mandolin","Ukulele",
      // Bass
      "Bass Guitar","Fretless Bass","Upright Bass","Synth Bass","Sub-bass","808 Bass",
      // Drums & Percussion (Acoustic)
      "Drum Kit (acoustic)","Kick","Snare","Hi-hat","Toms","Ride Cymbal","Crash Cymbal",
      // Electronic Drums
      "Drum Machine","808 Kick","808 Snare","Electronic Percussion",
      // Hand Percussion
      "Tambourine","Shaker","Clap","Snap","Cowbell","Woodblock","Triangle",
      "Congas","Bongos","Djembe","Cajon","Timbales","Timpani","Taiko","Frame Drum","Tabla","Udu",
      // Mallet Instruments
      "Glockenspiel","Marimba","Xylophone","Vibraphone","Tubular Bells","Chimes","Handbells",
      // Orchestral Strings
      "Harp","Strings (section)","Violin","Viola","Cello","Double Bass",
      // Brass
      "Brass (section)","Trumpet","Trombone","French Horn","Tuba","Flugelhorn",
      // Woodwinds
      "Woodwinds (section)","Flute","Piccolo","Clarinet","Bass Clarinet","Oboe","English Horn","Bassoon",
      "Saxophone (Alto)","Saxophone (Tenor)","Saxophone (Baritone)",
      // Traditional/Folk
      "Accordion","Harmonica",
      // Synthesizers
      "Synth Lead","Synth Pad","Synth Pluck","Arpeggiator","Sequence","Synth Brass","Synth Strings","FM Synth","Analog Synth","Modular Synth",
      // World Instruments
      "Kalimba (Mbira)","Steelpan (Steel Drum)","Duduk","Ocarina","Pan Flute","Recorder","Sitar","Koto","Shamisen","Erhu","Shakuhachi","Bagpipes","Tin Whistle",
      // Other
      "Bells/Chimes","Choir (as instrument)",
      // Sound Design Elements (optional - can be included or separated)
      "Riser","Uplifter","Downlifter","Whoosh","Impact","Hit","Boom","Sub Drop","Reverse","Swell","Braam","Sweep","Noise FX"
    ],
    vocals: ["No Vocals", "Background Vocals", "Female Vocals", "Lead Vocals", "Vocal Samples", "Male Vocals"],
    // Lyric themes for when vocals are present
    lyricThemes: ["Love/Relationships", "Inspiration/Motivation", "Party/Celebration", "Social Commentary", 
                  "Personal Growth", "Nostalgia/Memory", "Freedom/Independence", "Heartbreak/Loss",
                  "Adventure/Journey", "Dreams/Aspirations", "Rebellion/Protest", "Nature/Environment",
                  "Spirituality/Faith", "Urban Life", "Youth/Coming of Age"]
  };
  
  // Synonym mapping for normalization
  const INSTRUMENT_SYNONYMS = {
    // Piano variations
    "piano": "Piano",
    "grand": "Grand Piano",
    "upright": "Upright Piano",
    "rhodes": "Electric Piano (Rhodes)",
    "wurlie": "Wurlitzer",
    "wurly": "Wurlitzer",
    "hammond": "Organ (Hammond)",
    "organ": "Organ (Hammond)",
    "clav": "Clavinet",
    
    // Guitar variations
    "ac gtr": "Acoustic Guitar",
    "acoustic gtr": "Acoustic Guitar",
    "acoustic": "Acoustic Guitar",
    "12 string": "12-String Acoustic",
    "12string": "12-String Acoustic",
    "classical guitar": "Nylon Guitar",
    "nylon": "Nylon Guitar",
    "spanish guitar": "Nylon Guitar",
    "elec gtr": "Electric Guitar",
    "electric gtr": "Electric Guitar",
    "e-guitar": "Electric Guitar",
    "clean guitar": "Electric Guitar (clean)",
    "crunch guitar": "Electric Guitar (crunch)",
    "dist guitar": "Electric Guitar (distorted)",
    "distorted guitar": "Electric Guitar (distorted)",
    "slide": "Slide Guitar",
    "pedal steel": "Steel Guitar",
    "uke": "Ukulele",
    "ukelele": "Ukulele",
    
    // Bass variations
    "bass": "Bass Guitar",
    "electric bass": "Bass Guitar",
    "fretless": "Fretless Bass",
    "double bass": "Upright Bass",
    "upright": "Upright Bass",
    "acoustic bass": "Upright Bass",
    "sub": "Sub-bass",
    "subbass": "Sub-bass",
    "sub bass": "Sub-bass",
    "synth bass": "Synth Bass",
    "808": "808 Bass",
    "808s": "808 Bass",
    "808 bass": "808 Bass",
    
    // Drums variations
    "drums": "Drum Kit (acoustic)",
    "kit": "Drum Kit (acoustic)",
    "drumkit": "Drum Kit (acoustic)",
    "drum set": "Drum Kit (acoustic)",
    "kick drum": "Kick",
    "kick": "Kick",
    "bass drum": "Kick",
    "bd": "Kick",
    "snare drum": "Snare",
    "sn": "Snare",
    "sd": "Snare",
    "hihat": "Hi-hat",
    "hi hat": "Hi-hat",
    "hh": "Hi-hat",
    "hats": "Hi-hat",
    "claps": "Clap",
    "handclap": "Clap",
    "hand clap": "Clap",
    "perc": "Electronic Percussion",
    "percussion": "Electronic Percussion",
    "909": "Drum Machine",
    "tr909": "Drum Machine",
    "tr808": "Drum Machine",
    "808 drums": "Drum Machine",
    
    // Percussion variations
    "toms": "Toms",
    "tom": "Toms",
    "ride": "Ride Cymbal",
    "crash": "Crash Cymbal",
    "conga": "Congas",
    "bongo": "Bongos",
    "tamb": "Tambourine",
    "shakers": "Shaker",
    "cow bell": "Cowbell",
    
    // Mallet variations
    "glock": "Glockenspiel",
    "vibes": "Vibraphone",
    "vibe": "Vibraphone",
    "tubular bells": "Tubular Bells",
    "bells": "Bells/Chimes",
    "bell": "Bells/Chimes",
    
    // Orchestra variations
    "string section": "Strings (section)",
    "strings": "Strings (section)",
    "string ensemble": "Strings (section)",
    "brass section": "Brass (section)",
    "brass": "Brass (section)",
    "horns": "Brass (section)",
    "horn section": "Brass (section)",
    "sax": "Saxophone (Alto)",
    "alto sax": "Saxophone (Alto)",
    "tenor sax": "Saxophone (Tenor)",
    "bari sax": "Saxophone (Baritone)",
    "woodwind": "Woodwinds (section)",
    "woodwinds": "Woodwinds (section)",
    
    // Synth variations
    "lead": "Synth Lead",
    "lead synth": "Synth Lead",
    "synth lead": "Synth Lead",
    "pad": "Synth Pad",
    "pads": "Synth Pad",
    "synth pad": "Synth Pad",
    "pluck": "Synth Pluck",
    "plucks": "Synth Pluck",
    "synth pluck": "Synth Pluck",
    "arp": "Arpeggiator",
    "arpeggio": "Arpeggiator",
    "arps": "Arpeggiator",
    "seq": "Sequence",
    "sequencer": "Sequence",
    "brass synth": "Synth Brass",
    "synth brass": "Synth Brass",
    "string pad": "Synth Strings",
    "synth strings": "Synth Strings",
    "fm": "FM Synth",
    "fm synth": "FM Synth",
    "analog": "Analog Synth",
    "analogue": "Analog Synth",
    "analog synth": "Analog Synth",
    "modular": "Modular Synth",
    "modular synth": "Modular Synth",
    
    // World instruments
    "kalimba": "Kalimba (Mbira)",
    "mbira": "Kalimba (Mbira)",
    "steel drum": "Steelpan (Steel Drum)",
    "steel drums": "Steelpan (Steel Drum)",
    "steelpan": "Steelpan (Steel Drum)",
    
    // Sound Design
    "riser": "Riser",
    "risers": "Riser",
    "uplift": "Uplifter",
    "uplifter": "Uplifter",
    "downlift": "Downlifter",
    "downlifter": "Downlifter",
    "swoosh": "Whoosh",
    "woosh": "Whoosh",
    "slam": "Impact",
    "hit": "Hit",
    "hits": "Hit",
    "boom": "Boom",
    "booms": "Boom",
    "subdrop": "Sub Drop",
    "sub drop": "Sub Drop",
    "reverse cymbal": "Reverse",
    "reverse": "Reverse",
    "braams": "Braam",
    "braam": "Braam",
    "noise": "Noise FX",
    "noise fx": "Noise FX"
  };
  
  // Normalization function
  function normalizeInstruments(list = []) {
    const norm = s => String(s || "").trim().toLowerCase();
    
    // Build canonical set for validation
    const canonicalSet = new Set(ENVATO_TAXONOMY.instrument.map(norm));
    
    const normalized = [];
    for (const raw of list) {
      if (!raw) continue;
      
      const key = norm(raw);
      // First try synonym mapping
      let mapped = INSTRUMENT_SYNONYMS[key];
      
      // If no synonym match, use original if it's in canonical set
      if (!mapped) {
        const found = ENVATO_TAXONOMY.instrument.find(i => norm(i) === key);
        if (found) mapped = found;
      }
      
      // Validate and add
      if (mapped && canonicalSet.has(norm(mapped))) {
        normalized.push(mapped);
      }
    }
    
    // De-duplicate while preserving order
    const seen = new Set();
    return normalized.filter(x => {
      if (seen.has(x)) return false;
      seen.add(x);
      return true;
    });
  }
  
  // SEPARATE Vocal synonyms map - DO NOT mix with instruments
  const VOCAL_SYNONYMS = {
    "lead vocal": "Lead Vocals",
    "lead singer": "Lead Vocals",
    "singer": "Lead Vocals",
    "vox": "Lead Vocals",
    "lead vox": "Lead Vocals",
    "main vocal": "Lead Vocals",
    "male vocal": "Male Vocals",
    "male singer": "Male Vocals",
    "female vocal": "Female Vocals",
    "female singer": "Female Vocals",
    "backing vocals": "Background Vocals",
    "backing vocal": "Background Vocals",
    "bg vocals": "Background Vocals",
    "vocal sample": "Vocal Samples",
    "vocal chops": "Vocal Samples"
  };

  // Build comprehensive prompt with expanded taxonomy
  const systemPrompt = `You are a JSON API. Output ONLY valid JSON, no prose, no code fences. You are an expert music analyst. Analyze the track based on its metadata and categorize it using ONLY these specific values:

MOOD options: ${ENVATO_TAXONOMY.mood.join(', ')}
GENRE options: ${ENVATO_TAXONOMY.genre.join(', ')}
THEME options: ${ENVATO_TAXONOMY.theme.join(', ')}
INSTRUMENT options: ${ENVATO_TAXONOMY.instrument.join(', ')}
VOCALS options: ${ENVATO_TAXONOMY.vocals.join(', ')}
LYRIC THEMES (if vocals present): ${ENVATO_TAXONOMY.lyricThemes.join(', ')}

Return ONLY a JSON object with this exact structure:
{
  "mood": ["1-3 moods from the list above"],
  "genre": ["1-2 genres from the list above"],
  "theme": ["1-2 themes from the list above"],
  "instrument": ["3-6 PRIMARY instruments only from the list above"],
  "vocals": ["MUST be one or more from: No Vocals, Background Vocals, Female Vocals, Male Vocals, Lead Vocals, Vocal Samples"],
  "lyricThemes": ["1-2 lyric themes IF vocals are present, otherwise empty array"],
  "narrative": "A compelling 40-80 word description of the track's musical character, emotional impact, and sonic qualities",
  "confidence": 0.85
}

CRITICAL: 
- Use ONLY the exact values from the lists provided
- For instruments, be comprehensive and include all detected instruments
- Common variations like "drums", "bass", "piano" should map to their proper names from the list
- Include both primary and secondary instruments
- If you detect synthesizers, specify the type (Synth Pad, Synth Lead, etc.)
 - For vocals: ALWAYS include at least one vocal type. If no vocals detected, use ["No Vocals"]
 - If vocals are present, be specific: use "Lead Vocals" for main vocals, add "Male Vocals" or "Female Vocals" if identifiable
 - Include lyricThemes ONLY if vocals are NOT "No Vocals", otherwise use empty array
 - confidence must be a decimal number from 0.0 to 1.0 (do NOT use percentages like "85%")
 - Never leave vocals array empty
Return ONLY valid JSON, no other text. Do not include comments or trailing commas.`;

  const userPrompt = `Analyze this track:
Title: "${baseName}"
Tempo: ${bpm || 'Unknown'} BPM
${audioHints ? `
Audio analysis detected these elements (from actual audio):
${Object.entries(audioHints).filter(([k,v]) => v).map(([k]) => k).join(', ')}
Please include these in your analysis where appropriate.
` : ''}
Based on the title and technical characteristics, provide your creative analysis. Be thorough in identifying instruments.`;

  // Use the model passed from settings, with lower temperature for advanced models
  const isAdvancedModel = model.includes('qwen2.5') || model.includes('gemma2') || model.includes('mixtral');
  const temperature = isAdvancedModel ? 0.3 : 0.7;
  
  const payload = JSON.stringify({
    model: model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    stream: false,
    format: 'json',
    options: { 
      temperature: temperature,
      top_p: 0.9
    }
  });
  
  console.log(`[CREATIVE] Using model: ${model} (temp: ${temperature})`);

  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          // Log raw response for debugging (small payloads)
          if (data.length < 500) {
            console.log('[CREATIVE] Raw response:', data);
          }
          const parsed = JSON.parse(data);
          
          // Try different response structures
          let content = parsed.message?.content || // chat endpoint
                        parsed.response ||         // generate endpoint
                        parsed.content;            // alternative structure
          
          // Check for error in response
          if (parsed.error) {
            console.log('[CREATIVE] Ollama error:', parsed.error);
            resolve({ error: true, data: getDefaultCreative() });
            return;
          }
          
          if (!content) {
            console.log('[CREATIVE] No content in response. Response keys:', Object.keys(parsed));
            resolve({ error: true, data: getDefaultCreative() });
            return;
          }
          
          // Parse the JSON response
          let creative;
          try {
            creative = safeParseCreative(content, { file: baseName, model: model, temp: temperature });
          } catch (err) {
            console.error("[CREATIVE] JSON parse failed; see creative logs", err && err._creative_err_file ? `(${err._creative_err_file})` : "");
            // Don't crash the pipeline; return a safe default the rest of the app understands
            resolve({
              error: true,
              data: {
                mood: [],
                genre: [],
                theme: [],
                suggestedInstruments: [],
                vocals: [],
                lyricThemes: [],
                narrative: "Creative analysis unavailable",
                confidence: 0,
                __error: "parse_error"
              }
            });
            return;
          }
          
          // Enhanced vocal validation with synonym mapping
          function normalizeVocals(list = []) {
            if (!list || list.length === 0) return ["No Vocals"];
            
            const normalized = [];
            const vocalSet = new Set(ENVATO_TAXONOMY.vocals.map(v => v.toLowerCase()));
            
            for (const raw of list) {
              if (!raw) continue;
              const key = String(raw).trim().toLowerCase();
              
              // First try VOCAL synonym mapping (not instrument!)
              let mapped = VOCAL_SYNONYMS[key];
              
              // If no synonym, check if it's already valid
              if (!mapped && vocalSet.has(key)) {
                mapped = ENVATO_TAXONOMY.vocals.find(v => v.toLowerCase() === key);
              }
              
              if (mapped) normalized.push(mapped);
            }
            
            // Remove duplicates and return
            const unique = Array.from(new Set(normalized));
            return unique.length > 0 ? unique : ["No Vocals"];
          }
          
          // Parse confidence (handle both number and "85%" string format)
          function parseConfidence(raw) {
            if (typeof raw === 'number') return raw > 1 ? raw / 100 : raw;
            if (typeof raw === 'string') {
              const cleaned = raw.replace('%', '').trim();
              const num = parseFloat(cleaned);
              if (Number.isFinite(num)) {
                return num > 1 ? num / 100 : num;
              }
            }
            return 0.7; // Default confidence
          }
          
          // Validate and normalize
          const normalizedVocals = normalizeVocals(creative.vocals);
          const hasVocals = !normalizedVocals.includes("No Vocals");
          const MAX_INSTRUMENTS = 8;
          // v1.5.1: Support both 'instrument' (from LLM JSON) and 'suggestedInstruments' (legacy)
          const rawInstruments = normalizeInstruments(creative.suggestedInstruments || creative.instrument || []);
          const validated = {
            mood: (creative.mood || []).filter(m => ENVATO_TAXONOMY.mood.includes(m)),
            genre: (creative.genre || []).filter(g => ENVATO_TAXONOMY.genre.includes(g)),
            theme: (creative.theme || []).filter(t => ENVATO_TAXONOMY.theme.includes(t)),
            suggestedInstruments: rawInstruments.slice(0, MAX_INSTRUMENTS), // cap count
            vocals: normalizedVocals, // Enhanced vocal normalization
            lyricThemes: hasVocals ? (creative.lyricThemes || []).filter(t => ENVATO_TAXONOMY.lyricThemes.includes(t)) : [],
            narrative: String(creative.narrative || 'No description available').slice(0, 200),
            confidence: Math.min(1, Math.max(0, parseConfidence(creative.confidence)))
          };
          
          console.log(`[CREATIVE] Analysis complete - Genre: ${validated.genre.join(', ')}, Mood: ${validated.mood.join(', ')}, Instruments: ${validated.suggestedInstruments.slice(0, 5).join(', ')}${validated.suggestedInstruments.length > 5 ? '...' : ''}`);
          resolve({ error: false, data: validated });
          
        } catch (e) {
          console.log('[CREATIVE] Failed to parse response:', e.message);
          resolve({ error: true, data: getDefaultCreative() });
        }
      });
    });
    req.on('error', (e) => {
      console.log(`[CREATIVE] Ollama connection failed: ${e.message}`);
      resolve({ error: true, offline: true, data: getDefaultCreative() });
    });
    req.write(payload);
    req.end();
  });
}

function getDefaultCreative() {
  return {
    mood: [],
    genre: [],
    theme: [],
    suggestedInstruments: [],
    vocals: [],
    lyricThemes: [],
    narrative: 'Creative analysis unavailable',
    confidence: 0
  };
}

async function analyzeMp3(filePath, win = null, model = 'qwen3:8b', dbFolder = null, settings = null) {
  const baseName = path.basename(filePath, path.extname(filePath));
  // Send technical starting event
  if (win) {
    win.webContents.send('jobProgress', {
      trackId: filePath,
      stage: 'technical',
      status: 'PROCESSING',
      note: 'Running technical analysis...'
    });
  }
  // First get probe and check WAV
  const [probe, hasWav] = await Promise.all([
    ffprobeJson(filePath),
    checkWavExists(filePath)
  ]);
  
  // Run audio probes first (need it for tempo resolution)
  let probes = { status: 'skipped', hints: {} };
  try {
    const durationSec = probe?.duration_sec || 0;
    if (durationSec > 5) {
      console.log('[AUDIO_PROBE] Starting analysis for', baseName);
      probes = await runAudioProbes(filePath, durationSec, baseName);
      console.log('[AUDIO_PROBE] Hints merged:', probes.hints);
      if (probes.status === 'ok' && probes.hints) {
        const detected = Object.entries(probes.hints)
          .filter(([k, v]) => v)
          .map(([k]) => k)
          .join(', ');
        console.log('[AUDIO_PROBE] Detected:', detected);
      }
    }
  } catch (e) {
    console.log('[AUDIO_PROBE] Error:', e.message);
  }
  
  
  // === v1.0.0: Complete Technical analysis (BPM + ID3) first ===
  console.log('[ORCHESTRATION] Audio probes complete, continuing Technical analysis (BPM + ID3)');
  const durSec = probe?.duration_sec || probe?.duration || 0;
  let tempoSource = 'thirds';
  let finalBpm = await estimateTempoThirds(filePath, durSec, probes?.hints || {});
  if (finalBpm == null) {
    console.log('[BPM-FINAL] thirds failed → trying ACF fallback');
    finalBpm = await estimateTempoACF(filePath, durSec, probes?.hints || {});
    tempoSource = 'acf_fallback';
  }
  console.log(`[BPM-FINAL] ${baseName}: ${finalBpm ? finalBpm.toFixed(1) + ' BPM (' + tempoSource + ')' : 'NULL'}`);

  
  // Extract ID3 tags
  let id3Tags = {};
  try {
    const metadata = await mm.parseFile(filePath);
    const findFrame = (id) => {
      for (const version of ['ID3v2.4', 'ID3v2.3', 'ID3v2.2']) {
        const frame = metadata.native?.[version]?.find?.(t => t.id === id);
        if (frame) return frame.value;
      }
      return null;
    };

    id3Tags = {
      title: metadata.common.title || baseName,
      artist: metadata.common.artist || '',
      album: metadata.common.album || '',
      albumartist: metadata.common.albumartist || '',
      year: metadata.common.year || null,
      genre: metadata.common.genre || [],
      track: metadata.common.track?.no || null,
      comment: (metadata.common.comment && metadata.common.comment[0]) || '',
      bpm: findFrame('TBPM') ? parseFloat(findFrame('TBPM')) : null,
      key: findFrame('TKEY') || '',
      composer: (metadata.common.composer && metadata.common.composer[0]) || '',
      copyright: metadata.common.copyright || '',
      encodedby: metadata.common.encodedby || '',
      mood: findFrame('TMOO') || '',
      energy: findFrame('TENE') || ''
    };
    console.log('[ID3] Tags extracted:', JSON.stringify(id3Tags, null, 2));
  } catch (e) {
    console.log('[ID3] Failed to extract tags:', e.message);
  }

  
  // === v1.2.0: Technical complete - return immediately, run Creative/Instrumentation in background ===
  console.log('[ORCHESTRATION] Technical complete (BPM + ID3), starting background phases');
  if (win) {
    win.webContents.send('jobProgress', {
      trackId: filePath,
      stage: 'technical',
      status: 'COMPLETE',
      note: 'Technical analysis complete - background phases starting'
    });
    win.webContents.send('jobProgress', {
      trackId: filePath,
      stage: 'creative',
      status: 'PROCESSING',
      note: 'Starting creative analysis with Ollama...'
    });
  }
  const dir = path.dirname(filePath);
  
  // v1.2.0: Enqueue background processing with concurrency control
  enqueueBackgroundTask(() => completeAnalysisInBackground(filePath, win, model, dbFolder, settings, {
    baseName,
    probe,
    hasWav,
    probes,
    finalBpm,
    tempoSource,
    id3Tags,
    durSec
  }));
  
  // Return immediately with partial (technical-only) result
  const partialAnalysis = {
    file: baseName,
    path: filePath,
    analyzed_at: new Date().toISOString(),
    duration_sec: durSec,
    sample_rate_hz: probe?.sample_rate_hz || probe?.sample_rate || null,
    channels: probe?.channels || null,
    bit_rate: probe?.bit_rate || null,
    title: id3Tags.title || baseName,
    id3: id3Tags,
    has_wav_version: hasWav,
    ...probe,
    estimated_tempo_bpm: finalBpm,
    tempo_bpm: finalBpm,
    bpm: finalBpm,
    tempo_source: tempoSource,
    __phase__: 'TECHNICAL_ONLY',
    __background_processing__: true
  };
  
  return { 
    analysis: partialAnalysis, 
    jsonPath: path.join(dir, `${baseName}.json`),
    csvPath: null,
    backgroundProcessing: true
  };
}

// v1.2.0: Background completion handler for Creative + Instrumentation phases
async function completeAnalysisInBackground(filePath, win, model, dbFolder, settings, techData) {
  let { baseName, probe, hasWav, probes, finalBpm, tempoSource, id3Tags, durSec } = techData;
  const dir = path.dirname(filePath);
  
  console.log('[BACKGROUND] Starting Creative + Instrumentation for:', baseName);
  console.log(`[ORCHESTRATION] Mode: ${INSTRUMENTATION_MODE}`);
  
  let creativeResult, instrumentationResult;
  
  if (INSTRUMENTATION_MODE === "SEQUENTIAL") {
    // Sequential: Run Creative first, then Instrumentation
    console.log('[ORCHESTRATION] Running SEQUENTIAL: Creative → Instrumentation');
    
    creativeResult = await runCreativeAnalysis(
      baseName,
      finalBpm,
      model,
      probes.hints || {}
    );
    console.log('[ORCHESTRATION] Creative complete, starting Instrumentation...');
    
    // v1.5.0: Pass creative suggestions to instrumentation for fallback
    instrumentationResult = await runInstrumentationAnalysis(filePath, win, probes.hints || {}, creativeResult.data);
    console.log('[ORCHESTRATION] Instrumentation complete');
  } else {
    // Concurrent (default): Creative starts first, Instrumentation starts after creative completes
    // This ensures creative suggestions are available for instrumentation fallback
    console.log('[ORCHESTRATION] Running CONCURRENT: Creative (fast) → Instrumentation (slower)');
    
    creativeResult = await runCreativeAnalysis(
      baseName,
      finalBpm,
      model,
      probes.hints || {}
    );
    console.log('[ORCHESTRATION] Creative complete, starting Instrumentation with creative hints');
    
    // v1.5.0: Pass creative suggestions to instrumentation for fallback
    instrumentationResult = await runInstrumentationAnalysis(filePath, win, probes.hints || {}, creativeResult.data);
    console.log('[ORCHESTRATION] Instrumentation complete');
  }
  
  console.log('[ORCHESTRATION] All analysis phases complete');
  
  // === BPM OVERRIDE: Apply ID3 BPM override BEFORE building analysis object ===
  const __id3Parsed = parseId3BpmSafe(id3Tags);
  if (__id3Parsed != null) {
    if (finalBpm !== __id3Parsed) {
      console.log(`[BPM-FINAL] Overriding with ID3 TBPM ${__id3Parsed} (was ${finalBpm ?? 'NULL'})`);
      finalBpm = __id3Parsed;
      tempoSource = 'id3';
    } else {
      console.log(`[BPM-FINAL] ID3 TBPM matches estimate: ${__id3Parsed}`);
    }
  }
  
  // Compute alternative tempos AFTER override
  const __half = (Number.isFinite(finalBpm) ? Math.round(finalBpm * 0.5) : null);
  const __dbl  = (Number.isFinite(finalBpm) ? Math.round(finalBpm * 2)   : null);
  const altHalf = (Number.isFinite(__half) && __half >= 50 && __half <= 200) ? __half : '';
  const altDbl  = (Number.isFinite(__dbl)  && __dbl  >= 50 && __dbl  <= 200) ? __dbl  : '';
  // === END BPM OVERRIDE ===
  
  // Process creative results
  let creative = (creativeResult && creativeResult.data) || {};
  let creativeStatus = creativeResult.modelMissing
    ? `Model '${model}' not installed - run: ollama pull ${model}`
    : creativeResult.offline 
    ? 'Ollama offline - creative analysis skipped'
    : creativeResult.error
    ? 'Creative analysis error - using defaults'
    : 'Creative analysis complete';
  
  // Send creative complete event
  if (win && !win.isDestroyed()) {
    win.webContents.send('jobProgress', {
      trackId: filePath,
      stage: 'creative',
      status: creativeResult.error ? 'ERROR' : 'COMPLETE',
      note: creativeStatus
    });
  }
  
  // Aggregate CLAP/AST into stable instrument hints
  if (probes && probes.windowsProbes) {
    const agg = aggregateInstrumentsPerTrack(probes.windowsProbes);
    probes.hints = agg.hints;
    probes.details = agg.details;
    const ensure = (arr, val) => { if (!arr.includes(val)) arr.push(val); };
    creative.suggestedInstruments = creative.suggestedInstruments || [];
    if (agg.hints.strings)  ensure(creative.suggestedInstruments, 'Strings (section)');
    if (agg.hints.brass)    ensure(creative.suggestedInstruments, 'Brass (section)');
    if (agg.hints.timpani)  ensure(creative.suggestedInstruments, 'Timpani');
    if (agg.hints.drumkit)  ensure(creative.suggestedInstruments, 'Snare Drum');
    if (agg.hints.cymbals)  ensure(creative.suggestedInstruments, 'Cymbals');
  }
  
  // Optional orchestral instrument hints augmentation
  function _augmentOrchestralInstruments(probeResult) {
    const labels = new Set([
      ...(probeResult.raw_labels?.intro || []),
      ...(probeResult.raw_labels?.middle || []),
      ...(probeResult.raw_labels?.outro || [])
    ].map(s => String(s).toLowerCase()));
    const has = (needle) => [...labels].some(l => l.includes(needle));
    const out = new Set(creative?.suggestedInstruments || []);
    if (probeResult.hints?.strings || has('string') || has('violin') || has('orchestra')) out.add('Strings (section)');
    if (probeResult.hints?.brass   || has('brass') || has('trumpet') || has('trombone') || has('horn')) out.add('Brass (section)');
    if (has('timpani') || has('kettle drum') || has('low tom')) out.add('Timpani');
    if (has('snare') || has('march')) out.add('Snare');
    if (has('cymbal') || has('crash') || has('splash') || has('ride') || has('hi-hat')) out.add('Cymbals');
    creative.suggestedInstruments = Array.from(out);
  }
  _augmentOrchestralInstruments(probes);
  
  // Generate pretty instrument list
  const prettyOrder = ['brass','strings','timpani','snare','cymbals','drumkit','piano','guitar','bass','organ','synth'];
  const prettyNames = { drumkit:'Drum Kit', cymbals:'Cymbals', snare:'Snare', timpani:'Timpani',
    brass:'Brass', strings:'Strings', piano:'Piano', guitar:'Guitar', bass:'Bass', organ:'Organ', synth:'Synth' };
  const listed = [];
  for (const key of prettyOrder) {
    if (probes.hints && probes.hints[key]) listed.push(prettyNames[key]);
  }
  for (const d of (probes.details || [])) {
    const name = prettyNames[d];
    if (name && !listed.includes(name)) listed.push(name);
  }
  
  // Build analysis object with corrected BPM values
  const analysis = {
    file: baseName,
    path: filePath,
    analyzed_at: new Date().toISOString(),
    duration_sec: durSec,
    sample_rate_hz: probe?.sample_rate_hz || probe?.sample_rate || null,
    channels: probe?.channels || null,
    bit_rate: probe?.bit_rate || null,
    title: id3Tags.title || baseName,
    id3: id3Tags,
    has_wav_version: hasWav,
    ...probe,
    audio_probes: probes.hints || {},
    creative: creative,
    creative_status: creativeStatus,
    estimated_tempo_bpm: finalBpm,
    tempo_bpm: finalBpm,
    bpm: finalBpm,
    tempo_source: tempoSource,
    tempo_alt_half_bpm: altHalf !== '' ? altHalf : undefined,
    tempo_alt_double_bpm: altDbl !== '' ? altDbl : undefined,
    detected_instruments: listed
  };
  
  // Canonical UI labels
  const DISP = {
    'electric guitar': 'Electric Guitar',
    'guitar': 'Electric Guitar',
    'acoustic guitar': 'Acoustic Guitar',
    'bass': 'Bass Guitar',
    'drumkit': 'Drum Kit (acoustic)',
    'piano': 'Piano',
    'organ': 'Organ',
    'strings': 'Strings',
    'brass': 'Brass (section)'
  };
  
  // Use instrumentation results
  const usedDemucs = Boolean(instrumentationResult && (instrumentationResult.used_demucs || instrumentationResult.usedDemucs));
  const instrumentsFromPy = Array.isArray(instrumentationResult?.instruments) ? instrumentationResult.instruments : [];
  const decisionTrace = instrumentationResult?.decision_trace && typeof instrumentationResult.decision_trace === 'object' ? instrumentationResult.decision_trace : null;
  const finalInstruments = instrumentsFromPy.slice();
  
  console.log(`[ENSEMBLE] mode=${usedDemucs ? 'stems' : 'mix-only'} instruments: ${finalInstruments.length ? finalInstruments.join(', ') : '(none)'}`);
  
  analysis.instruments = finalInstruments;
  analysis.instruments_ensemble = {
    used_demucs: usedDemucs,
    mode: usedDemucs ? 'stems' : 'mix-only',
    decision_trace: decisionTrace,
  };
  
  if (instrumentationResult?.electronic_elements) {
    analysis.instruments_ensemble.electronic_elements = instrumentationResult.electronic_elements;
  }
  if (instrumentationResult?.__electronic_detection_code_reached__) {
    analysis.instruments_ensemble.__electronic_detection_code_reached__ = instrumentationResult.__electronic_detection_code_reached__;
  }
  
  if (analysis.instruments_ensemble?.electronic_elements && analysis.creative?.genre) {
    try {
      const electronicData = analysis.instruments_ensemble.electronic_elements;
      const genres = analysis.creative.genre || [];
      const electronicGenres = ["Electronic", "Cinematic", "Ambient", "Synthwave", "EDM"];
      const hasElectronicGenre = genres.some(g => electronicGenres.includes(g));
      if (hasElectronicGenre && electronicData.confidence === "low") {
        electronicData.confidence = "medium";
        electronicData.reasons.push(`Creative analysis confirms electronic genre: ${genres.filter(g => electronicGenres.includes(g)).join(', ')}`);
      }
    } catch (e) {
      console.log('[ELECTRONIC] Failed to enhance detection with creative data:', e.message);
    }
  }
  
  delete analysis.detected_instruments;
  delete analysis.audio_probes;
  
  // Finalize instruments
  try {
    const finalizeModule = require('./finalize_instruments');
    const finalizeInstruments = finalizeModule && (finalizeModule.finalizeInstruments || finalizeModule.default || finalizeModule);
    if (typeof finalizeInstruments === 'function') {
      analysis.finalInstruments = finalizeInstruments({
        ensembleInstruments: Array.isArray(analysis.instruments) ? analysis.instruments : [],
        probeRescues: Array.isArray(analysis.probe_rescues) ? analysis.probe_rescues : [],
        additional: Array.isArray(analysis.additional) ? analysis.additional : []
      });
    } else {
      analysis.finalInstruments = Array.isArray(analysis.instruments) ? analysis.instruments : [];
    }
  } catch (err) {
    console.warn('[FFCALC] finalizeInstruments failed:', err.message || String(err));
    analysis.finalInstruments = Array.isArray(analysis.instruments) ? analysis.instruments : [];
  }
  
  console.log(`[FFCALC] finalized instruments -> ${Array.isArray(analysis.finalInstruments) ? analysis.finalInstruments.join(', ') : '(none)'}`);
  
  // Write JSON
  const jsonPath = path.join(dir, `${baseName}.json`);
  console.log(`[TEMPO DEBUG] Saving BPM to JSON for ${baseName}: ${analysis.estimated_tempo_bpm}`);
  await fsp.writeFile(jsonPath, JSON.stringify(analysis, null, 2));
  
  // CSV writing
  let csvPath = null;
  if (shouldWriteCsv(settings)) {
    try {
      csvPath = path.join(dir, `${baseName}.csv`);
      const formatDuration = (seconds) => {
        if (!seconds) return '';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
      };
      const csvRows = [
        ['Title', baseName],
        ['', ''],
        ['--- ID3 Tags ---', ''],
        ['Track Title', id3Tags.title || ''],
        ['Artist', id3Tags.artist || ''],
        ['Album', id3Tags.album || ''],
        ['Year', id3Tags.year || ''],
        ['Tagged Genre', (id3Tags.genre || []).join(', ')],
        ['Tagged BPM', id3Tags.bpm || ''],
        ['File Path', filePath],
        ['Has WAV Version', hasWav ? 'Yes' : 'No'],
        ['Duration (seconds)', analysis.duration_sec || ''],
        ['Sample Rate (Hz)', analysis.sample_rate || ''],
        ['Channels', analysis.channels === 2 ? 'Stereo' : analysis.channels === 1 ? 'Mono' : analysis.channels || ''],
        ['Estimated BPM', (analysis.estimated_tempo_bpm ?? '')],
        ['Tempo Confidence (0–1)', (analysis.tempo_confidence ?? '')],
        ['Tempo Source', analysis.tempo_source || ''],
        ['Alt Tempo (half)', analysis.tempo_alt_half_bpm || ''],
        ['Alt Tempo (double)', analysis.tempo_alt_double_bpm || ''],
        ['', ''],
        ['--- Creative Analysis ---', ''],
        ['Genre', (analysis.creative?.genre || []).join(', ')],
        ['Mood', (analysis.creative?.mood || []).join(', ')],
        ['Theme', (analysis.creative?.theme || []).join(', ')],
        ['Instruments', (analysis.creative?.suggestedInstruments || []).join(', ')],
        ['Vocals', (analysis.creative?.vocals || []).join(', ')],
        ['Lyric Themes', (analysis.creative?.lyricThemes || []).join(', ')],
        ['Description', analysis.creative?.narrative || ''],
        ['Confidence', `${Math.round((analysis.creative?.confidence || 0) * 100)}%`]
      ];
      const csvContent = csvRows
        .map(([field, value]) => `${field},"${value}"`)
        .join('\n');
      await fsp.writeFile(csvPath, csvContent);
      console.log("[CSV] Wrote:", csvPath);
    } catch (e) {
      console.warn("[CSV] Failed to write CSV:", e?.message || e);
    }
  } else {
    console.log("[CSV] Skipped (disabled via settings)");
  }
  
  // Generate waveform PNG
  if (dbFolder) {
    try {
      const { ensureWaveformPng } = require('./waveform-png.js');
      const waveformResult = await ensureWaveformPng(filePath, {
        dbFolder: dbFolder,
        durationSec: analysis.duration_sec
      });
      analysis.waveform_png = waveformResult.pngPath;
      await fsp.writeFile(jsonPath, JSON.stringify(analysis, null, 2));
    } catch (e) {
      console.log('[WAVEFORM] PNG generation failed:', e.message);
    }
  }
  
  // Update database
  if (dbFolder && settings) {
    try {
      const DB = require('../db/jsondb.js');
      const dbPaths = {
        main: path.join(dbFolder, 'RhythmDB.json'),
        criteria: path.join(dbFolder, 'CriteriaDB.json')
      };
      const dbResult = await DB.upsertTrack(dbPaths, analysis);
      console.log('[BACKGROUND] DB updated:', dbResult.key, 'Total tracks:', dbResult.total);
      if (settings.autoUpdateDb) {
        const criteriaResult = await DB.rebuildCriteria(dbPaths);
        console.log('[BACKGROUND] Criteria auto-updated:', criteriaResult.counts);
      }
    } catch (e) {
      console.error('[BACKGROUND] DB upsert failed:', e);
    }
  }
  
  // Send completion event
  console.log('[BACKGROUND] Analysis complete for:', baseName);
  if (win && !win.isDestroyed()) {
    win.webContents.send('track:complete', {
      filePath,
      analysis,
      jsonPath,
      csvPath
    });
    win.webContents.send('jobProgress', {
      trackId: filePath,
      stage: 'all',
      status: 'COMPLETE',
      note: 'All phases complete'
    });
  }
}

module.exports = { analyzeMp3 };


