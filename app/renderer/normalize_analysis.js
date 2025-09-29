/**
 * Normalize an analysis JSON object in-place so downstream code
 * can keep using existing properties:
 *   - Prefer ensemble instruments when present
 *   - Keep a source flag for debugging
 *   - Normalize tempo to `bpm`
 */
export function normalizeAnalysis(a) {
  if (!a || typeof a !== "object") return a;

  // ---- Instruments: prefer final_instruments (canonical) when available ----
  // Audio Detection/CSV should mirror final_instruments exactly and section tags 
  // come from the post-normalized list (after finalize_instruments.js suppression/derivation)
  if (Array.isArray(a.final_instruments)) {
    a.instruments = a.final_instruments.slice(); // make a shallow copy
    a.instrumentsSource = "finalized";
    a.audioDetected = a.final_instruments.slice(); // for UI consistency
  } else if (Array.isArray(a.instruments_ensemble) && a.instrument_source === "ensemble") {
    a.instruments = a.instruments_ensemble.slice(); // make a shallow copy
    a.instrumentsSource = "ensemble";
    a.audioDetected = a.instruments_ensemble.slice(); // for UI consistency
  } else if (!Array.isArray(a.instruments) && Array.isArray(a.instruments_ensemble)) {
    // if source flag is missing but we do have ensemble array, still prefer it
    a.instruments = a.instruments_ensemble.slice();
    a.instrumentsSource = "ensemble";
    a.audioDetected = a.instruments_ensemble.slice(); // for UI consistency
  } else {
    // fall back to whatever legacy field was used before
    a.instrumentsSource = a.instrumentsSource || a.instrument_source || "legacy";
    a.audioDetected = Array.isArray(a.instruments) ? a.instruments.slice() : [];
  }

  // ---- Tempo: normalize to `bpm` if older fields exist ----
  if (a.bpm == null) {
    if (typeof a.tempo === "number") a.bpm = a.tempo;
    else if (a.analysis && typeof a.analysis.bpm === "number") a.bpm = a.analysis.bpm;
  }

  return a;
}
