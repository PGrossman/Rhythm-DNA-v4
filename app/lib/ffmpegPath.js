// Utility to get bundled ffmpeg/ffprobe paths
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function getBinPath(binary) {
  // In development: use system PATH binaries
  if (!app.isPackaged) {
    return binary; // Uses system PATH
  }
  
  // In production: use bundled binaries
  const resourcesPath = process.resourcesPath;
  const bundledPath = path.join(resourcesPath, 'app', 'bin', binary);
  
  if (fs.existsSync(bundledPath)) {
    return bundledPath;
  }
  
  // Fallback to system PATH if bundled binary not found
  console.warn(`[FFMPEG] Bundled ${binary} not found at ${bundledPath}, falling back to system PATH`);
  return binary;
}

module.exports = {
  ffmpegPath: () => getBinPath('ffmpeg'),
  ffprobePath: () => getBinPath('ffprobe')
};

