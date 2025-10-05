// Robust JSON repair + parse for creative LLM output
'use strict';

const fs = require('fs');
const path = require('path');

function ensureLogsDir() {
  try {
    const root = path.resolve(__dirname, '..', 'Logs');
    fs.mkdirSync(root, { recursive: true });
    return root;
  } catch (_) {
    return path.resolve(process.cwd(), 'Logs');
  }
}

const LOG_DIR = ensureLogsDir();

function writeDebug(name, data) {
  try {
    fs.writeFileSync(path.join(LOG_DIR, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } catch (_) { /* ignore */ }
}

// Heuristic fixer for common LLM JSON issues:
// - leading/trailing junk outside the outermost {...}
// - trailing commas
// - smart quotes → straight quotes
// - single quotes → double quotes (only when it won't break JSON)
// - unescaped newlines inside strings (best-effort)
function sanitizeJson(raw) {
  let s = String(raw);
  // normalize whitespace
  s = s.replace(/\r\n/g, '\n');
  // strip leading code fences or prose before first {
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  // convert smart quotes to straight quotes
  s = s.replace(/[\u201C\u201D\u301D\u301E]/g, '"').replace(/[\u2018\u2019]/g, "'");
  // remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  // cautiously convert single-quoted keys/strings to double quotes
  // keys: {'key': -> {"key":
  s = s.replace(/([{,\s])'([A-Za-z0-9_\-]+)'\s*:/g, '$1"$2":');
  // strings: : 'value' -> : "value"
  s = s.replace(/:\s*'([^']*)'/g, (_m, g1) => ': "' + g1.replace(/"/g, '\\"') + '"');
  // collapse invalid control characters
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ');
  return s.trim();
}

function safeParse(raw, contextTag = 'creative') {
  writeDebug(`creative-raw-${contextTag}.log`, String(raw));
  try {
    const parsed = JSON.parse(raw);
    writeDebug(`creative-raw-${contextTag}-parsed-ok.log`, parsed);
    return { ok: true, data: parsed };
  } catch (e1) {
    const fixed = sanitizeJson(raw);
    try {
      const parsed = JSON.parse(fixed);
      writeDebug(`creative-raw-${contextTag}-repaired.json`, parsed);
      return { ok: true, data: parsed, repaired: true, error: String(e1?.message || e1) };
    } catch (e2) {
      writeDebug(`creative-raw-${contextTag}-parse-error.log`, {
        error_initial: String(e1?.message || e1),
        error_repaired: String(e2?.message || e2),
        raw_sample: String(raw).slice(0, 1200),
        repaired_sample: fixed.slice(0, 1200),
      });
      return { ok: false, error: `creative JSON parse failed: ${e1?.message || e1} / repaired: ${e2?.message || e2}` };
    }
  }
}

// Minimal schema guard so downstream doesn't explode even if fields are missing
function coerceCreativeSchema(obj) {
  const out = {
    genre: Array.isArray(obj?.genre) ? obj.genre : (obj?.genre ? [obj.genre] : []),
    mood: Array.isArray(obj?.mood) ? obj.mood : (obj?.mood ? [obj?.mood] : []),
    theme: Array.isArray(obj?.theme) ? obj.theme : [],
    suggestedInstruments: Array.isArray(obj?.suggestedInstruments) ? obj.suggestedInstruments : [],
    vocals: Array.isArray(obj?.vocals) ? obj.vocals : [],
    lyricThemes: Array.isArray(obj?.lyricThemes) ? obj.lyricThemes : [],
    narrative: typeof obj?.narrative === 'string' ? obj.narrative : '',
    confidence: Number.isFinite(obj?.confidence) ? obj.confidence : 0.6,
  };
  return out;
}

module.exports = {
  safeParse,
  coerceCreativeSchema,
};
