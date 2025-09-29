'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');

let clapPipe = null;

function ffmpegToF32(filePath, startSec, durSec, sr = 48000) {
	return new Promise((resolve, reject) => {
		const args = [
			'-ss', String(startSec),
			'-t', String(durSec),
			'-i', filePath,
			'-ac', '1',
			'-ar', String(sr),
			'-f', 'f32le',
			'-hide_banner', '-loglevel', 'error',
			'pipe:1'
		];
		const p = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });
		const chunks = [];
		let err = '';
		p.stdout.on('data', d => chunks.push(d));
		p.stderr.on('data', d => err += d.toString());
		p.on('close', (code) => {
			if (code !== 0) return reject(new Error(err.trim() || 'ffmpeg failed'));
			const buf = Buffer.concat(chunks);
			const array = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
			resolve({ array, sampling_rate: sr });
		});
	});
}

async function ensureCLAP() {
	if (clapPipe) return clapPipe;
	const { env, pipeline } = await import('@xenova/transformers');

	const modelsDir = path.resolve(process.cwd(), 'app', 'models', 'xenova');
	env.cacheDir = modelsDir;
	env.localModelPath = modelsDir;
	env.allowLocalModels = true;
	env.allowRemoteModels = false;

	try {
		clapPipe = await pipeline(
			'zero-shot-audio-classification',
			'Xenova/clap-htsat-unfused',
			{ quantized: false, dtype: 'fp32' }
		);
		console.log('[CLAP] Loaded from local cache');
		return clapPipe;
	} catch (e) {
		console.log('[CLAP] Load failed:', e.message);
		console.log('[CLAP] Run: npm run warm-clap');
		return null;
	}
}

// Expanded vocabulary and thresholds
const VOCAB = {
	piano: ['piano', 'acoustic piano', 'grand piano', 'upright piano'],
	'acoustic guitar': ['acoustic guitar', 'classical guitar', 'folk guitar'],
	violin: ['violin', 'fiddle', 'string violin'],
	bass: ['bass guitar', 'electric bass', 'bass'],
	cello: ['cello', 'violoncello'],
	drums: ['drum kit', 'drums', 'snare drum', 'kick drum', 'cymbals'],
	percussion: ['percussion', 'tambourine', 'shaker', 'conga', 'bongo'],
	'electric guitar': ['electric guitar', 'distorted guitar', 'rock guitar'],
	accordion: ['accordion', 'squeezebox'],
	banjo: ['banjo'],
	bells: ['bells', 'tubular bells', 'chimes', 'glockenspiel'],
	brass: ['brass section', 'horn section', 'brass instruments'],
	clarinet: ['clarinet'],
	'double bass': ['double bass', 'upright bass', 'contrabass'],
	flute: ['flute'],
	harmonica: ['harmonica', 'mouth organ'],
	harp: ['harp'],
	keyboard: ['keyboard', 'electric piano', 'synthesizer keyboard'],
	mallets: ['xylophone', 'marimba', 'vibraphone', 'mallet percussion'],
	organ: ['organ', 'hammond organ', 'church organ'],
	saxophone: ['saxophone', 'sax', 'alto sax', 'tenor sax'],
	strings: ['string section', 'strings', 'orchestral strings'],
	synth: ['synthesizer', 'synth', 'analog synth'],
	trumpet: ['trumpet', 'cornet'],
	trombone: ['trombone'],
	ukulele: ['ukulele'],
	woodwinds: ['woodwinds', 'wind instruments'],
	// Drop 'voice'/'vocal' — too broad; keep 'singing'/'vocals'
	vocals: ['vocals', 'singing']
};

const THRESHOLDS = {
	piano: 0.10,
	'acoustic guitar': 0.10,
	violin: 0.10,
	bass: 0.08,
	cello: 0.08,
	drums: 0.10,
	percussion: 0.12,
	'electric guitar': 0.08,
	accordion: 0.10,
	banjo: 0.20,
	bells: 0.10,
	brass: 0.15,
	clarinet: 0.12,
	'double bass': 0.12,
	flute: 0.12,
	harmonica: 0.12,
	harp: 0.12,
	keyboard: 0.10,
	mallets: 0.12,
	organ: 0.10,
	saxophone: 0.12,
	strings: 0.10,
	synth: 0.10,
	trumpet: 0.15,
	trombone: 0.08,
	ukulele: 0.15,
	woodwinds: 0.12,
	vocals: 0.20  // was 0.08 - much stricter
};

function buildLabels() {
	const labels = [];
	const reverse = {};
	for (const [canonical, prompts] of Object.entries(VOCAB)) {
		for (const prompt of prompts) {
			labels.push(prompt);
			reverse[prompt] = canonical;
		}
	}
	return { labels, reverse };
}

async function probeCLAP(filePath, durationSec, opts = {}) {
	try {
		const pipe = await ensureCLAP();
		if (!pipe) return { status: 'skipped', error: 'no CLAP' };

		const winSec = opts.winSec ?? 8;
		const centerFrac = opts.centerFrac ?? 0.5;
		const center = Math.max(0, Math.min(durationSec, centerFrac * durationSec));
		const start = Math.max(0, Math.min(durationSec - winSec, center - winSec / 2));

		const { array } = await ffmpegToF32(filePath, start, winSec, 48000);
		const { labels, reverse } = buildLabels();

		const out = await pipe(array, labels, { hypothesis_template: 'This is a sound of {}.' });

		// Aggregate scores by canonical name
		const scores = {};
		for (const item of out) {
			const canonical = reverse[item.label] || item.label;
			scores[canonical] = Math.max(scores[canonical] || 0, item.score);
		}

		// Apply thresholds to build hints
		const hints = {};
		for (const [key, score] of Object.entries(scores)) {
			const threshold = THRESHOLDS[key] || 0.10;
			hints[key] = score >= threshold;
		}

		const topScores = Object.entries(scores)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 10)
			.map(([k, v]) => `${k}:${v.toFixed(3)}`);
		console.log('[CLAP] Top scores:', topScores.join(', '));
		return { status: 'ok', hints, scores, meta: { startSec: start, winSec } };
	} catch (e) {
		console.log('[CLAP] Error:', e.message);
		return { status: 'skipped', error: e.message };
	}
}

module.exports = { probeCLAP };


