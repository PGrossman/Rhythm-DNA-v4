'use strict';

const { probeYamnet } = require('./mediapipe-yamnet.js');
const { probeCLAP } = require('./clap-probe.js');
// const { probeZeroShot } = require('./transformers-zero-shot.js'); // Disabled until zero-shot-audio model available

const ZS_LABELS = [
	'Brass section', 'Trumpet', 'Trombone', 'Saxophone',
	'Lead Vocals', 'Male Vocals', 'Female Vocals', 'Background Vocals',
	'Electric Guitar', 'Acoustic Guitar', 'Piano', 'Drum Kit', 'Synth Pad', 'Synth Lead'
];

async function withTimeout(promise, ms, label) {
	let t;
	const timeout = new Promise((_, rej) => {
		t = setTimeout(() => rej(new Error(label + ' timeout')), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(t);
	}
}

function orHints(a = {}, b = {}) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const out = {};
    for (const k of keys) out[k] = Boolean(a[k]) || Boolean(b[k]);
    return out;
}

// Suppress false positives in merged hints using probe scores when available
function cleanHints(hints, scores = {}) {
    // 1) Banjo vs Guitar – keep existing rule
    if (hints.banjo && hints.guitar) {
        const banjoScore  = scores.banjo || 0;
        const guitarScore = Math.max(scores.guitar || 0, scores['electric guitar'] || 0);
        if (guitarScore > banjoScore * 1.5) {
            hints.banjo = false;
        }
    }

    // 2) Brass gating – avoid generic "brass" unless there's real evidence
    if (hints.brass) {
        const brass     = scores.brass || 0;
        const trumpet   = scores.trumpet || 0;
        const trombone  = scores.trombone || 0;
        const sax       = scores.saxophone || 0;
        const piano     = scores.piano || 0;

        // A family hit means any of the specific brass instruments are present
        const familyHit = (trumpet >= 0.18) || (trombone >= 0.16) || (sax >= 0.18);

        // If no family instrument and generic brass is weak, drop it
        if (!familyHit && brass < 0.22) {
            hints.brass = false;
        }

        // Piano-only veto: strong piano, weak brass family, and not-strong generic brass
        if (hints.brass && piano >= 0.35 && !familyHit && brass < 0.28) {
            hints.brass = false;
        }
    }

    return hints;
}

async function runAudioProbes(filePath, durationSec, baseName = '', opts = {}) {
	// Wider intro window to catch early horns (around ~12-27s)
	const introLen = Math.min(30, Math.max(12, Math.floor(durationSec * 0.12)));

	// Try CLAP first for targeted detection
	let clapIntro = { status: 'skipped' };
	try {
		clapIntro = await withTimeout(
			probeCLAP(filePath, durationSec, { winSec: 15, centerFrac: 0.08 }),
			15000,
			'clap-intro'
		);
	} catch (e) {
		console.log('[CLAP] Intro error:', e.message);
	}

	let intro = { status: 'skipped' };
	try {
		intro = await withTimeout(
			probeYamnet(filePath, durationSec, { winSec: introLen, centerFrac: 0.10, bandpass: true }),
			15000,
			'ast-intro'
		);
		if (intro.labels) console.log('[PROBE] Intro labels:', intro.labels.slice(0, 10));
	} catch (e) {
		intro = { status: 'skipped', error: String(e.message || e) };
	}

	let clapMiddle = { status: 'skipped' };
	try {
		clapMiddle = await withTimeout(
			probeCLAP(filePath, durationSec, { winSec: 8, centerFrac: 0.50 }),
			15000,
			'clap-middle'
		);
	} catch (e) {}

	let middle = { status: 'skipped' };
	try {
		middle = await withTimeout(
			probeYamnet(filePath, durationSec, { winSec: 6, centerFrac: 0.50, bandpass: true }),
			15000,
			'ast-middle'
		);
		if (middle.labels) console.log('[PROBE] Middle labels:', middle.labels.slice(0, 10));
	} catch (e) {
		middle = { status: 'skipped', error: String(e.message || e) };
	}

	let clapOutro = { status: 'skipped' };
	try {
		clapOutro = await withTimeout(
			probeCLAP(filePath, durationSec, { winSec: 8, centerFrac: 0.92 }),
			15000,
			'clap-outro'
		);
	} catch (e) {}

	let outro = { status: 'skipped' };
	try {
		outro = await withTimeout(
			probeYamnet(filePath, durationSec, { winSec: 8, centerFrac: 0.92, bandpass: true }),
			15000,
			'ast-outro'
		);
		if (outro.labels) console.log('[PROBE] Outro labels:', outro.labels.slice(0, 10));
	} catch (e) {
		outro = { status: 'skipped', error: String(e.message || e) };
	}

    // Zero-shot disabled - to re-enable use a zero-shot audio model, e.g. 'Xenova/clap-htsat-unfused'

	// Check if each probe stack detected vocals
	const vocalsClap = Boolean(
		(clapIntro.hints && clapIntro.hints.vocals) ||
		(clapMiddle.hints && clapMiddle.hints.vocals) ||
		(clapOutro.hints && clapOutro.hints.vocals)
	);
	const vocalsAst = Boolean(
		(intro.hints && intro.hints.vocals) ||
		(middle.hints && middle.hints.vocals) ||
		(outro.hints && outro.hints.vocals)
	);

	// Existing merge (change const to let):
	let hints = orHints(
		orHints(clapIntro.hints, clapMiddle.hints),
		orHints(clapOutro.hints, orHints(intro.hints, orHints(middle.hints, outro.hints)))
	);

	// STRONGER rule for vocals: must be seen by BOTH stacks
	hints.vocals = Boolean(vocalsClap && vocalsAst);
    const allScores = Object.assign({}, clapIntro.scores || {}, clapMiddle.scores || {}, clapOutro.scores || {});
    cleanHints(hints, allScores);

	const status = (intro.status === 'ok' || middle.status === 'ok' || outro.status === 'ok') ? 'ok' : 'skipped';
	console.log(`[AUDIO_PROBE] Status: ${status}, Hints:`, hints);
	const labels = {
		intro: (intro.labels || []).slice(0, 10),
		middle: (middle.labels || []).slice(0, 10),
		outro: (outro.labels || []).slice(0, 10)
	};
	const scores = {
		intro: clapIntro.scores || {},
		middle: clapMiddle.scores || {},
		outro: clapOutro.scores || {}
	};
	
	// Format for new aggregation function
	const windowsProbes = [
		{
			clapTop: Object.entries(clapIntro.scores || {}).map(([label, score]) => ({ label, score })).sort((a, b) => b.score - a.score).slice(0, 10),
			astLabels: (intro.labels || []).slice(0, 10)
		},
		{
			clapTop: Object.entries(clapMiddle.scores || {}).map(([label, score]) => ({ label, score })).sort((a, b) => b.score - a.score).slice(0, 10),
			astLabels: (middle.labels || []).slice(0, 10)
		},
		{
			clapTop: Object.entries(clapOutro.scores || {}).map(([label, score]) => ({ label, score })).sort((a, b) => b.score - a.score).slice(0, 10),
			astLabels: (outro.labels || []).slice(0, 10)
		}
	];
	
	return { status, hints, labels, scores, windowsProbes, meta: { introLen, windows: ['0-30s', '50%', '70%'] } };
}

// Instrument aliases for woodwinds mapping
const INSTRUMENT_ALIASES = {
    flute: ["flute", "alto flute", "piccolo", "recorder"],
    clarinet: ["clarinet", "bass clarinet"],
    oboe: ["oboe", "english horn"],
    bassoon: ["bassoon"]
};

module.exports = { runAudioProbes, INSTRUMENT_ALIASES };


