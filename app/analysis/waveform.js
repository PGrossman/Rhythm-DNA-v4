const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { fileSafe } = require('../utils/fileSafeName');
const { ensureParentDir } = require('../utils/dbScaffold');
const { shouldGenerateWaveformFor } = require('../utils/audioSiblings');
const { ffmpegPath } = require('../lib/ffmpegPath');

/**
 * Write a waveform PNG image for an audio file
 * @param {Object} params - Parameters for waveform generation
 * @param {string} params.audioPath - Path to the source audio file
 * @param {string} params.dbFolder - Database folder path for output
 * @param {number} [params.width=1200] - Width of the waveform image
 * @param {number} [params.height=256] - Height of the waveform image
 * @returns {string|null} - Path to the generated PNG file, or null if failed
 */
function writeWaveformPng({ audioPath, dbFolder, width = 1200, height = 256 }) {
  try {
    // Check MP3 preference policy
    if (!shouldGenerateWaveformFor(audioPath)) {
      console.log(`[WAVEFORM] Skipping PNG for WAV (MP3 twin present): ${audioPath}`);
      return { ok: true, skipped: true, reason: 'mp3-twin' };
    }
    const outDir = path.join(dbFolder, 'Waveforms');
    const base = fileSafe(path.parse(audioPath).name);
    const out = path.join(outDir, base + '.png');
    ensureParentDir(out);
    
    const ff = spawnSync(ffmpegPath(), [
      '-y',
      '-i', audioPath,
      '-filter_complex', `showwavespic=s=${width}x${height}:split_channels=0`,
      '-frames:v', '1',
      out
    ], { stdio: 'ignore' });
    
    if (ff.status !== 0) {
      console.log('[WAVEFORM] ffmpeg not available or failed; skipping for', audioPath);
      return { ok: false, error: 'ffmpeg-failed' };
    }
    
    return { ok: true, path: out };
  } catch (e) {
    console.log('[WAVEFORM] ERROR', e?.message || e);
    return { ok: false, error: e?.message || 'unknown-error' };
  }
}

module.exports = { writeWaveformPng };
