const fs = require('fs');
const path = require('path');

/**
 * Ensure a directory exists, creating it recursively if needed
 * @param {string} p - Directory path to ensure
 */
function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch (e) {
    // Swallow errors - directory might already exist
  }
}

/**
 * Ensure the parent directory of a file path exists
 * @param {string} file - File path whose parent directory to ensure
 */
function ensureParentDir(file) {
  ensureDir(path.dirname(file));
}

/**
 * Ensure the complete DB scaffold structure exists
 * @param {string} dbFolder - Root database folder path
 */
function ensureDbScaffold(dbFolder) {
  if (!dbFolder) return;
  ensureDir(dbFolder);
  ['Logs', 'Waveforms'].forEach(sub => {
    ensureDir(path.join(dbFolder, sub));
  });
}

module.exports = { ensureDir, ensureParentDir, ensureDbScaffold };
