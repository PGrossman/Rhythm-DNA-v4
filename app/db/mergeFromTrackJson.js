const { normalizeKey } = require('../lib/pathNormalize');

// RUNTIME BANNER: unmistakable marker so we can confirm this exact module was loaded by the worker.
// This prints to stderr so it appears in runtime Terminal logs even if stdout is buffered.
try {
  // Use console.error (goes to stderr) to guarantee log visibility in most setups.
  console.error('[runtime-instrument] mergeFromTrackJson loaded:', __filename, 'cwd=', process.cwd(), 'pid=', process.pid);
} catch (e) {
  // Defensive: never throw here
  console.warn('[runtime-instrument] merge banner failed', e && e.message ? e.message : e);
}

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
  
  // DEBUG: Raw JSON instrument data
  if (typeof log === 'function') {
    log('[DEBUG] Raw JSON finalInstruments:', src.finalInstruments);
    log('[DEBUG] Raw JSON instruments:', src.instruments);
    log('[DEBUG] Raw JSON analysis.finalInstruments:', src.analysis?.finalInstruments);
    log('[DEBUG] Raw JSON analysis.instruments:', src.analysis?.instruments);
  } else {
    console.log('[DEBUG] Raw JSON finalInstruments:', src.finalInstruments);
    console.log('[DEBUG] Raw JSON instruments:', src.instruments);
    console.log('[DEBUG] Raw JSON analysis.finalInstruments:', src.analysis?.finalInstruments);
    console.log('[DEBUG] Raw JSON analysis.instruments:', src.analysis?.instruments);
  }
  
  const key = normalizeKey(src?.source?.filePath || src?.source?.fileName || '');
  
  if (!key) {
    console.warn('[DB] Cannot normalize key for track:', src.source);
    return dbState;
  }

  // Extract finalInstruments from analysis (created by ffcalc.js)
  const finalInstruments = src?.analysis?.finalInstruments || [];

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

  // --- Instrument extraction with broader finalInstruments priority (handles root-writer JSONs) ---
  const techMap = hintsTrueToInstruments(src?.technical?.audioHints || {});
  const instFromInstr = Array.isArray(src?.instrumentation?.instruments) ? src.instrumentation.instruments : [];
  
  const rootFinal      = Array.isArray(src?.finalInstruments)             ? src.finalInstruments             : [];
  const analysisFinal  = Array.isArray(src?.analysis?.finalInstruments)   ? src.analysis.finalInstruments    : [];
  const rootRaw        = Array.isArray(src?.instruments)                  ? src.instruments                  : [];
  const analysisRaw    = Array.isArray(src?.analysis?.instruments)        ? src.analysis.instruments         : [];
  const creativeList   = Array.isArray(creative?.instrument)              ? creative.instrument              : [];
  
  let instruments = (
    (rootFinal.length     ? rootFinal     : null) ||
    (analysisFinal.length ? analysisFinal : null) ||
    (rootRaw.length       ? rootRaw       : null) ||
    (analysisRaw.length   ? analysisRaw   : null) ||
    (instFromInstr.length ? instFromInstr : null) ||
    (creativeList.length  ? creativeList  : null) ||
    techMap
  );
  
  // Canonicalize section labels to match finalize_instruments.js and dedupe (stable order)
  const canon = (s) => {
    const t = String(s || '').trim();
    if (t === 'Brass (section)' || t === 'Brass Section') return 'Brass';
    if (t === 'Woodwinds (section)' || t === 'Woodwind')  return 'Woodwinds';
    return t;
  };
  const seen = new Set();
  instruments = (instruments || []).map(canon).filter(v => {
    if (!v) return false;
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
  
  // DEBUG: Extracted instruments array
  if (typeof log === 'function') {
    log('[DEBUG] Extracted instruments array:', instruments);
    log('[DEBUG] Instruments array length:', instruments.length);
    log('[DEBUG] Instruments array type:', typeof instruments);
  } else {
    console.log('[DEBUG] Extracted instruments array:', instruments);
    console.log('[DEBUG] Instruments array length:', instruments.length);
    console.log('[DEBUG] Instruments array type:', typeof instruments);
  }
  
  // For backward compatibility, maintain the old variable names for existing logic
  const instFromAnalysis = instruments;
  const instFromCreative = Array.isArray(creative.instrument) ? creative.instrument : [];
  
  // DEBUG: Log extracted instruments from each source
  console.log('[DEBUG] Extracted instruments from sources:');
  console.log('[DEBUG] rootFinal:', rootFinal);
  console.log('[DEBUG] analysisFinal:', analysisFinal);
  console.log('[DEBUG] rootRaw:', rootRaw);
  console.log('[DEBUG] analysisRaw:', analysisRaw);
  console.log('[DEBUG] creativeList:', creativeList);
  console.log('[DEBUG] instFromInstr:', instFromInstr);
  console.log('[DEBUG] techMap:', techMap);
  console.log('[DEBUG] instruments (final):', instruments);
  console.log('[DEBUG] src.finalInstruments:', src?.finalInstruments);
  console.log('[DEBUG] src.analysis.finalInstruments:', src?.analysis?.finalInstruments);
  
  // Base precedence: instrumentation -> analysis -> creative -> technical hints
  let instrumentFallback = uniqCI(
    (instFromInstr.length ? instFromInstr :
     instFromAnalysis.length ? instFromAnalysis :
     instFromCreative.length ? instFromCreative :
     techMap)
  );
  
  // DEBUG: Log the final instrumentFallback
  console.log('[DEBUG] Final instrumentFallback:', instrumentFallback);

  // — DEBUG: dump pre-fallback state so we can trace why Brass was/wasn't injected —
  try {
    // Defensive creative suggestedInstruments lookup: support creative.json.* and creative.* shapes
    const creativeRawSuggestA = Array.isArray(src?.creative?.suggestedInstruments) ? src.creative.suggestedInstruments : [];
    const creativeRawSuggestB = Array.isArray(src?.creative?.json?.suggestedInstruments) ? src.creative.json.suggestedInstruments : [];
    const creativeSuggestMerged = uniqCI([...creativeRawSuggestA, ...creativeRawSuggestB]).map(s => String(s || '').toLowerCase());

    const dbg_pannsMean = Number(src?.instruments_ensemble?.decision_trace?.per_model?.panns?.mean_probs?.brass || 0);
    const dbg_pannsPos  = Number(src?.instruments_ensemble?.decision_trace?.per_model?.panns?.pos_ratio?.brass || 0);
    const dbg_meanThresh = Number(src?.instruments_ensemble?.decision_trace?.rules?.mean_thresh || 0.006);
    const dbg_posFallback = 0.005;

    console.debug('[merge-debug] pre-fallback instrumentFallback:', JSON.stringify(instrumentFallback));
    console.debug('[merge-debug] creativeSuggestMerged:', JSON.stringify(creativeSuggestMerged));
    console.debug('[merge-debug] pannsMean, pannsPos, meanThresh, posFallback:', dbg_pannsMean, dbg_pannsPos, dbg_meanThresh, dbg_posFallback);

  } catch (e) {
    console.warn('[merge-debug] pre-fallback debug failed:', e && e.message ? e.message : e);
  }

  // — Robust creative+model fallback for Brass —
  (function robustCreativeBrassFallback() {
    try {
      // RUNTIME BANNER: record invocation and key model numbers so we can see why fallback did/didn't inject
      try {
        const __dbg_pannsMean = Number(src?.instruments_ensemble?.decision_trace?.per_model?.panns?.mean_probs?.brass || 0);
        const __dbg_pannsPos  = Number(src?.instruments_ensemble?.decision_trace?.per_model?.panns?.pos_ratio?.brass || 0);
        console.error('[runtime-instrument] robustCreativeBrassFallback invoked — pannsMean=', __dbg_pannsMean, 'pannsPos=', __dbg_pannsPos, 'file=', __filename, 'pid=', process.pid);
      } catch (e) {
        console.error('[runtime-instrument] robustCreativeBrassFallback dbg failed:', e && e.message ? e.message : e);
      }

      // Broaden creative extraction here too (keeps original behavior but is defensive)
      const creativeSuggestSourceA = Array.isArray(src?.creative?.suggestedInstruments) ? src.creative.suggestedInstruments : [];
      const creativeSuggestSourceB = Array.isArray(src?.creative?.json?.suggestedInstruments) ? src.creative.json.suggestedInstruments : [];
      const creativeSuggest = uniqCI([...creativeSuggestSourceA, ...creativeSuggestSourceB]).map(s => String(s || '').toLowerCase());

      const pannsMean = Number(src?.instruments_ensemble?.decision_trace?.per_model?.panns?.mean_probs?.brass || 0);
      const pannsPos  = Number(src?.instruments_ensemble?.decision_trace?.per_model?.panns?.pos_ratio?.brass || 0);
      const meanThresh = Number(src?.instruments_ensemble?.decision_trace?.rules?.mean_thresh || 0.006);
      const posFallbackThresh = 0.005;

      const creativeSaysBrass = creativeSuggest.some(s => s.includes('brass'));
      const meanPass = pannsMean >= meanThresh;
      const posPass = pannsPos >= posFallbackThresh;

      console.debug('[merge-debug] fallback inputs — creativeSaysBrass, meanPass, posPass:', creativeSaysBrass, meanPass, posPass);
      console.debug('[merge-debug] fallback raw — creativeSuggest, pannsMean, pannsPos, meanThresh, posFallbackThresh:', JSON.stringify(creativeSuggest), pannsMean, pannsPos, meanThresh, posFallbackThresh);

      if ((creativeSaysBrass || meanPass || posPass)) {
        const lowerInstrumentNames = instrumentFallback.map(i => String(i || '').toLowerCase());
        if (!lowerInstrumentNames.includes('brass') && !lowerInstrumentNames.includes('brass (section)')) {
          instrumentFallback.push('Brass');
          instrumentFallback = uniqCI(instrumentFallback);
          console.debug('[merge-debug] robustCreativeBrassFallback: injected "Brass" (panns.mean=' + pannsMean + ', panns.pos=' + pannsPos + ', mean_thresh=' + meanThresh + ', pos_thresh=' + posFallbackThresh + ', creative=' + creativeSaysBrass + ')');
        } else {
          console.debug('[merge-debug] robustCreativeBrassFallback: NOT injecting — already present in instrumentFallback:', JSON.stringify(instrumentFallback));
        }
      } else {
        console.debug('[merge-debug] robustCreativeBrassFallback: conditions not met — no injection');
      }
    } catch (e) {
      console.warn('[merge-debug] robustCreativeBrassFallback failed:', e && e.message ? e.message : e);
    }
  })();

  // — DEBUG: dump post-fallback state so we can confirm the final array used for DB write —
  try {
    console.debug('[merge-debug] post-fallback instrumentFallback:', JSON.stringify(instrumentFallback));
  } catch (e) {
    console.warn('[merge-debug] post-fallback debug failed:', e && e.message ? e.message : e);
  }

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

  // — FORCE: ensure downstream writers see the resolved instrument list —
  try {
    // Ensure analysis container exists
    src.analysis = src.analysis || {};

    // Force final instruments and instruments fields so CSV/writers consume this array.
    // Keep canonical ordering and exact strings in instrumentFallback.
    src.analysis.final_instruments = Array.isArray(instrumentFallback) ? instrumentFallback.slice() : [];
    src.analysis.instruments       = Array.isArray(instrumentFallback) ? instrumentFallback.slice() : [];

    // Visible runtime banner to stderr so logs show what was written
    try {
      // console.error goes to stderr and is visible in most log collectors/terminals
      console.error('[merge-force] wrote final_instruments:', JSON.stringify(src.analysis.final_instruments), 'key=', key, 'pid=', process.pid);
    } catch (e2) {
      console.warn('[merge-force] warn writing final_instruments log failed:', e2 && e2.message ? e2.message : e2);
    }

  } catch (e) {
    // Non-fatal: do not stop DB write, but log
    console.warn('[merge-force] failed to set src.analysis.final_instruments:', e && e.message ? e.message : e);
  }

  // --- Technical ---
  const technical = src.technical || {};
  const bpm = technical?.bpm;

  // --- RhythmDB write/merge ---
  const prevR = dbState.rhythm?.tracks?.[key] || {};
  const nowISO = new Date().toISOString();
  
  // DEBUG: Log what we're about to save
  console.log('[DEBUG] About to save track with instruments:', instruments);
  console.log('[DEBUG] Track key:', key);
  console.log('[DEBUG] Previous track data:', prevR);
  
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
      instrument: instruments,               // use finalInstruments from ffcalc.js
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
  
  // DEBUG: About to add instruments to criteria
  if (typeof log === 'function') {
    log('[DEBUG] About to add instruments to criteria');
    log('[DEBUG] Current criteria.instrument:', prevC.instrument);
    log('[DEBUG] Instruments to add:', instruments);
    log('[DEBUG] Instruments type:', typeof instruments);
    log('[DEBUG] Instruments is array:', Array.isArray(instruments));
  } else {
    console.log('[DEBUG] About to add instruments to criteria');
    console.log('[DEBUG] Current criteria.instrument:', prevC.instrument);
    console.log('[DEBUG] Instruments to add:', instruments);
    console.log('[DEBUG] Instruments type:', typeof instruments);
    console.log('[DEBUG] Instruments is array:', Array.isArray(instruments));
  }
  
  dbState.criteria = dbState.criteria || {};
  dbState.criteria[key] = {
    // facets
    genre:      creative.genre,
    mood:       creative.mood,
    instrument: instruments,           // use finalInstruments from ffcalc.js
    vocals:     creative.vocals,
    theme:      creative.theme,
    // keep any additional buckets you already track (tempoBands, etc.)
    tempoBands: prevC.tempoBands || []
  };
  
  // DEBUG: Final criteria.instrument
  if (typeof log === 'function') {
    log('[DEBUG] Final criteria.instrument:', dbState.criteria[key].instrument);
    log('[DEBUG] Final criteria.instrument length:', dbState.criteria[key].instrument?.length);
  } else {
    console.log('[DEBUG] Final criteria.instrument:', dbState.criteria[key].instrument);
    console.log('[DEBUG] Final criteria.instrument length:', dbState.criteria[key].instrument?.length);
  }

  // DEBUG: Log final database state
  if (typeof log === 'function') {
    log('[DEBUG] Final database state for track:', key);
    log('[DEBUG] RhythmDB instruments:', dbState.rhythm.tracks[key]?.creative?.instrument);
    log('[DEBUG] CriteriaDB instruments:', dbState.criteria[key]?.instrument);
  } else {
    console.log('[DEBUG] Final database state for track:', key);
    console.log('[DEBUG] RhythmDB instruments:', dbState.rhythm.tracks[key]?.creative?.instrument);
    console.log('[DEBUG] CriteriaDB instruments:', dbState.criteria[key]?.instrument);
  }
  if (typeof log === 'function') {
    log('[DEBUG] Analysis instruments:', dbState.rhythm.tracks[key]?.analysis?.instruments);
  } else {
    console.log('[DEBUG] Analysis instruments:', dbState.rhythm.tracks[key]?.analysis?.instruments);
  }
  
  console.log('[DB] Merged track JSON:', key, '-', instrumentFallback.length, 'instruments,', creative.genre.length, 'genres');
  return dbState;
}

module.exports = { mergeFromTrackJson };
