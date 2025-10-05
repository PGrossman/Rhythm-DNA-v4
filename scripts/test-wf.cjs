const path = require('node:path');
const os = require('node:os');
const { ensureWaveformPNG } = require('../app/lib/waveform-png.cjs');

(async () => {
  const abs = process.argv[2];
  if (!abs) { 
    console.error('Usage: node scripts/test-wf.cjs /abs/path/to/file.mp3'); 
    process.exit(1); 
  }
  
  const cacheRoot = path.join(
    os.homedir(), 
    'Library', 
    'Application Support', 
    'RhythmRNA', 
    'waveforms'
  );
  
  console.log('[TEST] Testing waveform generation...');
  console.log('[TEST] Audio file:', abs);
  console.log('[TEST] Cache root:', cacheRoot);
  
  try {
    const png = await ensureWaveformPNG(abs, cacheRoot);
    console.log('[TEST] ✓ PNG created at:', png);
  } catch (e) {
    console.error('[TEST] ✗ Error:', e.message);
    process.exit(1);
  }
})();
