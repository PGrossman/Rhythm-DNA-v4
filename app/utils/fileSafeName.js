// Helper to create file-safe names by replacing unsafe characters with underscores

/**
 * Replace any characters not in [A-Za-z0-9._ -] with _ (keep spaces and dashes)
 * @param {string} stem - The filename stem to sanitize
 * @returns {string} - The sanitized filename stem
 */
function fileSafe(stem) {
  return String(stem || '').replace(/[^A-Za-z0-9._ -]/g, '_');
}

module.exports = { fileSafe };
