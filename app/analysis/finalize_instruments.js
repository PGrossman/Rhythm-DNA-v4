/**
 * Finalize Instruments Helper
 * 
 * Provides canonical instrument normalization and deduplication
 * to ensure consistency between JSON and CSV outputs.
 */

const CANON_ALIASES = {
  // add common UI normalizations here (non-destructive)
  "Drum set": "Drum Kit (acoustic)",
  "Drums": "Drum Kit (acoustic)",
  "Electric organ": "Organ",
  "Hammond organ": "Organ",
  "Strings": "Strings (section)",
  "Brass": "Brass (section)",
  "Guitars": "Electric Guitar", // fallback if ever seen
};

function normalize(label) {
  const t = (label || "").trim();
  return CANON_ALIASES[t] || t;
}

export function finalizeInstruments({
  ensembleInstruments = [],
  probeRescues = [],
  additional = [],
} = {}) {
  // Merge + normalize first
  const merged = [
    ...ensembleInstruments,
    ...probeRescues,
    ...additional,
  ].map(normalize);

  // stable, case-sensitive dedupe + stable order
  const seen = new Set();
  const out = [];
  for (const inst of merged) {
    if (!inst) continue;
    if (!seen.has(inst)) {
      seen.add(inst);
      out.push(inst);
    }
  }

  // Definition of families to aggregate
  // BRASS_MEMBERS: only individual member instruments (do NOT include "Brass (section)")
  const BRASS_MEMBERS = new Set([
    "Trumpet",
    "Trombone",
    "French Horn",
    "Tuba",
    "Flugelhorn",
    "Cornet",
    "Trumpet (mute)",
    "Trumpet (muted)"
  ]);
  // WOODWIND_MEMBERS: only individual instruments (do NOT include "Woodwinds (section)" or "Woodwinds")
  const WOODWIND_MEMBERS = new Set([
    "Saxophone",
    "Alto Saxophone",
    "Tenor Saxophone",
    "Baritone Saxophone",
    "Flute",
    "Clarinet",
    "Oboe",
    "Bassoon",
    "Piccolo"
  ]);

  // Build a set for quick checks
  const outSet = new Set(out);

  // Collapse individual brass members into the family label, but preserve an explicit
  // "Brass (section)" if the ensemble created it. Also ensure canonical "Brass" exists.
  const hasBrassMember = [...BRASS_MEMBERS].some(m => outSet.has(m));
  const hasBrassSection = outSet.has("Brass (section)");

  if (hasBrassMember || hasBrassSection) {
    // Remove only non-section member instruments
    for (const mem of BRASS_MEMBERS) {
      outSet.delete(mem);
    }

    // Preserve explicit section tag if present; otherwise, add canonical section label
    if (!outSet.has("Brass (section)")) {
      outSet.add("Brass (section)");
    }

    // Also add normalized "Brass" for downstream expectations (keep both if necessary)
    if (!outSet.has("Brass")) {
      outSet.add("Brass");
    }
  }

  // Collapse individual woodwind members into family label, but preserve explicit section tag
  const hasWoodMember = [...WOODWIND_MEMBERS].some(m => outSet.has(m));
  const hasWoodSection = outSet.has("Woodwinds (section)");

  if (hasWoodMember || hasWoodSection) {
    for (const mem of WOODWIND_MEMBERS) {
      outSet.delete(mem);
    }

    if (!outSet.has("Woodwinds (section)")) {
      outSet.add("Woodwinds (section)");
    }

    if (!outSet.has("Woodwinds")) {
      outSet.add("Woodwinds");
    }
  }

  // Preserve existing "Strings (section)" soft-guard behavior:
  const S = new Set(Array.from(outSet));
  const hasStringsSection = S.has("Strings (section)");
  const hasBowed = ["Violin", "Viola", "Cello", "Double Bass"].some(x => S.has(x));
  const hasPads = ["Organ", "Electric organ", "Hammond organ", "Keyboard", "Synth"].some(x => S.has(x));
  if (hasStringsSection && !hasBowed && hasPads) {
    S.delete("Strings (section)");
  }

  // Return an array preserving original insertion order where possible:
  // Build final array by walking original 'out' and then appending any family labels that were newly added
  const final = [];
  const added = new Set();

  // keep original instrument order for known items
  for (const i of out) {
    if (S.has(i) && !added.has(i)) {
      final.push(i);
      added.add(i);
    }
  }
  // finally, if family labels exist but were not in original order, append them
  for (const f of ["Brass", "Woodwinds"]) {
    if (S.has(f) && !added.has(f)) {
      final.push(f);
      added.add(f);
    }
  }
  return final;
}

export function buildSourceFlags({ ensembleInstruments = [], probeRescues = [], additional = [] } = {}) {
  return {
    ensemble_count: ensembleInstruments.length,
    probe_rescues_count: probeRescues.length,
    additional_count: additional.length,
    sources: {
      ensemble: ensembleInstruments.length > 0,
      probe_rescues: probeRescues.length > 0,
      additional: additional.length > 0,
    },
  };
}
