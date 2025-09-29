// CSV Writer with settings-based feature gating

/**
 * Check if CSV writing should be enabled
 * @param {Object} [settings] - Optional settings object. If not provided, uses environment variable fallback
 * @returns {boolean} - true if CSV writing is enabled
 */
function shouldWriteCsv(settings) {
  // If settings object is provided, use it
  if (settings && typeof settings.writeCsvArtifacts === 'boolean') {
    return settings.writeCsvArtifacts;
  }
  
  // Fallback to environment variable
  return process.env.RNA_WRITE_CSV === "1" || false;
}

module.exports = { shouldWriteCsv };
