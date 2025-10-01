/**
 * Finalize Instruments Helper
 * 
 * Provides canonical instrument normalization and deduplication
 * to ensure consistency between JSON and CSV outputs.
 *
 * This version canonicalizes section tokens to simple forms:
 *  - "Brass" (no "(section)")
 *  - "Woodwinds" (plural)
 *  - "Strings"
 *
 * It removes individual family members when the family token is present,
 * preserves ordering, and avoids disturbing unrelated logic.
 */

const CANON_ALIASES = {
  // common UI normalizations -> canonical tokens (no "(section)" suffix)
  "Drum set": "Drum Kit (acoustic)",
  "Drums": "Drum Kit (acoustic)",
  "Electric organ": "Organ",
  "Hammond organ": "Organ",
  // Canonicalize family-section forms to simple tokens
  "Strings (section)": "Strings",
  "Strings": "Strings",
  "Brass (section)": "Brass",
  "Brass": "Brass",
  "Woodwinds (section)": "Woodwinds",
  "Woodwinds": "Woodwinds",
  "Woodwind": "Woodwinds",
  "Guitars": "Electric Guitar", // fallback if ever seen
};

function normalize(label) {
  const t = (label || "").trim();
  return CANON_ALIASES[t] || t;
}

function finalizeInstruments({
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

  // --- Brass handling ---
  // If any brass member is present OR canonical "Brass" is present, collapse to canonical "Brass"
  const hasBrassMember = [...BRASS_MEMBERS].some(m => outSet.has(m));
  const hasBrass = outSet.has("Brass");

  if (hasBrassMember || hasBrass) {
    // Remove individual brass members
    for (const mem of BRASS_MEMBERS) {
      outSet.delete(mem);
    }

    // Remove any legacy "(section)" variant if present
    outSet.delete("Brass (section)");

    // Ensure canonical "Brass" exists
    outSet.add("Brass");
  }

  // --- Woodwinds handling ---
  // If any woodwind member is present OR canonical "Woodwinds" present, collapse to canonical "Woodwinds"
  const hasWoodMember = [...WOODWIND_MEMBERS].some(m => outSet.has(m));
  const hasWoodwinds = outSet.has("Woodwinds");

  if (hasWoodMember || hasWoodwinds) {
    // Remove individual woodwind members
    for (const mem of WOODWIND_MEMBERS) {
      outSet.delete(mem);
    }

    // Remove any legacy "(section)" variant if present
    outSet.delete("Woodwinds (section)");
    outSet.delete("Woodwind"); // defensive: remove singular if present

    // Ensure canonical "Woodwinds" exists
    outSet.add("Woodwinds");
  }

  // Preserve existing "Strings" soft-guard behavior:
  // If Strings exists but there are no bowed instruments and only pad-like instruments,
  // remove Strings (mirrors previous logic but uses canonical "Strings").
  // v1.2.0: Add orchestral context check - if Brass present, keep Strings (real orchestral, not synth pads)
  const S = new Set(Array.from(outSet));
  const hasStrings = S.has("Strings");
  const hasBowed = ["Violin", "Viola", "Cello", "Double Bass"].some(x => S.has(x));
  const hasPads = ["Organ", "Electric organ", "Hammond organ", "Keyboard", "Synth"].some(x => S.has(x));
  const hasBrass = S.has("Brass");  // v1.2.0: Orchestral context indicator
  
  // Only remove strings if no bowed instruments, pads present, AND no brass (i.e., not orchestral)
  if (hasStrings && !hasBowed && hasPads && !hasBrass) {
    S.delete("Strings");
  }

  // Return an array preserving original insertion order where possible:
  // Build final array by walking original 'out' and then appending any family labels that were newly added
  const final = [];
  const added = new Set();

  // keep original instrument order for known items (only include if still in S)
  for (const i of out) {
    if (S.has(i) && !added.has(i)) {
      final.push(i);
      added.add(i);
    }
  }
  // finally, if family labels exist but were not in original order, append them
  for (const f of ["Brass", "Woodwinds", "Strings"]) {
    if (S.has(f) && !added.has(f)) {
      final.push(f);
      added.add(f);
    }
  }
  return final;
}

function buildSourceFlags({ ensembleInstruments = [], probeRescues = [], additional = [] } = {}) {
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

// CommonJS exports for require() compatibility
module.exports = {
  finalizeInstruments,
  buildSourceFlags
};