'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Helper to run command
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.stderr.on('data', d => (err += d.toString()));
    p.on('close', (code) => code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `${cmd} failed`)));
  });
}

async function ffprobeDuration(file) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  const dur = parseFloat(out);
  if (!isFinite(dur) || dur <= 0) throw new Error('Could not read duration from ffprobe');
  return dur;
}

/**
 * Generate or reuse a waveform PNG for a given audio file.
 * @param {string} absPath absolute path to audio
 * @param {object} opts { dbFolder, height=180, pps=60, color='#22c55e' }
 * @returns {Promise<{pngPath:string, width:number, height:number, pps:number}>}
 */
async function ensureWaveformPng(absPath, opts = {}) {
  const dbFolder = opts.dbFolder;
  if (!dbFolder) {
    console.log('[WAVEFORM] No dbFolder provided, skipping PNG generation');
    throw new Error('ensureWaveformPng requires opts.dbFolder');
  }

  const height = opts.height ?? 180;
  const pps = opts.pps ?? 60; // pixels per second
  const color = (opts.color ?? '22c55e').replace('#',''); // green

  // Create deterministic filename
  const base = path.basename(absPath, path.extname(absPath));
  const hash = crypto.createHash('md5').update(absPath).digest('hex').slice(0,10);
  const outDir = path.join(dbFolder, 'waveforms');
  const outPng = path.join(outDir, `${base}.${hash}.wave.png`);

  // Check if already exists
  try {
    const st = fs.statSync(outPng);
    if (st.size > 0) {
      console.log('[WAVEFORM] Reusing existing PNG:', outPng);
      return { pngPath: outPng, width: 1600, height, pps };
    }
  } catch { /* doesn't exist */ }

  // Create directory
  fs.mkdirSync(outDir, { recursive: true });

  // Calculate width based on duration
  const duration = opts.durationSec || await ffprobeDuration(absPath);
  const width = Math.max(800, Math.min(Math.round(duration * pps), 8000));

  console.log(`[WAVEFORM] Generating PNG: ${outPng} (${width}x${height})`);

  // Generate PNG using ffmpeg
  const args = [
    '-hide_banner', '-y',
    '-i', absPath,
    '-filter_complex',
    `aformat=channel_layouts=mono,showwavespic=s=${width}x${height}:colors=${color}`,
    '-frames:v', '1',
    outPng,
  ];

  try {
    await run('ffmpeg', args);
    console.log('[WAVEFORM] PNG generated:', outPng);
    return { pngPath: outPng, width, height, pps };
  } catch (err) {
    console.error('[WAVEFORM] FFmpeg failed:', err.message);
    throw err;
  }
}

module.exports = { ensureWaveformPng };