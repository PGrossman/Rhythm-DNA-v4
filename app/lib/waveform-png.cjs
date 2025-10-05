const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs/promises');

async function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => (err += d.toString()));
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(err || `${cmd} failed (${code})`)));
  });
}

/**
 * Ensure a waveform PNG exists for an audio file.
 * - Generates with ffmpeg showwavespic if missing.
 * - Returns absolute path to the PNG.
 */
async function ensureWaveformPNG(absAudioPath, outDirAbs) {
  const base = path.basename(absAudioPath, path.extname(absAudioPath));
  const outPng = path.join(outDirAbs, `${base}.wave.png`);

  try {
    await fs.access(outPng);
    return outPng;
  } catch (_) {
    // continue to generate
  }

  await fs.mkdir(outDirAbs, { recursive: true });

  // Produce a clean mono waveform
  const args = [
    '-y',
    '-i', absAudioPath,
    '-filter_complex',
    'aformat=channel_layouts=mono,showwavespic=s=1200x240:colors=white',
    '-frames:v', '1',
    outPng
  ];
  await run('ffmpeg', args);
  return outPng;
}

module.exports = { ensureWaveformPNG };
