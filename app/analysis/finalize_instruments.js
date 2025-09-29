/**
 * Finalize Instruments Helper (v1.0.1)
 *
 * Canonicalizes section tokens and prunes family members:
 *  - Canonical tokens: "Brass", "Woodwinds" (plural), "Strings"
 *  - Removes "(section)" variants and singular/plural mismatches for woodwinds
 *  - Removes individual family members if the family token is present
 *
 * Preserves ordering and does minimal, defensive transforms.
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
    "Trumpet (mute)",
    "Trumpet (muted)"
  ]);
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
  // NEW: Strings members handling
  const STRING_MEMBERS = new Set([
    "Violin",
    "Viola",
    "Cello",
    "Double Bass",
    "Harp"
  ]);

  // Build a mutable set representing current items
  const outSet = new Set(out);

  // --- Brass handling ---
  const hasBrassMember = [...BRASS_MEMBERS].some(m => outSet.has(m));
  const hasBrass = outSet.has("Brass");

  if (hasBrassMember || hasBrass) {
    // Remove individual brass members
    for (const mem of BRASS_MEMBERS) {
      outSet.delete(mem);
    }
    // Remove legacy section variant if present
    outSet.delete("Brass (section)");

    // Ensure canonical "Brass" exists
    outSet.add("Brass");
  }

  // --- Woodwinds handling ---
  const hasWoodMember = [...WOODWIND_MEMBERS].some(m => outSet.has(m));
  const hasWoodwinds = outSet.has("Woodwinds");

  if (hasWoodMember || hasWoodwinds) {
    // Remove individual woodwind members
    for (const mem of WOODWIND_MEMBERS) {
      outSet.delete(mem);
    }
    // Remove legacy section/singular variants if present
    outSet.delete("Woodwinds (section)");
    outSet.delete("Woodwind"); // defensive

    // Ensure canonical "Woodwinds" exists
    outSet.add("Woodwinds");
  }

  // --- Strings handling (new) ---
  const hasStringMember = [...STRING_MEMBERS].some(m => outSet.has(m));
  const hasStrings = outSet.has("Strings");

  if (hasStringMember || hasStrings) {
    // Remove individual string members
    for (const mem of STRING_MEMBERS) {
      outSet.delete(mem);
    }
    // Remove legacy section variant if present
    outSet.delete("Strings (section)");

    // Ensure canonical "Strings" exists
    outSet.add("Strings");
  }

  // Strings soft-guard: if Strings exists but there are no bowed instruments and only pad-like instruments, remove Strings
  const hasBowed = ["Violin", "Viola", "Cello", "Double Bass"].some(x => outSet.has(x));
  const hasPads = ["Organ", "Electric organ", "Hammond organ", "Keyboard", "Synth"].some(x => outSet.has(x));
  if (outSet.has("Strings") && !hasBowed && hasPads) {
    outSet.delete("Strings");
  }

  // Preserve original order where possible: walk original 'out' and include items still present in outSet
  const final = [];
  const added = new Set();
  for (const i of out) {
    if (outSet.has(i) && !added.has(i)) {
      final.push(i);
      added.add(i);
    }
  }

  // Append any canonical family labels that exist but were not in original order
  for (const f of ["Brass", "Woodwinds", "Strings"]) {
    if (outSet.has(f) && !added.has(f)) {
      final.push(f);
      added.add(f);
    }
  }

  // Ensure canonical capitalization for known family tokens (defensive)
  const canonicalizeCapitalization = inst => {
    if (typeof inst !== "string") return inst;
    const low = inst.toLowerCase();
    if (low === "brass") return "Brass";
    if (low === "woodwinds") return "Woodwinds";
    if (low === "strings") return "Strings";
    return inst;
  };

  const finalCanonical = final.map(canonicalizeCapitalization);

  // Debug log (single concise line)
  if (typeof log === "function") log(`[FINALIZE] canonicalized instruments -> ${finalCanonical.join(", ")}`);
  else console.log(`[FINALIZE] canonicalized instruments -> ${finalCanonical.join(", ")}`);

  return finalCanonical;
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