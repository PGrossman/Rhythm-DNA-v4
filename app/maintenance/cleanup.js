const fs = require('fs');
const path = require('path');
const { hasTwinMp3 } = require('../utils/audioSiblings');

/**
 * Cleanup WAV waveform PNGs when MP3 twins exist
 * This is an optional maintenance function that removes WAV PNGs when an MP3 twin exists
 * @param {string} dbFolder - Database folder containing Waveforms directory
 * @param {Object} options - Options for cleanup
 * @param {boolean} [options.dryRun=false] - If true, only log what would be deleted
 * @returns {Object} - Cleanup results
 */
function cleanupWavWaveformsWhenMp3Exists(dbFolder, options = {}) {
  const { dryRun = false } = options;
  const results = {
    scanned: 0,
    deleted: 0,
    skipped: 0,
    errors: []
  };

  try {
    const waveformsDir = path.join(dbFolder, 'Waveforms');
    
    // Check if Waveforms directory exists
    if (!fs.existsSync(waveformsDir)) {
      console.log('[CLEANUP] Waveforms directory not found:', waveformsDir);
      return results;
    }

    // Get all PNG files in the Waveforms directory
    const entries = fs.readdirSync(waveformsDir);
    const pngFiles = entries.filter(f => f.toLowerCase().endsWith('.png'));

    console.log(`[CLEANUP] Scanning ${pngFiles.length} PNG files in ${waveformsDir}`);

    for (const pngFile of pngFiles) {
      results.scanned++;
      
      // Extract the base name (remove .png extension)
      const baseName = path.parse(pngFile).name;
      
      // Look for corresponding WAV files in the source directories
      // We need to find the original WAV file to check for MP3 twins
      // This is a simplified approach - in practice, you might need to track
      // the original source path in the waveform metadata
      
      // For now, we'll assume the PNG name matches the WAV file name
      // and check if we can find a corresponding WAV file in common locations
      
      // This is a placeholder implementation - you might want to enhance this
      // to actually track the source paths of waveforms
      
      console.log(`[CLEANUP] Checking ${pngFile} for MP3 twin...`);
      
      // In a real implementation, you would:
      // 1. Find the original WAV file path from waveform metadata
      // 2. Check if hasTwinMp3(wavPath) returns true
      // 3. If so, delete the PNG file
      
      // For now, we'll just log what would happen
      if (dryRun) {
        console.log(`[CLEANUP] DRY RUN: Would check ${pngFile} for MP3 twin and potentially delete`);
      } else {
        console.log(`[CLEANUP] Would need source path tracking to properly implement cleanup for ${pngFile}`);
        results.skipped++;
      }
    }

    console.log(`[CLEANUP] Completed: scanned=${results.scanned}, deleted=${results.deleted}, skipped=${results.skipped}, errors=${results.errors.length}`);
    
  } catch (error) {
    console.error('[CLEANUP] Error during cleanup:', error);
    results.errors.push(error.message);
  }

  return results;
}

/**
 * Enhanced cleanup that tracks source paths (requires metadata tracking)
 * This would be used if you implement source path tracking in waveform generation
 */
function cleanupWavWaveformsWithSourceTracking(dbFolder, options = {}) {
  const { dryRun = false } = options;
  const results = {
    scanned: 0,
    deleted: 0,
    skipped: 0,
    errors: []
  };

  try {
    const waveformsDir = path.join(dbFolder, 'Waveforms');
    
    if (!fs.existsSync(waveformsDir)) {
      console.log('[CLEANUP] Waveforms directory not found:', waveformsDir);
      return results;
    }

    // This would require implementing metadata tracking in waveform generation
    // For example, storing a .json file alongside each PNG with source path info
    
    console.log('[CLEANUP] Enhanced cleanup requires source path metadata tracking');
    console.log('[CLEANUP] Consider implementing metadata files alongside PNGs');
    
  } catch (error) {
    console.error('[CLEANUP] Error during enhanced cleanup:', error);
    results.errors.push(error.message);
  }

  return results;
}

module.exports = { 
  cleanupWavWaveformsWhenMp3Exists, 
  cleanupWavWaveformsWithSourceTracking 
};
