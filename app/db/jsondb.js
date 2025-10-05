// app/db/jsondb.js — JSON database for local storage
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function normalizeKey(pth) {
  if (!pth) return '';
  let n = path.normalize(pth);
  n = n.replace(/\\/g, '/');
  return n.toLowerCase();
}

async function readJsonSafe(file, fallback) {
  try {
    const s = await fsp.readFile(file, 'utf8');
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function writeJsonSafe(file, obj) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, file);
}

function defaultCriteria() {
  return {
    genre: [],
    mood: [],
    instrument: [],
    vocals: [],
    theme: [],
    tempoBands: [],
    keys: [],
    artists: [],
    electronicElements: []
  };
}

function toArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  return [v];
}

function unionInto(arr, values) {
  const seen = new Set(arr.map(x => String(x)));
  for (const v of values) {
    const s = String(v);
    if (!seen.has(s)) { arr.push(s); seen.add(s); }
  }
  return arr;
}

function tempoToBand(bpm) {
  if (!Number.isFinite(bpm)) return null;
  if (bpm < 60) return 'Very Slow (Below 60 BPM)';
  if (bpm < 90) return 'Slow (60-90 BPM)';
  if (bpm < 110) return 'Medium (90-110 BPM)';
  if (bpm < 140) return 'Upbeat (110-140 BPM)';
  if (bpm < 160) return 'Fast (140-160 BPM)';
  return 'Very Fast (160+ BPM)';
}

function mergeTrack(oldRec = {}, newRec = {}) {
  const out = { ...oldRec };
  
  const scalarKeys = [
    'file','path','analyzed_at','title','artist','waveform_png','duration_sec','sample_rate_hz','channels',
    'bit_rate','lufs_integrated','loudness_range','true_peak_db','estimated_tempo_bpm','key'
  ];
  for (const k of scalarKeys) {
    const nv = newRec[k];
    if (nv !== undefined && nv !== null && nv !== '') out[k] = nv;
  }
  const cOld = oldRec.creative || {};
  const cNew = newRec.creative || {};
  const cOut = { ...cOld };
  
  // Special handling for instruments - priority: analysis.finalInstruments > analysis.instruments > root finalInstruments > root instruments > suggestedInstruments > instrument
  let instrumentsToMerge = null;
  
  // Priority 1: analysis.finalInstruments (canonicalized, deduplicated from ensemble)
  if (newRec.analysis?.finalInstruments && Array.isArray(newRec.analysis.finalInstruments) && newRec.analysis.finalInstruments.length > 0) {
    instrumentsToMerge = newRec.analysis.finalInstruments;
  }
  // Priority 2: analysis.instruments (raw from ensemble)
  else if (newRec.analysis?.instruments && Array.isArray(newRec.analysis.instruments) && newRec.analysis.instruments.length > 0) {
    instrumentsToMerge = newRec.analysis.instruments;
  }
  // Priority 3: root finalInstruments (legacy location)
  else if (newRec.finalInstruments && Array.isArray(newRec.finalInstruments) && newRec.finalInstruments.length > 0) {
    instrumentsToMerge = newRec.finalInstruments;
  }
  // Priority 4: root instruments (legacy location)
  else if (newRec.instruments && Array.isArray(newRec.instruments) && newRec.instruments.length > 0) {
    instrumentsToMerge = newRec.instruments;
  }
  // Priority 5: creative.suggestedInstruments (from LLM)
  else if (cNew.suggestedInstruments && Array.isArray(cNew.suggestedInstruments) && cNew.suggestedInstruments.length > 0) {
    instrumentsToMerge = cNew.suggestedInstruments;
  }
  // Priority 6: creative.instrument (legacy)
  else if (cNew.instrument) {
    instrumentsToMerge = cNew.instrument;
  }
  // Fallback: empty array
  else {
    instrumentsToMerge = [];
  }
  
  for (const k of ['genre','mood','vocals','theme']) {
    const a = toArray(cOld[k]);
    const b = toArray(cNew[k]);
    cOut[k] = unionInto(a.slice(), b);
  }
  
  // Handle instruments separately with the extracted data
  const a = toArray(cOld.instrument);
  const b = toArray(instrumentsToMerge);
  cOut.instrument = unionInto(a.slice(), b);
  if (typeof cNew.narrative === 'string' && cNew.narrative.trim()) cOut.narrative = cNew.narrative;
  if (Number.isFinite(cNew.confidence)) cOut.confidence = cNew.confidence;
  out.creative = cOut;
  
  // Handle analysis field - preserve final_instruments and metadata
  if (newRec.analysis) {
    out.analysis = { ...oldRec.analysis, ...newRec.analysis };
    // Ensure final_instruments, __run_id, and __source_flags are preserved
    if (newRec.analysis.final_instruments) out.analysis.final_instruments = newRec.analysis.final_instruments;
    if (newRec.analysis.__run_id) out.analysis.__run_id = newRec.analysis.__run_id;
    if (newRec.analysis.__source_flags) out.analysis.__source_flags = newRec.analysis.__source_flags;
  }
  
  out.updated_at = new Date().toISOString();
  if (!out.created_at) out.created_at = out.analyzed_at || out.updated_at;
  return out;
}

async function getPaths({ dbFolder, userData }) {
  const base = dbFolder && dbFolder.trim() ? dbFolder : path.join(userData, 'rhythmdna-db');
  ensureDir(base);
  return {
    base,
    main: path.join(base, 'RhythmDB.json'),
    criteria: path.join(base, 'CriteriaDB.json')
  };
}

async function loadMain(paths) {
  return readJsonSafe(paths.main, { tracks: {} });
}

async function saveMain(paths, db) {
  return writeJsonSafe(paths.main, db);
}

async function upsertTrack(paths, analysis) {
  const key = normalizeKey(analysis?.path);
  if (!key) throw new Error('analysis.path required for DB key');
  const db = await loadMain(paths);
  const prev = db.tracks[key];
  const merged = mergeTrack(prev, analysis);
  db.tracks[key] = merged;
  await saveMain(paths, db);
  return { key, record: merged, total: Object.keys(db.tracks).length };
}

async function rebuildCriteria(paths) {
  const db = await loadMain(paths);
  const sets = {
    genre: new Set(),
    mood: new Set(),
    instrument: new Set(),
    vocals: new Set(),
    theme: new Set(),
    tempoBands: new Set(),
    keys: new Set(),
    artists: new Set(),
    electronicElements: new Set()
  };
  for (const key of Object.keys(db.tracks)) {
    const t = db.tracks[key];
    const creative = t.creative || (t.analysis && t.analysis.creative) || {};
    const an = t.analysis || {};
    
    // Helper function to add values to sets
    const add = (field, value) => {
      if (value) {
        let normalized = String(value);
        
        // Normalize section tags for instruments (UI display only)
        if (field === 'instrument') {
          normalized = normalized.replace(/\s*\(section\)\s*/i, '');
        }
        
        sets[field].add(normalized);
      }
    };
    
    // Process non-instrument creative fields
    for (const k of ['genre','mood','vocals','theme']) {
      for (const v of toArray(creative[k])) add(k, v);
    }
    
    // instruments — prefer canonical creative.instrument (set by mergeTrack), then analysis fields, then fallbacks
    if (Array.isArray(creative.instrument) && creative.instrument.length) {
      // Priority 1: creative.instrument (set by mergeTrack from finalInstruments/instruments/suggestedInstruments)
      creative.instrument.forEach(v => add('instrument', v));
    } else if (Array.isArray(an.finalInstruments) && an.finalInstruments.length) {
      // Priority 2: analysis.finalInstruments (canonicalized, deduplicated)
      an.finalInstruments.forEach(v => add('instrument', v));
    } else if (Array.isArray(an.instruments) && an.instruments.length) {
      // Priority 3: analysis.instruments (raw from ensemble)
      an.instruments.forEach(v => add('instrument', v));
    } else if (Array.isArray(t.instruments) && t.instruments.length) {
      // Priority 4: top-level instruments (legacy flattened structure)
      t.instruments.forEach(v => add('instrument', v));
    } else if (Array.isArray(an.instruments_ensemble) && an.instruments_ensemble.length) {
      // Priority 5: ensemble-only field (legacy pre-normalization)
      an.instruments_ensemble.forEach(v => add('instrument', v));
    } else if (creative && creative.suggestedInstruments) {
      // Priority 6: creative.suggestedInstruments (last resort: raw LLM output)
      const arr = Array.isArray(creative.suggestedInstruments)
        ? creative.suggestedInstruments
        : String(creative.suggestedInstruments).split(/,|\/|;|\\|·|•/);
      arr.map(s => s.trim()).filter(Boolean).forEach(v => add('instrument', v));
    }
    
    const band = tempoToBand(Number(t.estimated_tempo_bpm));
    if (band) sets.tempoBands.add(band);
    if (t.key) sets.keys.add(String(t.key));
    if (t.artist) sets.artists.add(String(t.artist));
    
    // Electronic elements detection
    const elec = an.instruments_ensemble?.electronic_elements;
    if (elec && elec.detected) {
      sets.electronicElements.add('Yes');
    } else if (elec) {
      sets.electronicElements.add('No');
    }
  }
  const crit = defaultCriteria();
  for (const k of Object.keys(crit)) {
    crit[k] = Array.from(sets[k]).sort((a,b) => a.localeCompare(b));
  }
  await writeJsonSafe(paths.criteria, crit);
  return { counts: Object.fromEntries(Object.entries(crit).map(([k,v]) => [k, v.length])) };
}

async function getCriteria(paths) {
  const crit = await readJsonSafe(paths.criteria, defaultCriteria());
  return crit;
}

async function getSummary(paths) {
  const db = await loadMain(paths);
  const crit = await getCriteria(paths);
  return {
    totalTracks: Object.keys(db.tracks).length,
    criteriaCounts: Object.fromEntries(Object.entries(crit).map(([k,v]) => [k, v.length]))
  };
}

module.exports = {
  getPaths,
  upsertTrack,
  rebuildCriteria,
  getCriteria,
  getSummary
};


