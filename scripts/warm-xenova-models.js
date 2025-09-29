#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');

(async () => {
  console.log('Warming Xenova models for offline use...');
  console.log('This will download and cache Xenova/yamnet locally.');

  const modelsDir = path.resolve(process.cwd(), 'app', 'models', 'xenova');
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  const { pipeline, env } = await import('@xenova/transformers');
  const token = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || process.env.HF_API_TOKEN || '';
  env.cacheDir = modelsDir;
  env.localModelPath = modelsDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // allow network for warm-up
  if (token) {
    env.HF_TOKEN = token;
    console.log('Using HF token from environment.');
  } else {
    console.log('No HF token found in env (HF_TOKEN). Proceeding without auth...');
  }

  console.log('Cache directory:', modelsDir);
  try {
    console.log('Downloading Xenova/yamnet...');
    await pipeline('audio-classification', 'Xenova/yamnet');
    console.log('✓ YAMNet model cached successfully');
  } catch (e) {
    console.error('✗ Failed to download YAMNet:', e.message);
    console.error('If the error is Unauthorized, set a Hugging Face token and retry:');
    console.error('  export HF_TOKEN=hf_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    console.error('Then run: npm run warm-models');
    process.exit(1);
  }

  console.log('All done. You can now run the app offline.');
})();


