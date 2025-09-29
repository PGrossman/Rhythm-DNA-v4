const { normalizeKey } = require('../lib/pathNormalize');

/**
 * Case-insensitive unique array filter
 * @param {Array} arr - Input array
 * @returns {Array} Deduplicated array preserving original case
 */
function uniqCI(arr = []) {
  const seen = new Set();
  const out = [];
  for (const v of (arr || [])) {
    if (!v) continue;
    const k = String(v).trim();
    const ck = k.toLowerCase();
    if (!seen.has(ck)) { 
      seen.add(ck); 
      out.push(k); 
    }
  }
  return out;
}

/**
 * Convert technical.audioHints (true values) to instrument names
 * @param {Object} audioHints - Technical audio hints object
 * @returns {Array} Array of instrument names from true hints
 */
function hintsTrueToInstruments(audioHints = {}) {
  const hints = audioHints || {};
  const instruments = [];
  
  // Map from technical hints to display names
  const hintMap = {
    'drumkit': 'Drum Kit (acoustic)',
    'drums': 'Drum Kit (acoustic)',
    'trumpet': 'Trumpet',
    'trombone': 'Trombone',
    'saxophone': 'Saxophone',
    'brass': 'Brass Section',
    'bass': 'Bass Guitar',
    'electric guitar': 'Electric Guitar',
    'guitar': 'Electric Guitar', // fallback for generic guitar
    'piano': 'Piano',
    'strings': 'Strings (section)',
    'woodwinds': 'Woodwinds'
  };
  
  for (const [hint, value] of Object.entries(hints)) {
    if (value === true || value === 'true') {
      const instrument = hintMap[hint.toLowerCase()];
      if (instrument) {
        instruments.push(instrument);
      }
    }
  }
  
  return instruments;
}

/**
 * Merge a per-track JSON into the database state
 * @param {Object} dbState - Database state object with rhythm and criteria properties
 * @param {Object} trackJson - Per-track JSON data
 */
function mergeFromTrackJson(dbState, trackJson) {
  const src = trackJson || {};
  const key = normalizeKey(src?.source?.filePath || src?.source?.fileName || '');
  
  if (!key) {
    console.warn('[DB] Cannot normalize key for track:', src.source);
    return dbState;
  }

  // --- Creative fields (source of truth from per-track JSON) ---
  const creativeRaw = src.creative || {};
  // Some runs used creative.json.{...}; support both:
  const c = (creativeRaw.json && typeof creativeRaw.json === 'object') ? creativeRaw.json : creativeRaw;

  const creative = {
    genre:      uniqCI(c.genre),
    mood:       uniqCI(c.mood),
    instrument: uniqCI(c.instrument),
    vocals:     uniqCI(c.vocals),
    theme:      uniqCI(c.theme || c.lyricThemes), // allow legacy naming
    narrative:  c.narrative || '',
    confidence: (typeof c.confidence === 'number' ? c.confidence : undefined)
  };

  // --- Instrument fallback precedence (instrumentation > analysis > creative > technical.audioHints) ---
  const techMap = hintsTrueToInstruments(src?.technical?.audioHints || {});
  const instFromInstr = Array.isArray(src?.instrumentation?.instruments) ? src.instrumentation.instruments : [];
  const instFromAnalysis = Array.isArray(src?.analysis?.final_instruments) ? src.analysis.final_instruments
                            : Array.isArray(src?.analysis?.instruments) ? src.analysis.instruments : [];
  const instFromCreative = Array.isArray(creative.instrument) ? creative.instrument : [];
  // Base precedence: instrumentation -> analysis -> creative -> technical hints
  let instrumentFallback = uniqCI(
    (instFromInstr.length ? instFromInstr :
     instFromAnalysis.length ? instFromAnalysis :
     instFromCreative.length ? instFromCreative :
     techMap)
  );

  // — Creative-assisted fallback for Brass (safe, reversible) —
  // If creative suggested brass AND PANNs brass mean >= rules.mean_thresh, add canonical "Brass".
  (function creativeBrassFallback() {
    try {
      const creativeSuggest = (src?.creative?.suggestedInstruments || []).map(s => String(s || '').toLowerCase());
      const pannsBrassMean = Number(src?.instruments_ensemble?.decision_trace?.per_model?.panns?.mean_probs?.brass || 0);
      const meanThresh = Number(src?.instruments_ensemble?.decision_trace?.rules?.mean_thresh || 0.006);
      const creativeSaysBrass = creativeSuggest.some(s => s.includes('brass'));
      if (creativeSaysBrass && pannsBrassMean >= meanThresh) {
        const lowerInstrumentNames = instrumentFallback.map(i => String(i || '').toLowerCase());
        if (!lowerInstrumentNames.includes('brass') && !lowerInstrumentNames.includes('brass (section)')) {
          instrumentFallback.push('Brass');
          instrumentFallback = uniqCI(instrumentFallback);
          console.debug('[merge] creativeBrassFallback: injected "Brass" (panns.mean=' + pannsBrassMean + ', mean_thresh=' + meanThresh + ')');
        }
      }
    } catch (e) {
      console.warn('[merge] creativeBrassFallback failed:', e && e.message ? e.message : e);
    }
  })();

  // — Aggregate family labels (Brass / Woodwinds) without removing individual instruments —
  // If any member instrument appears (e.g., 'Trumpet', 'Trombone', 'Saxophone', 'Flute', 'Clarinet'),
  // add a concise family label ("Brass" or "Woodwinds") so UI/CSV show consolidated families.
  (function addInstrumentFamilies(arr) {
    try {
      if (!Array.isArray(arr) || arr.length === 0) return;
      const lowered = arr.map(s => String(s || '').toLowerCase());
      const brassKeys = ['trumpet','trombone','horn','flugelhorn','cornet','brass','brass section','brass (section)'];
      const woodKeys  = ['sax','saxophone','tenor sax','alto sax','baritone sax','flute','clarinet','woodwind','woodwinds','woodwinds (section)'];

      const hasAny = (keys) => keys.some(k => lowered.some(item => item.includes(k)));
      // Add family labels only if not already present (case-insensitive check)
      if (hasAny(brassKeys) && !lowered.some(x => x === 'brass' || x === 'brass (section)')) {
        arr.push('Brass');
      }
      if (hasAny(woodKeys) && !lowered.some(x => x === 'woodwinds' || x === 'woodwinds (section)')) {
        arr.push('Woodwinds');
      }
      // Re-dedupe + preserve original casing using existing helper
      const deduped = uniqCI(arr);
      // Mutate original array by replacing contents (keeps reference semantics used below)
      arr.length = 0;
      deduped.forEach(i => arr.push(i));
    } catch (e) {
      // Non-fatal: do not block merge on this step
      console.warn('[DB] addInstrumentFamilies failed:', e && e.message ? e.message : e);
    }
  })(instrumentFallback);

  // --- Technical ---
  const technical = src.technical || {};
  const bpm = technical?.bpm;

  // --- RhythmDB write/merge ---
  const prevR = dbState.rhythm?.tracks?.[key] || {};
  const nowISO = new Date().toISOString();
  dbState.rhythm = dbState.rhythm || { tracks: {} };
  dbState.rhythm.tracks[key] = {
    // identity
    file: src.source?.fileName || prevR.file || '',
    path: src.source?.filePath || prevR.path || '',
    // timings retained if you store them; otherwise keep as-is
    analyzed_at: src.generatedAt || prevR.analyzed_at || nowISO,
    updated_at: nowISO,
    created_at: prevR.created_at || nowISO,
    // technical
    estimated_tempo_bpm: bpm ?? prevR.estimated_tempo_bpm ?? null,
    key: technical?.key || prevR.key,
    // creative (full)
    creative: {
      genre:      creative.genre,
      mood:       creative.mood,
      instrument: creative.instrument,       // keep what the creative JSON said
      vocals:     creative.vocals,
      theme:      creative.theme,
      narrative:  creative.narrative || undefined,
      confidence: creative.confidence
    },
    // analysis summary (instrument precedence for search/sorting pipelines)
    analysis: {
      instruments:      instrumentFallback,
      final_instruments: instrumentFallback,
      ...prevR.analysis
    }
  };

  // --- CriteriaDB write/merge (what the Search UI facets read) ---
  const prevC = dbState.criteria?.[key] || {};
  dbState.criteria = dbState.criteria || {};
  dbState.criteria[key] = {
    // facets
    genre:      creative.genre,
    mood:       creative.mood,
    instrument: instrumentFallback,   // use precedence result
    vocals:     creative.vocals,
    theme:      creative.theme,
    // keep any additional buckets you already track (tempoBands, etc.)
    tempoBands: prevC.tempoBands || []
  };

  console.log('[DB] Merged track JSON:', key, '-', instrumentFallback.length, 'instruments,', creative.genre.length, 'genres');
  return dbState;
}

module.exports = { mergeFromTrackJson };
