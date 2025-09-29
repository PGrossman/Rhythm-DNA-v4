// Creative Normalization - Ensures consistent flat array structure

/**
 * Normalize creative results to flat arrays
 * @param {any} raw - Raw creative result (may be nested under .json or have various shapes)
 * @returns {Object} - Normalized creative with flat arrays
 */
function normalizeCreative(raw) {
  if (!raw) return { genre: [], mood: [], instrument: [], vocals: [], theme: [] };
  
  // Some code paths passed { ok, json: {...} }
  const src = raw.json && typeof raw.json === 'object' ? raw.json : raw;
  
  const pick = k => Array.isArray(src[k]) ? src[k].filter(Boolean) : [];
  
  return {
    genre: pick('genre'),
    mood: pick('mood'),
    instrument: pick('instrument'),
    vocals: pick('vocals'),
    theme: pick('lyricThemes').length ? src.lyricThemes : pick('theme')
  };
}

module.exports = normalizeCreative;
