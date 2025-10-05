#!/usr/bin/env node

/**
 * Migration script to normalize keys in existing RhythmDB.json and CriteriaDB.json
 * This script re-keys entries using normalizeKey() so "DriveTo" vs "Drive To" collapse
 */

const fs = require('fs');
const path = require('path');
const { normalizeKey } = require('../app/lib/pathNormalize');

async function migrateNormalizeKeys(dbFolder) {
  console.log('[MIGRATION] Starting key normalization migration with full creative sync...');
  
  const rhythmPath = path.join(dbFolder, 'RhythmDB.json');
  const criteriaPath = path.join(dbFolder, 'CriteriaDB.json');
  
  // Check if databases exist
  if (!fs.existsSync(rhythmPath) || !fs.existsSync(criteriaPath)) {
    console.log('[MIGRATION] Database files not found, skipping migration');
    return;
  }
  
  // Backup original files
  const backupSuffix = new Date().toISOString().replace(/[:.]/g, '-');
  const rhythmBackup = rhythmPath + '.backup-' + backupSuffix;
  const criteriaBackup = criteriaPath + '.backup-' + backupSuffix;
  
  fs.copyFileSync(rhythmPath, rhythmBackup);
  fs.copyFileSync(criteriaPath, criteriaBackup);
  console.log('[MIGRATION] Created backups:', rhythmBackup, criteriaBackup);
  
  try {
    // Load existing databases
    const rhythmData = JSON.parse(fs.readFileSync(rhythmPath, 'utf8'));
    const criteriaData = JSON.parse(fs.readFileSync(criteriaPath, 'utf8'));
    
    // Use the new merger for consistent logic
    const { mergeFromTrackJson } = require('../app/db/mergeFromTrackJson');
    
    const dbState = {
      rhythm: { tracks: {} },
      criteria: {}
    };
    
    console.log('[MIGRATION] Processing', Object.keys(rhythmData.tracks || {}).length, 'rhythm tracks');
    console.log('[MIGRATION] Processing', Object.keys(criteriaData || {}).length, 'criteria entries');
    
    // Process rhythm tracks using the new merger logic
    for (const [oldKey, track] of Object.entries(rhythmData.tracks || {})) {
      const newKey = normalizeKey(track.path || track.file || oldKey);
      
      if (newKey !== oldKey) {
        console.log('[MIGRATION] Re-keying rhythm track:', oldKey, '→', newKey);
      }
      
      // Create a track JSON structure that the merger expects
      const trackJson = {
        source: {
          fileName: track.file,
          filePath: track.path
        },
        technical: {
          bpm: track.estimated_tempo_bpm,
          key: track.key
        },
        creative: track.creative || {},
        analysis: track.analysis || {},
        instrumentation: {
          instruments: track.analysis?.instruments || []
        },
        generatedAt: track.analyzed_at
      };
      
      // Use the new merger to ensure consistent creative sync
      mergeFromTrackJson(dbState, trackJson);
    }
    
    // Process criteria entries (keep existing structure for compatibility)
    for (const [oldKey, criteria] of Object.entries(criteriaData || {})) {
      const newKey = normalizeKey(oldKey);
      
      if (newKey !== oldKey) {
        console.log('[MIGRATION] Re-keying criteria entry:', oldKey, '→', newKey);
      }
      
      // Handle key collisions by merging data
      if (dbState.criteria[newKey]) {
        console.log('[MIGRATION] Criteria key collision detected:', newKey, '- merging data');
        // Merge arrays
        for (const [field, values] of Object.entries(criteria)) {
          if (Array.isArray(values)) {
            const existingValues = dbState.criteria[newKey][field] || [];
            dbState.criteria[newKey][field] = [...new Set([...existingValues, ...values])];
          } else {
            dbState.criteria[newKey][field] = values;
          }
        }
      } else {
        dbState.criteria[newKey] = criteria;
      }
    }
    
    // Write new databases atomically
    const newRhythmData = {
      ...rhythmData,
      tracks: dbState.rhythm.tracks
    };
    
    const tempRhythmPath = rhythmPath + '.tmp';
    const tempCriteriaPath = criteriaPath + '.tmp';
    
    fs.writeFileSync(tempRhythmPath, JSON.stringify(newRhythmData, null, 2), 'utf8');
    fs.writeFileSync(tempCriteriaPath, JSON.stringify(dbState.criteria, null, 2), 'utf8');
    
    // Atomic rename
    fs.renameSync(tempRhythmPath, rhythmPath);
    fs.renameSync(tempCriteriaPath, criteriaPath);
    
    console.log('[MIGRATION] Migration completed successfully');
    console.log('[MIGRATION] New rhythm tracks:', Object.keys(dbState.rhythm.tracks).length);
    console.log('[MIGRATION] New criteria entries:', Object.keys(dbState.criteria).length);
    
  } catch (error) {
    console.error('[MIGRATION] Migration failed:', error);
    console.log('[MIGRATION] Restoring from backups...');
    
    // Restore from backups
    fs.copyFileSync(rhythmBackup, rhythmPath);
    fs.copyFileSync(criteriaBackup, criteriaPath);
    
    throw error;
  }
}

// Run migration if called directly
if (require.main === module) {
  const dbFolder = process.argv[2];
  if (!dbFolder) {
    console.error('Usage: node migrate-normalize-keys.js <dbFolder>');
    process.exit(1);
  }
  
  migrateNormalizeKeys(dbFolder)
    .then(() => {
      console.log('[MIGRATION] Migration completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('[MIGRATION] Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateNormalizeKeys };
