// CSV Writer with settings-based feature gating

/**
 * Check if CSV writing should be enabled
 * @param {Object} [settings] - Optional settings object. If not provided, uses environment variable fallback
 * @returns {boolean} - true if CSV writing is enabled
 * 
 * DISABLED: CSV writing is currently turned OFF by request.
 * To re-enable: Change the return statement to use the original logic below.
 */
function shouldWriteCsv(settings) {
  // DISABLED: Always return false to turn off CSV writing
  // Original logic preserved for easy re-enabling:
  // if (settings && typeof settings.writeCsvArtifacts === 'boolean') {
  //   return settings.writeCsvArtifacts;
  // }
  // return process.env.RNA_WRITE_CSV === "1" || false;
  
  return false; // CSV writing disabled
}

module.exports = { shouldWriteCsv };
