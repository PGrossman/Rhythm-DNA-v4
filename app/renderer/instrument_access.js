export function getDetectedInstruments(track) {
  // v1.2.0: Check root level first (database stores JSON at root)
  if (Array.isArray(track.finalInstruments) && track.finalInstruments.length) return track.finalInstruments;
  if (Array.isArray(track.instruments) && track.instruments.length) return track.instruments;
  
  // Fallback: check nested analysis property
  const a = track.analysis || {};
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
  // v1.2.0: Check root level first (database stores JSON at root)
  if (Array.isArray(track?.finalInstruments) && track.finalInstruments.length) return track.finalInstruments;
  if (Array.isArray(track?.instruments) && track.instruments.length) return track.instruments;
  
  // Fallback: check nested analysis property
  const a = track?.analysis || {};
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

  // Only add if 2+ members present; never add otherwise
  if (brassCount >= 2) S.add('Brass (section)'); else S.delete('Brass (section)');
  if (stringsCount >= 2) S.add('Strings (section)'); else S.delete('Strings (section)');
  return Array.from(S);
}
