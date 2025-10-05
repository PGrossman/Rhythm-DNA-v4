/**
 * Search data adapter - prepares track data for display in search results
 */

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
 * Get instruments for a track with fallback order
 * @param {Object} row - Track data object
 * @returns {Array} Array of instruments
 */
function getDisplayInstruments(row) {
  // Fallback order: analysis.final_instruments → analysis.instruments → creative.instrument → criteria.instrument
  const instruments = row.analysis?.final_instruments
    || row.analysis?.instruments
    || row.creative?.instrument
    || row.criteria?.instrument
    || [];
  
  return uniqCI(instruments);
}

/**
 * Get genre for a track with fallback order
 * @param {Object} row - Track data object
 * @returns {Array} Array of genres
 */
function getDisplayGenre(row) {
  const genres = row.creative?.genre || row.criteria?.genre || [];
  return uniqCI(genres);
}

/**
 * Get mood for a track with fallback order
 * @param {Object} row - Track data object
 * @returns {Array} Array of moods
 */
function getDisplayMood(row) {
  const moods = row.creative?.mood || row.criteria?.mood || [];
  return uniqCI(moods);
}

/**
 * Get vocals for a track with fallback order
 * @param {Object} row - Track data object
 * @returns {Array} Array of vocals
 */
function getDisplayVocals(row) {
  const vocals = row.creative?.vocals || row.criteria?.vocals || [];
  return uniqCI(vocals);
}

/**
 * Get theme for a track with fallback order
 * @param {Object} row - Track data object
 * @returns {Array} Array of themes
 */
function getDisplayTheme(row) {
  const themes = row.creative?.theme || row.criteria?.theme || [];
  return uniqCI(themes);
}

/**
 * Prepare track data for search display
 * @param {Object} track - Raw track data from database
 * @returns {Object} Prepared track data for UI display
 */
function adaptTrackForSearch(track) {
  return {
    ...track,
    displayInstruments: getDisplayInstruments(track),
    // Add other display adaptations as needed
  };
}

/**
 * Prepare multiple tracks for search display
 * @param {Array} tracks - Array of raw track data
 * @returns {Array} Array of prepared track data
 */
function adaptTracksForSearch(tracks) {
  return tracks.map(adaptTrackForSearch);
}

module.exports = {
  getDisplayInstruments,
  getDisplayGenre,
  getDisplayMood,
  getDisplayVocals,
  getDisplayTheme,
  adaptTrackForSearch,
  adaptTracksForSearch
};
