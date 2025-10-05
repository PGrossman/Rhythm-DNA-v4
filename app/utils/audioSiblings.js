const fs = require('fs');
const path = require('path');

function stemCaseInsensitive(p) {
  const { name } = path.parse(p);
  // Normalize spaces/underscores/parentheses so "Full Song", "Full_Song", "Full_Song)"
  // all match between mp3/wav variants.
  return name
    .trim()
    .replace(/[()]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function hasTwinMp3(currentPath) {
  const dir = path.dirname(currentPath);
  const stem = stemCaseInsensitive(currentPath);
  try {
    const entries = fs.readdirSync(dir);
    return entries.some(f => {
      const ext = path.extname(f).toLowerCase();
      if (ext !== '.mp3') return false;
      const candidate = path.join(dir, f);
      return stemCaseInsensitive(candidate) === stem;
    });
  } catch {
    return false;
  }
}

// Core policy:
// - Always allow MP3 waveforms.
// - For WAV, only allow if no MP3 twin.
function shouldGenerateWaveformFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return true;
  if (ext === '.wav') return !hasTwinMp3(filePath);
  return true; // other formats unchanged
}

module.exports = { shouldGenerateWaveformFor, hasTwinMp3 };
