const fs = require('fs');
const path = require('path');
const { fileSafe } = require('./fileSafeName');
const normalizeCreative = require('./creativeNormalize');

/**
 * Generate the target path for the new JSON naming convention
 * @param {string} filePath - Path to the source audio file
 * @returns {string} - Path where the JSON should be written (<Song Name>.json)
 */
function targetPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.parse(filePath).name;
  const safe = fileSafe(base);
  return path.join(dir, safe + '.json');
}

/**
 * Generate the legacy path for the old JSON naming convention
 * @param {string} filePath - Path to the source audio file
 * @returns {string} - Path where legacy JSON would be (<Song Name>.rhythmdna.json)
 */
function legacyPath(filePath) {
  const dir = path.dirname(filePath);
  const base = path.parse(filePath).name;
  const safe = fileSafe(base);
  return path.join(dir, safe + '.rhythmdna.json');
}

/**
 * Find existing JSON file (new or legacy naming)
 * @param {string} filePath - Path to the source audio file
 * @returns {Object|null} - { path: string, variant: 'new'|'legacy' } or null if not found
 */
function findExistingJson(filePath) {
  const newP = targetPath(filePath);
  const oldP = legacyPath(filePath);
  
  if (fs.existsSync(newP)) {
    return { path: newP, variant: 'new' };
  }
  if (fs.existsSync(oldP)) {
    return { path: oldP, variant: 'legacy' };
  }
  return null;
}

/**
 * Upgrade legacy file to new naming convention
 * @param {string} filePath - Path to the source audio file
 * @returns {string|null} - Path to the upgraded file or null if no legacy file
 */
function upgradeIfLegacy(filePath) {
  const found = findExistingJson(filePath);
  
  if (found && found.variant === 'legacy') {
    const dest = targetPath(filePath);
    try {
      fs.renameSync(found.path, dest);
      return dest;
    } catch (e) {
      // Fallback: copy then delete
      try {
        const data = fs.readFileSync(found.path);
        fs.writeFileSync(dest, data);
        try {
          fs.unlinkSync(found.path);
        } catch (_) {
          // Ignore delete failure
        }
        return dest;
      } catch (copyError) {
        console.error('[JSON] Failed to upgrade legacy file:', copyError);
        return null;
      }
    }
  }
  
  return found ? found.path : null;
}

/**
 * Safely read JSON file
 * @param {string} filePath - Path to JSON file
 * @returns {Object|null} - Parsed JSON object or null on error
 */
function readJsonSafe(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

/**
 * Merge creative data as flat arrays into existing object
 * @param {Object} existingObj - Existing object to merge into
 * @param {Object} creativeFlat - Normalized creative data with flat arrays
 * @returns {Object} - Object with merged creative data
 */
function mergeCreativeFlat(existingObj, creativeFlat) {
  if (!existingObj.creative) {
    existingObj.creative = { genre: [], mood: [], instrument: [], vocals: [], theme: [] };
  }
  existingObj.creative = creativeFlat;
  return existingObj;
}

/**
 * Write JSON summary (simple write, no merging)
 * @param {Object} params - The analysis data
 * @param {string} params.filePath - Path to the source audio file
 * @param {Object} [params.technical] - Technical analysis results
 * @param {Object} [params.instrumentation] - Instrumentation analysis results
 * @param {Object} [params.creative] - Creative analysis results
 * @param {Object} [params.timings] - Timing information
 * @param {Object} [params.versions] - Version information
 * @returns {string} - Path where the file was written
 */
function writeSummary({ filePath, technical, instrumentation, creative, timings, versions }) {
  const out = {
    source: {
      filePath,
      fileName: path.basename(filePath),
      dir: path.dirname(filePath)
    },
    technical: technical || null,
    instrumentation: instrumentation || null,
    creative: creative || null,
    timings: timings || null,
    versions: versions || null,
    generatedAt: new Date().toISOString()
  };
  
  const dest = targetPath(filePath);
  fs.writeFileSync(dest, JSON.stringify(out, null, 2), 'utf8');
  return dest;
}

/**
 * Write or merge JSON summary with automatic legacy upgrade
 * @param {Object} params - The analysis data (same as writeSummary)
 * @returns {string} - Path where the file was written
 */
function writeOrMerge({ filePath, technical, instrumentation, creative, timings, versions }) {
  // 1) Upgrade legacy if present
  const existing = upgradeIfLegacy(filePath);
  const dest = targetPath(filePath);
  let merged = null;
  
  if (existing && fs.existsSync(existing)) {
    const prev = readJsonSafe(existing) || {};
    merged = {
      ...prev,
      source: {
        filePath,
        fileName: path.basename(filePath),
        dir: path.dirname(filePath)
      },
      technical: (technical ?? prev.technical) ?? null,
      instrumentation: (instrumentation ?? prev.instrumentation) ?? null,
      creative: (creative ?? prev.creative) ?? null,
      timings: { ...(prev.timings || {}), ...(timings || {}) } || null,
      versions: { ...(prev.versions || {}), ...(versions || {}) } || null,
      generatedAt: new Date().toISOString()
    };
  } else {
    merged = {
      source: {
        filePath,
        fileName: path.basename(filePath),
        dir: path.dirname(filePath)
      },
      technical: technical || null,
      instrumentation: instrumentation || null,
      creative: creative || null,
      timings: timings || null,
      versions: versions || null,
      generatedAt: new Date().toISOString()
    };
  }
  
  // Normalize creative data if provided
  if (creative) {
    const creativeFlat = normalizeCreative(creative);
    mergeCreativeFlat(merged, creativeFlat);
  }
  
  fs.writeFileSync(dest, JSON.stringify(merged, null, 2), 'utf8');
  return dest;
}

module.exports = { targetPath, findExistingJson, upgradeIfLegacy, writeSummary, writeOrMerge, mergeCreativeFlat };