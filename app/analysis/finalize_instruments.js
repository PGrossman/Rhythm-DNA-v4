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
  const BRASS_MEMBERS = new Set([
    "Trumpet",
    "Trombone",
    "French Horn",
    "Tuba",
    "Flugelhorn",
    "Cornet",
    // defensive variants
    "Trumpet (mute)",
    "Trumpet (muted)",
    "Brass (section)"
  ]);
  const WOODWIND_MEMBERS = new Set([
    "Saxophone (Tenor)",
    "Saxophone (Alto)",
    "Saxophone (Baritone)",
    "Saxophone",
    "Tenor Sax",
    "Alto Sax",
    "Baritone Sax",
    "Flute",
    "Clarinet",
    "Oboe",
    "English Horn",
    "Bassoon",
    "Piccolo",
    "Woodwind",
    "Woodwinds",
    "Woodwinds (section)"
  ]);

  // Build a set for quick checks
  const outSet = new Set(out);

  // If any brass members present, remove them and add a single "Brass" label
  const hasBrassMember = out.some(i => BRASS_MEMBERS.has(i));
  if (hasBrassMember) {
    for (const mem of BRASS_MEMBERS) outSet.delete(mem);
    // remove variants so we canonicalize to "Brass"
    outSet.delete("Brass (section)");
    outSet.add("Brass");
  }

  // If any woodwind members present, remove them and add a single "Woodwinds" label
  const hasWoodwindMember = out.some(i => WOODWIND_MEMBERS.has(i));
  if (hasWoodwindMember) {
    for (const mem of WOODWIND_MEMBERS) outSet.delete(mem);
    outSet.delete("Woodwinds (section)");
    outSet.add("Woodwinds");
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
