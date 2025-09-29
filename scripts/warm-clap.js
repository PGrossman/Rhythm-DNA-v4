'use strict';

(async () => {
	const path = require('node:path');
	const fs = require('node:fs');
	const modelsDir = path.resolve(process.cwd(), 'app', 'models', 'xenova');
	fs.mkdirSync(modelsDir, { recursive: true });

	const { env, pipeline } = await import('@xenova/transformers');
	env.cacheDir = modelsDir;
	env.localModelPath = modelsDir;
	env.allowLocalModels = true;
	env.allowRemoteModels = true; // allow fetch during warm
	console.log('[CLAP-WARM] Cache dir:', modelsDir);

	try {
		const clap = await pipeline(
			'zero-shot-audio-classification',
			'Xenova/clap-htsat-unfused',
			{ quantized: false, dtype: 'fp32' }
		);
		console.log('[CLAP-WARM] Model ready:', !!clap);
		console.log('[CLAP-WARM] \u2713 Cached Xenova/clap-htsat-unfused');
	} catch (e) {
		console.error('[CLAP-WARM] \u2717 Failed:', e.message);
		process.exit(1);
	}
})();


