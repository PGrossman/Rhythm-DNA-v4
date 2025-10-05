export function getDetectedInstruments(track) {
  // Priority 1: Check root level first (direct JSON files from ffcalc.js)
  if (Array.isArray(track.finalInstruments) && track.finalInstruments.length) return track.finalInstruments;
  if (Array.isArray(track.instruments) && track.instruments.length) return track.instruments;
  
  // Priority 2: Check creative.instrument (where DB actually stores via mergeFromTrackJson)
  const c = track.creative || {};
  if (Array.isArray(c.instrument) && c.instrument.length) return c.instrument;
  
  // Priority 3: Check nested analysis property
  const a = track.analysis || {};
  
  // Check snake_case first (as written by mergeFromTrackJson)
  if (Array.isArray(a.final_instruments) && a.final_instruments.length) return a.final_instruments;
  
  // Check camelCase (legacy/compatibility)
  if (Array.isArray(a.finalInstruments) && a.finalInstruments.length) return a.finalInstruments;
  if (Array.isArray(a.instruments) && a.instruments.length) return a.instruments;
  
  return [];
}

export function getCreativeInstruments(track) {
  const a = track.analysis || track;
  const c = a.creative;
  return c && Array.isArray(c.suggestedInstruments) ? c.suggestedInstruments : [];
}

export function getTrackInstrumentsFromAny(track) {
  // Priority 1: Check root level first (direct JSON files from ffcalc.js)
  if (Array.isArray(track?.finalInstruments) && track.finalInstruments.length) return track.finalInstruments;
  if (Array.isArray(track?.instruments) && track.instruments.length) return track.instruments;
  
  // Priority 2: Check creative.instrument (where DB actually stores via mergeFromTrackJson)
  const c = track?.creative || {};
  if (Array.isArray(c.instrument) && c.instrument.length) return c.instrument;
  
  // Priority 3: Check nested analysis property
  const a = track?.analysis || {};
  
  // Check snake_case first (as written by mergeFromTrackJson)
  if (Array.isArray(a.final_instruments) && a.final_instruments.length) return a.final_instruments;
  
  // Check camelCase (legacy/compatibility)
  if (Array.isArray(a.finalInstruments) && a.finalInstruments.length) return a.finalInstruments;
  if (Array.isArray(a.instruments) && a.instruments.length) return a.instruments;
  
  return [];
}

/**
 * Derive section tags (Brass/Strings) only when discrete instruments pass ensemble thresholds.
 * This should only be used for display purposes, not fed back into analysis.instruments.
 */
export function deriveSectionTags(accepted) {
  const S = new Set(accepted);
  const brassKids = ['Trumpet','Trombone','Saxophone','French Horn'];
  const stringsKids = ['Violin','Viola','Cello','Double Bass'];
  const brassCount   = brassKids.filter(i => S.has(i)).length;
  const stringsCount = stringsKids.filter(i => S.has(i)).length;

  // Preserve existing section tags from database, only add new ones if criteria met
  // This ensures ML-detected sections (e.g. from ensemble analysis) are not removed
  const hadBrassSection = S.has('Brass (section)');
  const hadStringsSection = S.has('Strings (section)');
  
  if (brassCount >= 2) S.add('Brass (section)');
  else if (!hadBrassSection) S.delete('Brass (section)'); // Only delete if it wasn't there originally
  
  if (stringsCount >= 2) S.add('Strings (section)');
  else if (!hadStringsSection) S.delete('Strings (section)'); // Only delete if it wasn't there originally
  
  return Array.from(S);
}
