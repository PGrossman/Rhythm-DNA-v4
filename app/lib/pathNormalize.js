const path = require('path');

function normalizeStem(name) {
  return String(name || '')
    .replace(/[()]/g, '')
    .replace(/[_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeKey(filePath) {
  const dir = path.dirname(filePath || '');
  const stem = normalizeStem(path.basename(filePath || ''));
  return (dir + '/' + stem).toLowerCase();
}

module.exports = { normalizeStem, normalizeKey };