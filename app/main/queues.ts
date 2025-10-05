import PQueue from 'p-queue';
import { safeSend } from './utils/safeSend';
import * as path from 'path';

// Import the existing queue functions from main.js
// Note: This assumes the main.js functions are available globally or can be imported
// In a real implementation, you might need to refactor main.js to export these functions

declare global {
  var QUEUES: {
    tech: PQueue;
    creative: PQueue;
    instr: PQueue;
  };
}

// Queue debug helper
function queueDebug() {
  const q = global.QUEUES;
  return `{TECH size=${q.tech.size} pending=${q.tech.pending}} {CREATIVE size=${q.creative.size} pending=${q.creative.pending}} {INSTR size=${q.instr.size} pending=${q.instr.pending}}`;
}

// When you enqueue the per-file pipeline, TECH and INSTR already emit UI "QUEUE".
// Do the same for CREATIVE immediately when we plan to run it.
function enqueueTrack(filePath: string) {
  const id = filePath;
  console.log('[QUEUE] enqueueTrack', path.basename(filePath), 'id=', id);
  console.log('[QUEUE] BEFORE-ENQUEUE', queueDebug());

  // NEW: mark Creative as QUEUE in UI (to mirror TECH/INSTR behavior)
  safeSend('pipeline:status', {
    id,
    column: 'CREATIVE',
    status: 'QUEUE'
  });

  // Note: These functions would need to be imported from main.js or refactored
  // For now, this is a placeholder that shows the intended structure
  techQueue.add(async () => runTechnicalAnalysis(id, filePath));

  // Your existing creative scheduling (don't change ordering or concurrency).
  creativeQueue.add(async () => {
    // Guard: flip to START as soon as the job becomes active (renderer shows spinner)
    safeSend('pipeline:status', {
      id,
      column: 'CREATIVE',
      status: 'START'
    });
    await runCreativeForFile(id, filePath);
  });

  instrQueue.add(async () => runInstrumentationForFile(id, filePath));

  console.log('[QUEUE] AFTER-ENQUEUE', queueDebug());
}

// Placeholder functions - these would need to be implemented or imported from main.js
async function runTechnicalAnalysis(id: string, filePath: string) {
  // Implementation would come from main.js
}

async function runCreativeForFile(id: string, filePath: string) {
  // Implementation would come from main.js
}

async function runInstrumentationForFile(id: string, filePath: string) {
  // Implementation would come from main.js
}

export { enqueueTrack, queueDebug };
