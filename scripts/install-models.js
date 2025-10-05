#!/usr/bin/env node

const { spawn } = require('child_process');

const RECOMMENDED_MODELS = [
  { name: 'qwen3:8b', description: 'Fast, lightweight (8B params)' },
  { name: 'qwen3:30b', description: 'Better quality (30B params)' },
  { name: 'qwen2.5:32b-instruct', description: 'Most accurate (32B params)' },
  { name: 'gemma2:27b-instruct', description: 'Very accurate (27B params)' },
  { name: 'mixtral:8x7b', description: 'Accurate mixture of experts (8x7B)' }
];

console.log('RhythmDNA - Ollama Model Installer');
console.log('=====================================\n');

async function checkOllama() {
  return new Promise((resolve) => {
    const cp = spawn('ollama', ['list'], { shell: true });
    cp.on('error', () => resolve(false));
    cp.on('exit', (code) => resolve(code === 0));
  });
}

async function getInstalledModels() {
  return new Promise((resolve) => {
    const cp = spawn('ollama', ['list'], { shell: true });
    let output = '';
    cp.stdout.on('data', (data) => { output += data.toString(); });
    cp.on('exit', () => {
      const lines = output.split('\n').slice(1); // Skip header
      const models = lines
        .filter(l => l.trim())
        .map(l => l.split(/\s+/)[0])
        .filter(m => m);
      resolve(models);
    });
  });
}

async function pullModel(model) {
  return new Promise((resolve) => {
    console.log(`\nPulling ${model}...`);
    console.log('This may take several minutes depending on model size and internet speed.\n');
    const cp = spawn('ollama', ['pull', model], { shell: true, stdio: 'inherit' });
    cp.on('exit', (code) => resolve(code === 0));
  });
}

async function main() {
  const ollamaAvailable = await checkOllama();
  if (!ollamaAvailable) {
    console.error('ERROR: Ollama is not installed or not in PATH');
    console.log('\nPlease install Ollama first:');
    console.log('  Visit: https://ollama.ai');
    console.log('  Or run: brew install ollama (on macOS)');
    process.exit(1);
  }

  const installed = await getInstalledModels();
  console.log('Currently installed models:');
  if (installed.length === 0) console.log('  (none)');
  else installed.forEach(m => console.log(`  - ${m}`));

  console.log('\nRecommended models for RhythmDNA:');
  RECOMMENDED_MODELS.forEach(m => {
    const status = installed.includes(m.name) ? '✓ Installed' : '○ Not installed';
    console.log(`  ${status} - ${m.name}: ${m.description}`);
  });

  const toInstall = RECOMMENDED_MODELS.filter(m => !installed.includes(m.name));
  if (toInstall.length === 0) {
    console.log('\n✓ All recommended models are already installed!');
    process.exit(0);
  }

  console.log('\nWould you like to install the missing models?');
  console.log('Press Ctrl+C to cancel, or press Enter to continue...');
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
    process.stdin.resume();
  });

  for (const m of toInstall) {
    const ok = await pullModel(m.name);
    console.log(ok ? `✓ Successfully installed ${m.name}` : `✗ Failed to install ${m.name}`);
  }

  console.log('\n✓ Model installation complete!');
  console.log('You can now run: npm start');
}

main().catch(err => { console.error(err); process.exit(1); });
