'use strict';

let pipeline = null;
async function ensurePipeline() {
	if (pipeline) return pipeline;
	try {
		const tfjs = await import('@xenova/transformers');
		pipeline = await tfjs.pipeline('zero-shot-classification', 'Xenova/clip-vit-base-patch32');
		return pipeline;
	} catch (e) {
		console.log('[ZERO-SHOT] Pipeline init failed:', e.message);
		return null;
	}
}

async function probeZeroShot(textDescription, labels, opts = {}) {
	try {
		const clf = await ensurePipeline();
		if (!clf) return { status: 'skipped', error: 'Pipeline unavailable' };
		const res = await clf(textDescription, labels, { multi_label: true });
		const scores = Object.fromEntries(res.labels.map((label, i) => [label, res.scores[i]]));
		return { status: 'ok', scores, labels };
	} catch (e) {
		console.log('[ZERO-SHOT] Error:', e.message);
		return { status: 'skipped', error: String(e.message || e) };
	}
}

module.exports = { probeZeroShot };


