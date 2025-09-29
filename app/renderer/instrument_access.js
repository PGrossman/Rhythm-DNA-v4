export function getDetectedInstruments(track) {
  const a = track.analysis || track;
  if (Array.isArray(a.instruments) && a.instruments.length) return a.instruments;
  if (Array.isArray(a.instruments_ensemble) && a.instruments_ensemble.length) return a.instruments_ensemble;
  return [];
}

export function getCreativeInstruments(track) {
  const a = track.analysis || track;
  const c = a.creative;
  return c && Array.isArray(c.suggestedInstruments) ? c.suggestedInstruments : [];
}

export function getTrackInstrumentsFromAny(track) {
  const a = track?.analysis || {};
  if (Array.isArray(a.instruments) && a.instruments.length) return a.instruments;
  if (Array.isArray(a.instruments_ensemble) && a.instruments_ensemble.length) return a.instruments_ensemble;
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
