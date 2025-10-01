#!/usr/bin/env python3
from __future__ import annotations
"""
Ensemble instrument analyzer for high-accuracy tagging.

Pipeline:
- (Optional) Demucs htdemucs separation to get 'other' stem (helps piano confirmation)
- Sliding windows (5s, 50% hop) over mixture (and optionally other stem)
- PANNs (CNN14) + YAMNet per-window probabilities
- Track-level decision via conservative rules:
  * model-positive if (mean_prob >= 0.35 AND positive_windows >= 20%)
  * track-positive if (both models positive) OR (max mean_prob >= 0.60 AND max pos_windows >= 10%)
- Brass gate: 'Brass (section)' requires any of {trumpet|trombone|saxophone} positive OR generic brass >= 0.45
- Piano veto: if piano is strong and no brass-family positive and generic brass < 0.50 => drop brass

Outputs JSON to stdout or file:
{
  "instruments": ["Piano", "Electric Guitar", "Brass (section)", ...],
  "scores": { "piano": 0.91, "trumpet": 0.08, "brass": 0.12, ... },
  "decision_trace": {
     "window_sec": 5.0, "hop_sec": 2.5, "num_windows": N,
     "per_model": {
        "panns": { "mean_probs": {...}, "pos_ratio": {...} },
        "yamnet":{ "mean_probs": {...}, "pos_ratio": {...} }
     },
     "rules": { "mean_thresh": 0.35, "pos_ratio_thresh": 0.20, "single_high": 0.60 }
  },
  "used_demucs": true|false
}
"""

__version__ = "mixrecall-2025-09-21-ww-drum-v1"
import os, sys, json, math, logging, time, pathlib, traceback
from dataclasses import dataclass
from typing import Dict, List, Tuple, Any, Set
from datetime import datetime
from pathlib import Path
import warnings
import re

# Per-window dump toggle for slim logging mode
import os as _os
_PER_WINDOW = _os.getenv("RNA_PER_WINDOW", "0") == "1"

# RUNTIME BANNER: unmistakable module-load marker so we can confirm the Python worker loaded this patched file.
try:
    # Use stderr so it is visible in most log setups
    import sys, os
    sys.stderr.write(f"[runtime-instrument] instruments_ensemble loaded: {__file__} cwd={os.getcwd()} pid={os.getpid()}\n")
    sys.stderr.flush()
except Exception as _e:
    try:
        sys.stderr.write(f"[runtime-instrument] instruments_ensemble load banner failed: {_e}\n")
        sys.stderr.flush()
    except Exception:
        pass

import numpy as np

# Logging
logger = logging.getLogger("ENSEMBLE")

# --- COMPATIBILITY WRAPPERS: tolerant _combined_mean / _combined_mean_pos ----------------
import sys
import logging
_log = logging.getLogger("instruments_ensemble")

# Module load banner (stderr for runtime visibility)
try:
    sys.stderr.write(f"[runtime-instrument] instruments_ensemble loaded: {__file__} cwd={__import__('os').getcwd()} pid={__import__('os').getpid()}\n")
    sys.stderr.flush()
except Exception:
    pass

def _combined_mean_compat(*args, **kwargs):
    """
    Compatibility wrapper for _combined_mean:
    - Accepts either:
      1) (_y_means)                           --> legacy single-arg dict
      2) (y_means, key)                       --> newer usage
      3) (y_means, y_pos, key)                --> another newer pattern (ignored y_pos)
    - Returns a float combined mean (or 0.0 on bad input).
    """
    try:
        # Small runtime log to indicate invocation
        try:
            sys.stderr.write(f"[runtime-instrument] _combined_mean_compat called args_len={len(args)} kwargs_keys={list(kwargs.keys())}\n")
            sys.stderr.flush()
        except Exception:
            pass

        # Case A: single positional arg (legacy)
        if len(args) == 1:
            y_means = args[0] or {}
            # If nested per-model dicts, flatten numeric leaves
            vals = []
            if isinstance(y_means, dict):
                for v in y_means.values():
                    if isinstance(v, dict):
                        vals.extend([float(x) for x in v.values() if isinstance(x, (int, float))])
                    elif isinstance(v, (int, float)):
                        vals.append(float(v))
            return float(sum(vals) / len(vals)) if vals else 0.0

        # Case B: (y_means, key) or (y_means, y_pos, key)
        key = None
        if len(args) >= 2 and isinstance(args[1], str):
            y_means = args[0] or {}
            key = args[1]
        elif len(args) >= 3:
            y_means = args[0] or {}
            key = args[2]
        else:
            y_means = kwargs.get('y_means', {}) or {}
            key = kwargs.get('key', None)

        if not key:
            # average all numeric leaves
            vals = []
            for v in y_means.values():
                if isinstance(v, (int, float)):
                    vals.append(float(v))
                elif isinstance(v, dict):
                    vals.extend([float(x) for x in v.values() if isinstance(x, (int, float))])
            return float(sum(vals) / len(vals)) if vals else 0.0

        # look for key in top-level or nested per-model maps
        if key in y_means and isinstance(y_means[key], (int, float)):
            return float(y_means[key])
        vals = []
        for model_v in y_means.values():
            if isinstance(model_v, dict) and key in model_v:
                try:
                    vals.append(float(model_v[key]))
                except Exception:
                    continue
        return float(sum(vals) / len(vals)) if vals else 0.0

    except Exception as e:
        _log.debug("compat _combined_mean failed: %s", e)
        return 0.0

# Bind the name so existing callers work unchanged
_combined_mean = _combined_mean_compat

def _combined_mean_pos_compat(*args, **kwargs):
    """
    Compatibility wrapper for _combined_mean_pos:
    - Supports legacy single-dict input or explicit (y_means, y_pos, key).
    - Returns (combined_mean, combined_pos) tuple of floats.
    """
    try:
        # runtime banner for invocation
        try:
            sys.stderr.write(f"[runtime-instrument] _combined_mean_pos_compat called args_len={len(args)} kwargs_keys={list(kwargs.keys())}\n")
            sys.stderr.flush()
        except Exception:
            pass

        # Single dict case: try to extract mean_probs and pos_ratio if present
        if len(args) == 1:
            data = args[0] or {}
            if isinstance(data, dict):
                means = data.get('mean_probs') or {}
                poss = data.get('pos_ratio') or {}
                # fallback: scan nested dicts for numeric leaves
                if not means:
                    for v in data.values():
                        if isinstance(v, dict):
                            means = v
                            break
                mean_vals = [float(x) for x in means.values() if isinstance(x, (int, float))]
                pos_vals = [float(x) for x in poss.values() if isinstance(x, (int, float))]
                avg_mean = float(sum(mean_vals) / len(mean_vals)) if mean_vals else 0.0
                avg_pos = float(sum(pos_vals) / len(pos_vals)) if pos_vals else 0.0
                return (avg_mean, avg_pos)

        # Explicit params: (y_means, y_pos, key) or (y_means, key)
        if len(args) >= 3:
            y_means, y_pos, key = args[0] or {}, args[1] or {}, args[2]
        elif len(args) == 2:
            y_means, key = args[0] or {}, args[1]
            y_pos = kwargs.get('y_pos', {}) or {}
        else:
            y_means = kwargs.get('y_means', {}) or {}
            y_pos = kwargs.get('y_pos', {}) or {}
            key = kwargs.get('key', None)

        combined_mean = 0.0
        combined_pos = 0.0
        if key:
            # mean extraction
            if key in y_means and isinstance(y_means[key], (int, float)):
                combined_mean = float(y_means[key])
            else:
                vals = []
                for m in (y_means or {}).values():
                    if isinstance(m, dict) and key in m:
                        try:
                            vals.append(float(m[key]))
                        except Exception:
                            continue
                combined_mean = float(sum(vals) / len(vals)) if vals else 0.0
            # pos extraction
            if key in (y_pos or {}) and isinstance((y_pos or {})[key], (int, float)):
                combined_pos = float((y_pos or {})[key])
            else:
                pos_vals = []
                for p in (y_pos or {}).values():
                    if isinstance(p, dict) and key in p:
                        try:
                            pos_vals.append(float(p[key]))
                        except Exception:
                            continue
                combined_pos = float(sum(pos_vals) / len(pos_vals)) if pos_vals else 0.0
        else:
            # no key: average numeric leaves across structures
            mean_vals = []
            pos_vals = []
            for v in (y_means or {}).values():
                if isinstance(v, (int, float)):
                    mean_vals.append(float(v))
                elif isinstance(v, dict):
                    mean_vals.extend([float(x) for x in v.values() if isinstance(x, (int, float))])
            for v in (y_pos or {}).values():
                if isinstance(v, (int, float)):
                    pos_vals.append(float(v))
                elif isinstance(v, dict):
                    pos_vals.extend([float(x) for x in v.values() if isinstance(x, (int, float))])
            combined_mean = float(sum(mean_vals) / len(mean_vals)) if mean_vals else 0.0
            combined_pos = float(sum(pos_vals) / len(pos_vals)) if pos_vals else 0.0

        return (combined_mean, combined_pos)
    except Exception as e:
        _log.debug("compat _combined_mean_pos failed: %s", e)
        return (0.0, 0.0)

# Bind name for backwards compatibility
_combined_mean_pos = _combined_mean_pos_compat
# --- END COMPATIBILITY WRAPPERS ------------------------------------------------------

# --- DEBUG LOGGING SETUP ---
def _ens_log_dir():
    # ENV wins; otherwise your requested folder
    return os.environ.get(
        'ENSEMBLE_LOG_DIR',
        '/Volumes/ATOM RAID/Dropbox/_Personal Files/12 - AI Vibe Coding/02 - Cursor Projects/02 - RhythmRNA V3/Logs'
    )

def _safe_mkdir(p):
    try:
        pathlib.Path(p).mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

def _slug(s: str) -> str:
    return ''.join([c if c.isalnum() or c in ('_', '-', '.') else '_' for c in (s or '')])

def _nowstamp():
    return time.strftime('%Y-%m-%d_%H-%M-%S')

def _debug_write_json(basename: str, obj):
    try:
        d = _ens_log_dir()
        _safe_mkdir(d)
        fp = os.path.join(d, f'{basename}.json')
        with open(fp, 'w', encoding='utf-8') as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
    except Exception:
        pass

_SLUG_RX = re.compile(r'[^A-Za-z0-9_.-]+')

def _slugify_name(p: str) -> str:
    """
    Turn a path or label into a safe filename slug.
    """
    base = os.path.basename(p) if p else "unknown"
    base = base.replace(' ', '_')
    return _SLUG_RX.sub('_', base)

def _log_prefix(log_dir: str, audio_path: str) -> str:
    """
    Build a stable log file prefix using the ACTUAL input file's basename.
    """
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    name = _slugify_name(audio_path)
    Path(log_dir).mkdir(parents=True, exist_ok=True)
    return os.path.join(log_dir, f"ensemble-python-{name}-{ts}")

def _log_basename(audio_path: str) -> str:
    # Always derive from the real input path
    base = os.path.basename(audio_path or "").strip()
    if not base:
        # last-ditch: timestamp only, no fake track name
        return datetime.now().strftime("unknown-%Y-%m-%d_%H-%M-%S")
    # Make it filesystem-friendly
    base = base.replace(os.sep, "_").replace(" ", "_")
    return base

def _get_combined_means_and_pos(trace, key):
    """
    Returns (combined_mean, combined_pos) for an instrument key from decision_trace.
    Reads PANNs + YAMNet mean_probs/pos_ratio and sums them.
    Keys expected like: 'piano','organ','strings','brass','acoustic_guitar','drum_kit','bass_guitar'.
    """
    try:
        p = trace.get("per_model", {}).get("panns", {})
        y = trace.get("per_model", {}).get("yamnet", {})
        pm = (p.get("mean_probs", {}) or {}).get(key, 0.0)
        ym = (y.get("mean_probs", {}) or {}).get(key, 0.0)
        pr = (p.get("pos_ratio", {}) or {}).get(key, 0.0)
        yr = (y.get("pos_ratio", {}) or {}).get(key, 0.0)
        return (float(pm) + float(ym), float(pr) + float(yr))
    except Exception:
        return (0.0, 0.0)

def _get_model_stat(trace, model, stat, key, default=0.0):
    try:
        return float(trace["per_model"].get(model, {}).get(stat, {}).get(key, 0.0))
    except Exception:
        return default

def _combined_mean_legacy(trace, key):
    pm = _get_model_stat(trace, "panns", "mean_probs", key)
    ym = _get_model_stat(trace, "yamnet", "mean_probs", key)
    return pm + ym

def _has_pos(trace, key):
    """Check if any model has pos_ratio > 0 for the given key."""
    try:
        per_model = trace.get("per_model", {})
        panns_pos = per_model.get("panns", {}).get("pos_ratio", {}).get(key, 0.0)
        yamnet_pos = per_model.get("yamnet", {}).get("pos_ratio", {}).get(key, 0.0)
        return (panns_pos > 0.0) or (yamnet_pos > 0.0)
    except Exception:
        return False

def _any_pos(trace, key):
    pp = _get_model_stat(trace, "panns", "pos_ratio", key)
    yp = _get_model_stat(trace, "yamnet", "pos_ratio", key)
    return max(pp, yp)

def _panns_mean(trace, key):
    return _get_model_stat(trace, "panns", "mean_probs", key)

def _has(instruments, name):
    return any(i.lower() == name.lower() for i in instruments)

def _add(instruments, name):
    if not _has(instruments, name):
        instruments.append(name)

WOODWIND_KEYS = [
  "flute", "piccolo", "clarinet", "oboe", "bassoon",
  "saxophone", "woodwinds"
]

def _combined_mean_legacy2(models, key):
    """Sum mean_probs across known models (e.g., panns + yamnet)."""
    total = 0.0
    for m in ("panns", "yamnet"):
        total += float(models.get(m, {}).get("mean_probs", {}).get(key, 0.0) or 0.0)
    return total

def _combined_pos(models, key):
    """Sum/aggregate pos_ratio across known models."""
    total = 0.0
    for m in ("panns", "yamnet"):
        total += float(models.get(m, {}).get("pos_ratio", {}).get(key, 0.0) or 0.0)
    return total

def _present_as_section(name):
    return name[0].upper() + name[1:]

def _resolve_keys_woodwinds():
    """
    Return a list of model label keys to check for orchestral woodwinds.
    Handles common variants across PANNs/YAMNet.
    """
    # primary keys
    keys = [
        'flute', 'piccolo',         # piccolo sometimes maps to flute/piccolo
        'clarinet',
        'oboe',
        'bassoon',
    ]
    # some models expose capitalized or spaced variants
    variants = [
        'Flute', 'Piccolo', 'Clarinet', 'Oboe', 'Bassoon'
    ]
    return list(dict.fromkeys(keys + variants))

def _get_model_stat(trace, model, stat, key, default=0.0):
    # safe extractor: returns 0.0 if missing
    try:
        return float(trace['per_model'][model][stat].get(key, default))
    except Exception:
        return default

def _combined_stat_for_key(trace, key):
    """Return (combined_mean, combined_pos, panns_pos, yamnet_pos, panns_mean, yamnet_mean) for a label key."""
    p_mean = _get_model_stat(trace, 'panns', 'mean_probs', key)
    y_mean = _get_model_stat(trace, 'yamnet', 'mean_probs', key)
    p_pos  = _get_model_stat(trace, 'panns', 'pos_ratio',  key)
    y_pos  = _get_model_stat(trace, 'yamnet', 'pos_ratio', key)
    return (p_mean + y_mean, p_pos + y_pos, p_pos, y_pos, p_mean, y_mean)

def _context_orchestral_ok(decisions, trace, ctx_gate):
    # gate on strings/brass presence or adequate means
    strings_mean = (_get_model_stat(trace, 'panns', 'mean_probs', 'strings')
                    + _get_model_stat(trace, 'yamnet', 'mean_probs', 'strings'))
    brass_mean   = (_get_model_stat(trace, 'panns', 'mean_probs', 'brass')
                    + _get_model_stat(trace, 'yamnet', 'mean_probs', 'brass'))
    strings_present = 'Strings (section)' in decisions or strings_mean >= ctx_gate
    brass_present   = 'Brass (section)'   in decisions or brass_mean   >= ctx_gate
    return (strings_present or brass_present), strings_mean, brass_mean

def _sax_guard(trace):
    """Return combined (mean,pos) for saxophone to help guard orchestral reeds."""
    return _combined_stat_for_key(trace, 'saxophone')[:2]  # (mean, pos)

# --- NEW: woodwinds helpers (mix-only) ---------------------------------------
WOODWIND_KEYS = [
    "flute", "piccolo", "clarinet", "oboe", "bassoon",
    "woodwind", "woodwinds", "recorder"
]

def _comb(a, b):
    try:
        return float(a or 0.0) + float(b or 0.0)
    except Exception:
        return 0.0

# -------- Woodwinds helper utilities --------
def _get_model_stat(decision_trace, model, stat_group, key, default=0.0):
    try:
        return float(decision_trace["per_model"][model][stat_group].get(key, default))
    except Exception:
        return default

def _first_key(d, keys):
    for k in keys:
        if k in d: return k
    return None

def _resolve_ww_keys(decision_trace):
    """
    Resolve model-specific labels that might vary (case/alias).
    We deliberately EXCLUDE 'saxophone' from woodwinds gating to avoid false positives.
    """
    pm = decision_trace.get("per_model", {})
    candidates = {
        "flute":    ["flute", "Flute", "piccolo", "Piccolo"],
        "clarinet": ["clarinet", "Clarinet"],
        "oboe":     ["oboe", "Oboe"],
        "bassoon":  ["bassoon", "Bassoon"],
    }
    resolved = {"panns": {}, "yamnet": {}}
    for model in ("panns", "yamnet"):
        mean_map = pm.get(model, {}).get("mean_probs", {})
        pos_map  = pm.get(model, {}).get("pos_ratio", {})
        for canon, variants in candidates.items():
            mk = _first_key(mean_map, variants) or canon
            pk = _first_key(pos_map,  variants) or canon
            resolved[model][canon] = (mk, pk)
    return resolved

def _combined_mean_pos(decision_trace, resolved_keys):
    """
    Returns dict {canon: (combined_mean, combined_pos, panns_pos, yamnet_pos)}
    where combined_* is panns + yamnet.
    """
    out = {}
    for canon, _ in resolved_keys["panns"].items():
        p_mk, p_pk = resolved_keys["panns"][canon]
        y_mk, y_pk = resolved_keys["yamnet"][canon]
        p_mean = _get_model_stat(decision_trace, "panns", "mean_probs", p_mk)
        y_mean = _get_model_stat(decision_trace, "yamnet", "mean_probs", y_mk)
        p_pos  = _get_model_stat(decision_trace, "panns", "pos_ratio",  p_pk)
        y_pos  = _get_model_stat(decision_trace, "yamnet", "pos_ratio", y_pk)
        out[canon] = (p_mean + y_mean, p_pos + y_pos, p_pos, y_pos)
    return out

def _combined_model_stats(decision_trace, key):
    pm = decision_trace.get("per_model", {})
    panns = pm.get("panns", {})
    yam   = pm.get("yamnet", {})
    mean  = panns.get("mean_probs", {}).get(key, 0.0) + yam.get("mean_probs", {}).get(key, 0.0)
    pos   = panns.get("pos_ratio", {}).get(key, 0.0) + yam.get("pos_ratio", {}).get(key, 0.0)
    return mean, pos

def _sum_woodwind_evidence(trace):
    """
    Returns (sum_mean, sum_pos, any_pos_max, per_model_dump) from decision_trace.
    Uses both PANNs and YAMNet means and pos_ratio when present.
    """
    per_model = trace.get("per_model", {})
    def _accum(model_name):
        m = per_model.get(model_name, {})
        means = m.get("mean_probs", {}) or {}
        poss  = m.get("pos_ratio", {}) or {}
        s_mean = 0.0
        s_pos  = 0.0
        any_pos = 0.0
        for k in WOODWIND_KEYS:
            s_mean += float(means.get(k, 0.0))
            p = float(poss.get(k, 0.0))
            s_pos += p
            if p > any_pos:
                any_pos = p
        return s_mean, s_pos, any_pos, {"means": {k: float(means.get(k, 0.0)) for k in WOODWIND_KEYS},
                                        "pos":   {k: float(poss.get(k, 0.0))  for k in WOODWIND_KEYS}}
    p_mean, p_pos, p_any, p_dump = _accum("panns")
    y_mean, y_pos, y_any, y_dump = _accum("yamnet")
    sum_mean = p_mean + y_mean
    sum_pos  = p_pos + y_pos
    any_pos  = max(p_any, y_any)
    return sum_mean, sum_pos, any_pos, {"panns": p_dump, "yamnet": y_dump}

def _aggregate_woodwinds(decision_trace):
    per_inst = {}
    sum_mean = 0.0
    sum_pos  = 0.0
    for k in WOODWIND_KEYS:
        m, p = _combined_model_stats(decision_trace, k)
        if m > 0.0 or p > 0.0:
            per_inst[k] = {"mean": m, "pos": p}
            sum_mean += m
            sum_pos  += p
    return per_inst, sum_mean, sum_pos

def _mix_only_woodwinds_v2(picks, decision_trace, added):
    # Context: only consider if strings + brass are already present
    strings_present = any(x.lower().startswith("strings") for x in picks)
    brass_present   = any(x.lower().startswith("brass")   for x in picks)
    thresholds = {
        "sum_mean_min": 0.0045,   # very conservative; we're summing multiple classes
        "sum_pos_min":  0.015,
        "any_pos_min":  0.010,    # at least one woodwind gets some positive frames
        "context_gate": 0.0       # strings/brass presence is our main gate
    }

    per_inst, sum_mean, sum_pos = _aggregate_woodwinds(decision_trace)
    ctx = {
        "strings_present": strings_present,
        "brass_present":   brass_present
    }

    # record trace (if you keep decision_trace logging)
    try:
        decision_trace.setdefault("boosts", {})["mix_only_woodwinds_v2"] = {
            "booster": "mix_only_woodwinds_v2",
            "thresholds": thresholds,
            "per_instrument": per_inst,
            "sums": {"mean": sum_mean, "pos": sum_pos},
            "context": ctx,
        }
    except Exception:
        pass

    if not (strings_present and brass_present):
        return

    if sum_mean < thresholds["sum_mean_min"] or sum_pos < thresholds["sum_pos_min"]:
        return

    any_pos_ok = any(v.get("pos", 0.0) >= thresholds["any_pos_min"] for v in per_inst.values())
    if not any_pos_ok:
        return

    label = "Woodwinds (section)"
    if label not in picks:
        picks.append(label)
        added.append(label)

# --- END: woodwinds helpers ---------------------------------------------------

def _boost_mix_only_orchestral(trace, already):
    """
    Conservative, mix-only booster for orchestral sections + keyboards.
    Uses the exact decision_trace structure you log today.
    Returns a list of DISPLAY names to add, without duplicates.
    Calibrated against your posted Beatles/Beach Boys traces.
    """
    picks = []
    add = lambda name: (name not in already) and (name not in picks) and picks.append(name)

    # Thresholds tuned to your trace for "A Day in the Life"
    TH = {
        "piano":   {"mean": 0.0050, "pos": 0.015},  # PANNs 0.0054 + YAM 0.0016 ~= 0.0070, pos ~= 0.0165
        "organ":   {"mean": 0.0040, "pos": 0.012},  # PANNs 0.0044 + YAM 0.0008 ~= 0.0052
        "strings": {"mean": 0.0090, "pos": 0.060},  # v1.2.0: make orchestral booster require higher strings mean/pos AND tiny YAMNet presence to avoid synth-pad false positives (Down Under)
        "brass":   {"mean": 0.0055, "pos": 0.005},  # lowered to allow short brass solos (mean≈0.0061, pos≈0.0084 seen)
        "bass_guitar": {"mean": 0.0060, "pos": 0.020},  # may not fire on this track; safe conservative gate
    }

    # 1) Keyboards
    m, r = _get_combined_means_and_pos(trace, "piano")
    if m >= TH["piano"]["mean"] and r >= TH["piano"]["pos"]:
        add("Piano")
    m, r = _get_combined_means_and_pos(trace, "organ")
    if m >= TH["organ"]["mean"] and r >= TH["organ"]["pos"]:
        add("Organ")

    # 2) Sections (with hard gate requiring pos_ratio > 0)
    m, r = _get_combined_means_and_pos(trace, "strings")
    # v1.2.0: make orchestral booster require higher strings mean/pos AND tiny YAMNet presence to avoid synth-pad false positives (Down Under).
    y_strings_mean = trace.get("per_model", {}).get("yamnet", {}).get("mean_probs", {}).get("strings", 0.0)
    y_strings_pos = trace.get("per_model", {}).get("yamnet", {}).get("pos_ratio", {}).get("strings", 0.0)
    yamnet_ok = (y_strings_mean >= 0.0008) or (y_strings_pos > 0.0)
    if m >= TH["strings"]["mean"] and r >= TH["strings"]["pos"] and _has_pos(trace, "strings") and yamnet_ok:
        add("Strings (section)")
    m, r = _get_combined_means_and_pos(trace, "brass")
    if m >= TH["brass"]["mean"] and r >= TH["brass"]["pos"] and _has_pos(trace, "brass"):
        add("Brass (section)")

    # 3) Bass guitar (optional; won't trigger on your posted Beatles trace, but helps other tracks)
    m, r = _get_combined_means_and_pos(trace, "bass_guitar")
    if m >= TH["bass_guitar"]["mean"] and r >= TH["bass_guitar"]["pos"]:
        add("Bass Guitar")

    # Trace what we did (for your Logs)
    try:
        boost_log = {
            "booster": "mix_only_orchestral_v1",
            "thresholds": TH,
            "decisions": {
                "piano":         _get_combined_means_and_pos(trace, "piano"),
                "organ":         _get_combined_means_and_pos(trace, "organ"),
                "strings":       _get_combined_means_and_pos(trace, "strings"),
                "brass":         _get_combined_means_and_pos(trace, "brass"),
                "bass_guitar":   _get_combined_means_and_pos(trace, "bass_guitar"),
            },
            "added": picks[:],
        }
        trace.setdefault("boosts", {})
        trace["boosts"]["mix_only_orchestral_v1"] = boost_log
    except Exception:
        pass

    return picks

def _merge_instruments(existing, extra):
    if not extra:
        return existing
    s = set(existing) | set(extra)
    return sorted(s, key=lambda x: x.lower())

# --- mix-only core booster helpers ------------------------------------------

def _trace_get_means_pos(decision_trace):
    """Return (p_means, p_pos, y_means, y_pos) dicts from decision_trace, or empty dicts."""
    pm = decision_trace.get("per_model", {}).get("panns", {})
    ym = decision_trace.get("per_model", {}).get("yamnet", {})
    p_means = pm.get("mean_probs", {}) or {}
    p_pos   = pm.get("pos_ratio",  {}) or {}
    y_means = ym.get("mean_probs", {}) or {}
    y_pos   = ym.get("pos_ratio",  {}) or {}
    return p_means, p_pos, y_means, y_pos

def _combined_mean_pos(p_means, p_pos, y_means, y_pos, key):
    """Combined mean & pos_ratio across PANNs + YAMNet for an instrument key."""
    cm = float(p_means.get(key, 0.0)) + float(y_means.get(key, 0.0))
    cp = float(p_pos.get(key, 0.0))   + float(y_pos.get(key, 0.0))
    return cm, cp

def _title_for_core(key):
    """Map model keys to UI labels."""
    return {
        "acoustic_guitar": "Acoustic Guitar",
        "electric_guitar": "Electric Guitar",
        "drum_kit":        "Drum Kit (acoustic)",
        "bass_guitar":     "Bass Guitar",
    }.get(key, key)

def _apply_mix_only_core_boost(decision_trace, already):
    """
    Conservative mix-only booster for obvious core band.
    Uses combined PANNs+YAMNet evidence already in decision_trace.
    Returns (added_labels, audit_dict).
    """
    p_means, p_pos, y_means, y_pos = _trace_get_means_pos(decision_trace)

    # Use MIX_ONLY_CORE_V2 thresholds
    TH = {
        "acoustic_guitar": {"mean": 0.006, "pos": 0.023},
        "drum_kit":        {"mean": 0.006, "pos": 0.030},
        "electric_guitar": {"mean": 0.006, "pos": 0.023},
        "bass_guitar":     {"mean": 0.004, "pos": 0.000},
    }

    decisions = {}
    picked = []
    for key, gates in TH.items():
        cm, cp = _combined_mean_pos(p_means, p_pos, y_means, y_pos, key)
        pass_core = (cm >= gates["mean"] and cp >= gates["pos"])
        # Small escape hatch: strong PANNs-only pos can force a pass for strings/plucked; here keep it conservative
        p_only_strong = float(p_pos.get(key, 0.0)) >= max(0.060, gates["pos"])
        decision = {
            "combined_mean": round(cm, 6),
            "combined_pos":  round(cp, 6),
            "panns_pos":     round(float(p_pos.get(key, 0.0)), 6),
            "yamnet_pos":    round(float(y_pos.get(key, 0.0)), 6),
            "gates": gates,
            "pass": bool(pass_core or p_only_strong),
            "why": "cm>=mean && cp>=pos" if pass_core else ("panns_pos strong" if p_only_strong else "below"),
        }
        decisions[key] = decision
        
        # Drum kit rescue for brushed/soft kits (Adele case)
        if key == "drum_kit" and not decision["pass"]:
            # Mean-only rescue for brushed/soft kits (Adele case):
            # Pass if mean is clearly above threshold AND either model shows *any* drum-ish evidence.
            mean_ok = cm >= 0.0065  # v1.1.0: lower mean-only rescue to 0.0065 for delicate drums
            per_model = decision_trace.get("per_model", {})
            yam_mean = per_model.get("yamnet", {}).get("mean_probs", {}).get("drum_kit", 0.0)
            panns_mean = per_model.get("panns", {}).get("mean_probs", {}).get("drum_kit", 0.0)
            faint_ok = (yam_mean >= 0.00025) or (panns_mean >= 0.0080)
            if mean_ok and faint_ok:
                decision["pass"] = True
                decision["why"] = "drum_kit: mean-only rescue (brushed/soft kits)"
        
        # v1.1.0: delicate-drum rescue — accept strong PANNs even if YAMNet is sleepy,
        # especially on piano-led tracks (matches Adele trace pattern).
        if key == "drum_kit" and not decision["pass"]:
            try:
                p_dm = per_model.get("panns", {}).get("mean_probs", {}).get("drum_kit", 0.0)
                y_dm = per_model.get("yamnet", {}).get("mean_probs", {}).get("drum_kit", 0.0)
                p_pn = per_model.get("panns", {}).get("mean_probs", {}).get("piano", 0.0)
                # Trigger if drums are near our observed PANNs level (~0.0079) while YAMNet is tiny (~0.0003)
                if (p_dm >= 0.0075 and y_dm <= 0.0005 and (cm >= 0.006 or p_pn >= 0.008)):
                    decision["pass"] = True
                    decision["why"] = "drum_kit: delicate drums panns-only rescue"
                    decision_trace.setdefault("rescues", []).append("delicate_drums_panns_only_v1")
            except Exception as _e:
                decision_trace.setdefault("warnings", []).append(f"delicate_drums_rescue_warn:{_e}")
        
        if decision["pass"]:
            label = _title_for_core(key)
            if label and label not in already:
                picked.append(label)

    # Keep it tight & reliable
    picked = picked[:4]
    return picked, decisions

def _apply_mix_only_strings_v1(per_model, instruments, decision_trace):
    """
    Mix-only booster to recover 'Strings (section)' when models show mean evidence
    but pos_ratio is ~0 (common in dense orchestral beds).

    Logic:
    - Require strings combined mean >= 0.006 (from your traces, strings≈0.0065)
    - AND (piano combined mean >= 0.005 OR brass combined mean >= 0.006)
      to gate for orchestral context and avoid false positives.
    - No pos gate (pos can be 0 for sustained strings in some mixes).
    - Appends a full trace to decision_trace['boosts']['mix_only_strings_v1'].
    """
    boosts = decision_trace.setdefault("boosts", {})

    panns = per_model.get("panns", {})
    yamnet = per_model.get("yamnet", {})

    p_means = (panns.get("mean_probs") or {})
    y_means = (yamnet.get("mean_probs") or {})
    p_pos   = (panns.get("pos_ratio")  or {})
    y_pos   = (yamnet.get("pos_ratio") or {})

    def cm(k):  # combined mean
        return float(p_means.get(k, 0.0)) + float(y_means.get(k, 0.0))
    def cp(k):  # combined pos
        return float(p_pos.get(k, 0.0)) + float(y_pos.get(k, 0.0))

    TH = {
        "strings": {
            "mean_orchestral": 0.0065,  # v1.2.0: Lower threshold when orchestral context (piano/brass) exists
            "mean_default": 0.0085,     # v1.1.0: Strict threshold for pop/rock to avoid synth-pad false positives
            "pos": 0.0
        },
        "gate": {"piano": 0.0050, "brass": 0.0060},
    }

    strings_mean = cm("strings")
    strings_pos  = cp("strings")
    piano_mean   = cm("piano")
    brass_mean   = cm("brass")

    gate_ok = (piano_mean >= TH["gate"]["piano"]) or (brass_mean >= TH["gate"]["brass"])
    
    # v1.2.0: Optional micro check - if individual string instruments are detected, at least one should have pos >= 0.004
    # But don't block if only generic "strings" label exists (common in orchestral mixes)
    string_keys = ["violin", "cello", "viola", "double_bass"]
    individual_string_pos = max(cp(key) for key in string_keys)
    has_individual_strings = individual_string_pos > 0  # Are individual instruments detected at all?
    individual_string_ok = (not has_individual_strings) or (individual_string_pos >= 0.004)
    
    # v1.2.0: Context-aware threshold - use lower threshold when orchestral context exists
    # This catches real orchestral strings (e.g., Beatles "A Day in the Life" with 21 string players)
    # while maintaining strict threshold for pop/rock to avoid synth-pad false positives
    effective_threshold = TH["strings"]["mean_orchestral"] if gate_ok else TH["strings"]["mean_default"]
    pass_strings = (strings_mean >= effective_threshold) and gate_ok and individual_string_ok

    added = []
    if pass_strings and ("Strings (section)" not in instruments):
        instruments.append("Strings (section)")
        added.append("Strings (section)")

    boosts["mix_only_strings_v1"] = {
        "booster": "mix_only_strings_v1",
        "thresholds": TH,
        "decisions": {
            "strings": {"combined_mean": strings_mean, "combined_pos": strings_pos},
            "gates":   {"piano_mean": piano_mean, "brass_mean": brass_mean, "gate_ok": gate_ok},
            "effective_threshold": effective_threshold,  # v1.2.0: Show which threshold was actually used
            "threshold_type": "orchestral" if gate_ok else "default",
        },
        "added": added,
    }

    return added

def _boost_mix_only_woodwinds_v1(instruments, decision_trace):
    """
    Conservative promotion of Woodwinds (section) in mix-only runs.

    Rules summary (tuned for Beatles 'A Day in the Life'):
      - Look at per-model means and pos_ratio for: flute, clarinet, oboe, bassoon.
      - Compute combined_mean = panns.mean + yamnet.mean, combined_pos = panns.pos + yamnet.pos.
      - Require at least TWO instruments meeting: combined_mean >= MEAN_MIN and combined_pos >= POS_MIN.
      - Gate with sax evidence to avoid confusing sax/woodwinds:
            if sax combined_pos is very strong but none of the 4 woodwinds pass, don't promote section.
      - Veto if piano dominance is too strong (prevents "hiss-as-woodwinds" in dense piano passages).
      - Log full decisions into decision_trace["boosts"]["mix_only_woodwinds_v1"].
    """

    # Bail if we don't have model stats
    per_model = (decision_trace or {}).get("per_model", {})
    panns = per_model.get("panns", {})
    yamnet = per_model.get("yamnet", {})
    p_means = panns.get("mean_probs", {}) or {}
    y_means = yamnet.get("mean_probs", {}) or {}
    p_pos   = panns.get("pos_ratio",  {}) or {}
    y_pos   = yamnet.get("pos_ratio",  {}) or {}

    # Config (mix-only mode - more permissive for mean, ignore pos)
    MEAN_MIN = 0.0015     # combined mean gate (lowered for mix-only)
    POS_MIN  = 0.0        # ignore pos in mix-only mode
    STRONG_MEAN = 0.0050  # optional individual promotion (lowered)
    STRONG_POS  = 0.0200  # lowered for mix-only

    # Sax guard & piano veto
    SAX_POS_STRONG = 0.045    # if sax dominates but no woodwinds pass, don't hallucinate section
    PIANO_DOM_RATIO = 0.45    # if piano pos_ratio very high and no strong woodwind, veto

    # Which labels to check (allow common variants the models might surface)
    CANDIDATES = {
        "flute":    ("flute", "piccolo", "flute/piccolo"),
        "clarinet": ("clarinet",),
        "oboe":     ("oboe",),
        "bassoon":  ("bassoon",)
    }

    # Helper to get combined stats across possible label variants
    def _combined_for(keys):
        cm = cp = 0.0
        for k in keys:
            cm = max(cm, _comb(p_means.get(k), y_means.get(k)))
            cp = max(cp, _comb(p_pos.get(k),   y_pos.get(k)))
        return cm, cp

    # Collect stats & decisions
    decisions = {}
    passes = 0
    strong_hits = []

    for canon, keys in CANDIDATES.items():
        cm, cp = _combined_for(keys)
        # In mix-only mode, only check mean threshold (pos is ignored)
        passed = (cm >= MEAN_MIN)
        decisions[canon] = {
            "combined_mean": cm,
            "combined_pos": cp,
            "gates": {"mean": MEAN_MIN, "pos": POS_MIN},
            "pass": bool(passed)
        }
        if passed:
            passes += 1
        # Strong individual check - only require mean in mix-only mode
        if cm >= STRONG_MEAN:
            strong_hits.append(canon)

    # Guards
    sax_cm, sax_cp = _combined_for(("saxophone", "alto_sax", "tenor_sax", "baritone_sax"))
    piano_cm = _comb(p_means.get("piano"), y_means.get("piano"))
    piano_cp = _comb(p_pos.get("piano"),   y_pos.get("piano"))

    result = {
        "booster": "mix_only_woodwinds_v1",
        "thresholds": {
            "per_instrument": {"mean": MEAN_MIN, "pos": POS_MIN},
            "section_min_count": 1,
            "section_pos_ratio_min": 0.01,
            "sax_pos_strong": SAX_POS_STRONG,
            "piano_dom_ratio": PIANO_DOM_RATIO,
            "strong_individual": {"mean": STRONG_MEAN, "pos": STRONG_POS}
        },
        "decisions": decisions,
        "context": {
            "sax_combined_pos": sax_cp,
            "piano_combined_mean": piano_cm,
            "piano_combined_pos": piano_cp
        },
        "added": []
    }

    # Section promotion (mix-only: only need 1 instrument)
    if passes >= 1:
        # sax guard: if sax is strong but we barely pass with two weak hits, still allow (we have 2+)
        # piano veto only if piano is truly dominating and no strong individual
        piano_dominant = (piano_cp >= PIANO_DOM_RATIO)
        if piano_dominant and not strong_hits:
            # veto
            pass
        else:
            if "Woodwinds (section)" not in instruments:
                instruments.append("Woodwinds (section)")
                result["added"].append("Woodwinds (section)")

    # Section roll-up clause: add "Woodwinds (section)" for weak but persistent presence
    rollup_min_mean_any = 0.00035   # combined mean across models (avg of panns+yamnet)
    rollup_min_pos_any = 0.0        # allow zero; we're doing mix-only detection
    section_min_hits = 1            # at least one woodwind passes the relaxed mean
    
    # Compute combined stats for each woodwind
    woodwind_keys = ["flute", "clarinet", "oboe", "bassoon", "saxophone"]
    wood_count = 0
    woodwind_rollup_stats = {}
    
    for key in woodwind_keys:
        # Get combined mean and pos for this woodwind
        cm, cp = _combined_for([key])
        woodwind_rollup_stats[key] = {
            "combined_mean": cm,
            "combined_pos": cp
        }
        
        # Check if this woodwind passes the relaxed rollup gates
        if cm >= rollup_min_mean_any and cp >= rollup_min_pos_any:
            wood_count += 1
    
    # Add section if enough woodwinds pass the relaxed gates
    if wood_count >= section_min_hits and "Woodwinds (section)" not in instruments:
        instruments.append("Woodwinds (section)")
        result["added"].append("Woodwinds (section)")
    
    # Update result with rollup info
    result["woodwinds_rollup"] = {
        "thresholds": {
            "rollup_min_mean_any": rollup_min_mean_any,
            "rollup_min_pos_any": rollup_min_pos_any,
            "section_min_hits": section_min_hits
        },
        "woodwind_stats": woodwind_rollup_stats,
        "wood_count": wood_count,
        "section_added": "Woodwinds (section)" in instruments
    }

    # Optional: add particularly strong individuals (rare; keeps list tidy)
    for canon in strong_hits:
        name = {
            "flute": "Flute",
            "clarinet": "Clarinet",
            "oboe": "Oboe",
            "bassoon": "Bassoon"
        }.get(canon)
        if name and name not in instruments:
            instruments.append(name)
            result["added"].append(name)

    # Store trace
    decision_trace.setdefault("boosts", {})["mix_only_woodwinds_v1"] = result
    return instruments

# -------- Mix-only Woodwinds Booster (v1) --------
def _mix_only_woodwinds_v1(decision_trace):
    """
    Conservative aggregation across {flute/piccolo, clarinet, oboe, bassoon}.
    Promote 'Woodwinds (section)' only if:
      - evidence from at least TWO of the above instruments passes tiny gates
      - AND total combined_mean across the set passes a small sum threshold
    Saxophone is intentionally NOT part of the gate.
    """
    boosts_log = {
        "booster": "mix_only_woodwinds_v1",
        "thresholds": {},
        "instruments": {},
        "decisions": {},
        "added": []
    }
    try:
        resolved = _resolve_ww_keys(decision_trace)
        stats = _combined_mean_pos(decision_trace, resolved)

        # Tuned conservatively for "A Day in the Life" traces you shared:
        TH = {
            "per_inst_mean_min": 0.0015,   # each instrument's combined mean must be at least this
            "per_inst_pos_min":  0.0100,   # each instrument's combined pos must be at least this
            "sum_mean_min":      0.0040,   # sum of means across ww instruments
            "min_count":         2,        # need >= 2 ww instruments meeting per-inst gates
            "max_add":           1         # we only add the section label, not individuals
        }
        boosts_log["thresholds"] = TH

        per_flags = {}
        total_mean = 0.0
        passing = 0
        for canon, (c_mean, c_pos, p_pos, y_pos) in stats.items():
            ok = (c_mean >= TH["per_inst_mean_min"] and c_pos >= TH["per_inst_pos_min"])
            per_flags[canon] = {
                "combined_mean": round(c_mean, 6),
                "combined_pos":  round(c_pos, 6),
                "panns_pos":     round(p_pos, 6),
                "yamnet_pos":    round(y_pos, 6),
                "pass": ok
            }
            total_mean += c_mean
            if ok: passing += 1

        boosts_log["instruments"] = per_flags
        boosts_log["decisions"]["sum_mean"] = round(total_mean, 6)
        boosts_log["decisions"]["passing_count"] = passing

        add_section = (passing >= TH["min_count"] and total_mean >= TH["sum_mean_min"])
        if add_section:
            boosts_log["added"] = ["Woodwinds (section)"]
            return ["Woodwinds (section)"], boosts_log
        else:
            return [], boosts_log
    except Exception as e:
        boosts_log["error"] = f"{type(e).__name__}: {e}"
        return [], boosts_log

def _get_mean_pos(per_model, key):
    panns_m = per_model.get('panns', {}).get('mean_probs', {}).get(key, 0.0)
    yam_m   = per_model.get('yamnet', {}).get('mean_probs', {}).get(key, 0.0)
    panns_p = per_model.get('panns', {}).get('pos_ratio', {}).get(key, 0.0)
    yam_p   = per_model.get('yamnet', {}).get('pos_ratio', {}).get(key, 0.0)
    combined_mean = (panns_m or 0.0) + (yam_m or 0.0)
    combined_pos  = (panns_p or 0.0) + (yam_p or 0.0)
    return {
        "combined_mean": combined_mean,
        "combined_pos": combined_pos,
        "panns_pos": panns_p or 0.0,
        "yamnet_pos": yam_p or 0.0,
        "panns_mean": panns_m or 0.0,
        "yamnet_mean": yam_m or 0.0,
    }

def _get_inst_stats(per_model, key):
    s = _get_mean_pos(per_model, key)
    return {
        "key": key,
        "mean": s["combined_mean"],
        "pos":  s["combined_pos"],
        "panns_pos": s["panns_pos"],
        "yamnet_pos": s["yamnet_pos"],
        "panns_mean": s["panns_mean"],
        "yamnet_mean": s["yamnet_mean"],
    }

def _horn_family_breakdown(per_model):
    # Resolve label variants if your models expose different names.
    # Keep simple keys here; your earlier boosters already handle variants.
    trumpet  = _get_inst_stats(per_model, "trumpet")
    trombone = _get_inst_stats(per_model, "trombone")
    frhorn   = _get_inst_stats(per_model, "french_horn")  # safe even if missing → zeros

    total_mean = trumpet["mean"] + trombone["mean"] + frhorn["mean"]
    total_pos  = trumpet["pos"]  + trombone["pos"]  + frhorn["pos"]

    return {
        "trumpet": trumpet,
        "trombone": trombone,
        "french_horn": frhorn,
        "totals": {"mean": total_mean, "pos": total_pos},
    }

def _apply_mix_only_woodwinds_v2(decisions, trace, rules, decision_trace, logger):
    TH = rules['mix_only_woodwinds_v2']
    ww_keys = _resolve_keys_woodwinds()

    ctx_ok, strings_mean, brass_mean = _context_orchestral_ok(decisions, trace, TH['CTX_GATE'])
    ctx = {
        'strings_mean': strings_mean,
        'brass_mean': brass_mean,
        'strings_present': 'Strings (section)' in decisions,
        'brass_present':   'Brass (section)' in decisions,
        'ok': ctx_ok
    }

    per_inst = {}
    sum_mean = 0.0
    sum_pos  = 0.0
    any_pos  = 0.0

    # accumulate per-instrument stats
    for key in ww_keys:
        cm, cp, ppos, ypos, pm, ym = _combined_stat_for_key(trace, key)
        if (cm + cp) == 0.0:
            continue
        per_inst[key] = {'mean': cm, 'pos': cp, 'panns_pos': ppos, 'yamnet_pos': ypos,
                         'panns_mean': pm, 'yamnet_mean': ym}
        sum_mean += cm
        sum_pos  += cp
        any_pos   = max(any_pos, cp)

    sax_mean, sax_pos = _sax_guard(trace)
    sax_ratio = (sax_mean / max(sum_mean, 1e-9)) if sum_mean > 0 else 0.0

    pass_gate = (ctx_ok and
                 sum_mean >= TH['SUM_MEAN_MIN'] and
                 sum_pos  >= TH['SUM_POS_MIN']  and
                 any_pos  >= TH['ANY_POS_MIN']  and
                 (sax_ratio <= TH['SAX_GUARD_RATIO']))

    added = []
    if pass_gate:
        # pick top 1–2 by combined evidence
        ranked = sorted(per_inst.items(), key=lambda kv: (kv[1]['mean']*0.7 + kv[1]['pos']*0.3), reverse=True)
        for key, stats in ranked[:TH['MAX_ADDS']]:
            # Map to section-level "Woodwinds (section)" or be specific?
            # Start conservative: add section when multiple present, else add the strongest specific.
            # Heuristic: if we have >=2 with non-trivial pos (>=ANY_POS_MIN), add section; else specific.
            multi = sum(1 for _, s in per_inst.items() if s['pos'] >= TH['ANY_POS_MIN']) >= 2
            label = 'Woodwinds (section)' if multi else {
                'flute':'Flute','Flute':'Flute','piccolo':'Flute','Piccolo':'Flute',
                'clarinet':'Clarinet','Clarinet':'Clarinet',
                'oboe':'Oboe','Oboe':'Oboe',
                'bassoon':'Bassoon','Bassoon':'Bassoon'
            }.get(key, 'Woodwinds (section)')
            if label not in decisions:
                decisions.append(label)
                added.append(label)

    # trace
    decision_trace.setdefault('boosts', {})['mix_only_woodwinds_v2'] = {
        'booster': 'mix_only_woodwinds_v2',
        'thresholds': {
            'sum_mean_min': TH['SUM_MEAN_MIN'],
            'sum_pos_min': TH['SUM_POS_MIN'],
            'any_pos_min': TH['ANY_POS_MIN'],
            'context_gate': TH['CTX_GATE'],
            'sax_guard_ratio': TH['SAX_GUARD_RATIO'],
            'max_adds': TH['MAX_ADDS'],
        },
        'per_instrument': per_inst,
        'sums': {'mean': round(sum_mean, 6), 'pos': round(sum_pos, 6), 'any_pos': round(any_pos, 6)},
        'context': ctx,
        'sax_guard': {'sax_mean': round(sax_mean, 6), 'sax_pos': round(sax_pos, 6), 'ratio': round(sax_ratio, 4)},
        'pass': pass_gate,
        'added': added,
    }

    if logger and pass_gate and added:
        logger(f"[ENSEMBLE] woodwinds v2 added: {', '.join(added)}")

    return added


def _booster_mix_only_percussion_v1(per_model, decision_trace, current_instruments):
    """
    Conservative timpani recall for mix-only mode (common in orchestral swells).
    """
    TH = {
        "timpani_mean": 0.004,
        "timpani_pos":  0.012,
        "context_gate": 0.005,   # require strings or brass context
    }

    stats = _get_mean_pos(per_model, "timpani")
    strings_m = _get_mean_pos(per_model, "strings")["combined_mean"]
    brass_m   = _get_mean_pos(per_model, "brass")["combined_mean"]
    context_ok = (
        ("Strings (section)" in current_instruments) or ("Brass (section)" in current_instruments)
        or (strings_m >= TH["context_gate"]) or (brass_m >= TH["context_gate"])
    )

    pass_gate = context_ok and (
        stats["combined_mean"] >= TH["timpani_mean"] and stats["combined_pos"] >= TH["timpani_pos"]
    )

    trace = {
        "booster": "mix_only_percussion_v1",
        "thresholds": TH,
        "timpani": stats,
        "context": {
            "strings_mean": strings_m,
            "brass_mean": brass_m,
            "ok": context_ok
        },
        "pass": pass_gate,
        "added": []
    }

    added = []
    if pass_gate:
        added.append("Timpani")

    trace["added"] = added
    decision_trace.setdefault("boosts", {})["mix_only_percussion_v1"] = trace
    return added


def _booster_mix_only_harp_v1(per_model, decision_trace, current_instruments):
    """
    Conservative harp recall in orchestral context.
    """
    TH = {
        "harp_mean":   0.004,
        "harp_pos":    0.012,
        "context_gate": 0.005,
    }

    stats = _get_mean_pos(per_model, "harp")
    strings_m = _get_mean_pos(per_model, "strings")["combined_mean"]
    context_ok = ("Strings (section)" in current_instruments) or (strings_m >= TH["context_gate"])

    pass_gate = context_ok and (
        stats["combined_mean"] >= TH["harp_mean"] and stats["combined_pos"] >= TH["harp_pos"]
    )

    trace = {
        "booster": "mix_only_harp_v1",
        "thresholds": TH,
        "harp": stats,
        "context": {
            "strings_mean": strings_m,
            "ok": context_ok
        },
        "pass": pass_gate,
        "added": []
    }

    added = []
    if pass_gate:
        added.append("Harp")

    trace["added"] = added
    decision_trace.setdefault("boosts", {})["mix_only_harp_v1"] = trace
    return added

def _apply_mix_only_brass_boost(current_instruments: list, trace: dict) -> list:
    """
    Mix-only brass booster v1:
    - Uses per_model (panns + yamnet) mean_probs and pos_ratio to detect generic brass
      or a small summed horn presence and, if evidence passes, adds "Brass (section)".
    - Returns list of added instrument strings (possibly empty).
    """
    added = []
    try:
        per_model = trace.get("per_model", {}) if isinstance(trace, dict) else {}
        panns = per_model.get("panns", {}) or {}
        yamnet = per_model.get("yamnet", {}) or {}

        # Extract mean_probs and pos_ratio maps (safe defaults)
        p_means = panns.get("mean_probs", {}) if isinstance(panns.get("mean_probs", {}), dict) else {}
        y_means = yamnet.get("mean_probs", {}) if isinstance(yamnet.get("mean_probs", {}), dict) else {}
        p_pos = panns.get("pos_ratio", {}) if isinstance(panns.get("pos_ratio", {}), dict) else {}
        y_pos = yamnet.get("pos_ratio", {}) if isinstance(yamnet.get("pos_ratio", {}), dict) else {}

        # helper: combined mean and pos across models (safe numeric)
        def comb_mean(k):
            try:
                return float(p_means.get(k, 0.0)) + float(y_means.get(k, 0.0))
            except Exception:
                return 0.0
        def comb_pos(k):
            try:
                return float(p_pos.get(k, 0.0)) + float(y_pos.get(k, 0.0))
            except Exception:
                return 0.0

        # Combined generic brass evidence
        brass_mean = comb_mean("brass")
        brass_pos = comb_pos("brass")

        # Individual horn members (some datasets call saxophone 'sax' or 'saxophone')
        trumpet_mean = comb_mean("trumpet")
        trombone_mean = comb_mean("trombone")
        sax_mean = comb_mean("saxophone") or comb_mean("sax")

        horn_sum = float(trumpet_mean) + float(trombone_mean) + float(sax_mean)

        # Conservative thresholds tuned to observed short-solo values
        TH = {
            "brass_mean": 0.005,   # combined generic brass mean
            "brass_pos":  0.005,   # combined generic brass pos ratio
            "horn_sum":   0.008    # sum of individual horn means
        }

        # Decision: pass if generic brass signal (mean+pos) OR sum of horn members exceeds small threshold
        pass_brass = ((brass_mean >= TH["brass_mean"] and brass_pos >= TH["brass_pos"]) or (horn_sum >= TH["horn_sum"]))

        # Only add if not already present (case-sensitive canonical)
        if pass_brass and ("Brass (section)" not in current_instruments):
            current_instruments.append("Brass (section)")
            added.append("Brass (section)")

        # Record decision in trace for observability
        try:
            trace.setdefault("boosts", {})
            trace["boosts"]["mix_only_brass_v1"] = {
                "booster": "mix_only_brass_v1",
                "thresholds": TH,
                "values": {
                    "brass_mean": brass_mean,
                    "brass_pos": brass_pos,
                    "horn_sum": horn_sum,
                    "trumpet": trumpet_mean,
                    "trombone": trombone_mean,
                    "saxophone": sax_mean
                },
                "pass": bool(pass_brass),
                "added": list(added)
            }
        except Exception:
            # Non-fatal: do not break ensemble if trace update fails
            pass

    except Exception:
        # Defensive: never raise out of booster; return what we've added (likely empty)
        return added

    return added

def _booster_mix_only_horns_specific_v1(per_model, decision_trace, current_instruments):
    """
    Precision-first booster for specific horns in mix-only mode.
    Only adds Trumpet/Trombone when:
      - Brass context is present (section already added OR brass mean small gate),
      - Instrument itself clears small but consistent gates,
      - Not obviously a saxophone-bleed situation.
    """
    TH = {
        "context_brass_mean": 0.006,   # keep
        "inst_mean_min":      0.0025,  # keep
        "inst_pos_min":       0.0050,  # lowered to allow short transient trumpet windows to count
        "dom_ratio":          0.45,    # keep for tracing only
        "sax_guard_ratio":    1.3,     # keep
    }

    # Context: brass section or small brass evidence gate
    brass_mean = _get_mean_pos(per_model, "brass")["combined_mean"]
    brass_section_present = ("Brass (section)" in current_instruments)
    context_ok = brass_section_present or (brass_mean >= TH["context_brass_mean"])

    horns = _horn_family_breakdown(per_model)
    sax   = _get_inst_stats(per_model, "saxophone")

    def _consider(inst_name):
        inst = horns[inst_name]
        family_mean = max(horns["totals"]["mean"], 1e-12)  # avoid div0
        dominates = (inst["mean"] / family_mean) >= TH["dom_ratio"]
        passes_basic = (inst["mean"] >= TH["inst_mean_min"] and inst["pos"] >= TH["inst_pos_min"])
        sax_guard = not (sax["pos"] > inst["pos"] * TH["sax_guard_ratio"])
        return {
            "name": inst_name,
            "stats": inst,
            "dominates": dominates,
            "passes_basic": passes_basic,
            "sax_guard": sax_guard,
            "pass": bool(passes_basic) and bool(sax_guard) and context_ok,
        }

    cand_trp = _consider("trumpet")
    cand_trb = _consider("trombone")

    added = []
    if cand_trp["pass"]:
        added.append("Trumpet")
    if cand_trb["pass"]:
        added.append("Trombone")

    decision_trace.setdefault("boosts", {})["mix_only_horns_specific_v1"] = {
        "thresholds": TH,
        "context": {
            "brass_mean": brass_mean,
            "brass_section_present": brass_section_present,
            "ok": context_ok,
        },
        "horns": horns,
        "sax": sax,
        "candidates": {
            "trumpet": cand_trp,
            "trombone": cand_trb,
        },
        "added": added,
    }
    return added

def _apply_woodwinds_boost(by_stem, combined, trace):
    """
    Conservative section detection for woodwinds; optionally add 'Flute' if very clear.
    Adds entries into trace["boosts"]["woodwinds"] for debugging.
    Returns a set of new instrument display names to add.
    """
    out = set()
    bs = _as_dict(by_stem)
    if not isinstance(bs, dict) or not bs:
        return out
    rules = RULES.get("WOODWINDS", {})
    boosts = trace.setdefault("boosts", {}).setdefault("woodwinds", {})

    # Resolve keys that actually exist in this model output
    keys = _resolve_woodwind_keys(bs)
    boosts["resolved_keys"] = dict(keys)
    members = ["flute","clarinet","oboe","bassoon"]
    present = [m for m in members if m in keys]
    if not present:
        boosts["why"] = "no-woodwind-labels-present"
        return out

    # Sum total energy (means) across all stems for the present members
    sum_means = 0.0
    for stem_name, stem_scores in bs.items():
        for m in present:
            key = keys[m]
            sum_means += _stem_mean(bs, stem_name, key)

    # Combined pos evidence (from decision_trace->combined if available)
    # Be defensive if your combined doesn't store pos_ratio per label; allow pass on means alone.
    pos_any = 0.0
    try:
        pos_any = float(combined.get("pos_ratio", 0.0))
    except Exception:
        pos_any = 0.0

    boosts["sum_means"] = sum_means
    boosts["pos_any"] = pos_any

    # Count how many members clear tiny evidence in stems (mix/other)
    def _member_stem_ok(mname):
        key = keys[mname]
        mix_ok = _stem_mean(bs, "mix", key)   >= rules.get("MIX_MIN", 0.0)
        oth_ok = _stem_mean(bs, "other", key) >= rules.get("OTHER_MIN", 0.0)
        return mix_ok or oth_ok

    ok_count = sum(1 for m in present if _member_stem_ok(m))
    boosts["ok_count"] = ok_count

    if (sum_means >= rules.get("SUM_MIN", 1.0)
        and ok_count >= int(rules.get("SECTION_MIN_COUNT", 2))
        and (pos_any >= rules.get("POS_ANY", 0.0) or pos_any == 0.0)):
        out.add("Woodwinds (section)")
        boosts["section_added"] = True
    else:
        boosts["section_added"] = False

    # Optional single: Flute (common & audible in mixes like Good Vibrations)
    if "flute" in present:
        flute_key = keys["flute"]
        f_rules = rules.get("FLUTE_SINGLE", {})
        f_sum = _stem_mean(bs, "mix", flute_key) + _stem_mean(bs, "other", flute_key)
        f_pos = pos_any
        flute_ok = (
            (f_sum >= f_rules.get("SUM_MIN", 1e9)) and
            (_stem_mean(bs, "mix", flute_key)   >= f_rules.get("MIX_MIN", 1e9) or
             _stem_mean(bs, "other", flute_key) >= f_rules.get("OTHER_MIN", 1e9)) and
            (f_pos >= f_rules.get("POS_ANY", 1e9) or f_pos == 0.0)
        )
        boosts["flute"] = {"sum": f_sum, "pos": f_pos, "added": bool(flute_ok)}
        if flute_ok:
            out.add("Flute")

    return out

def _apply_timpani_boost(by_stem, trace):
    """
    Conservative timpani detector (mix & other stems). Adds trace['boosts']['timpani'].
    Returns a set with {'Timpani'} if detected, else empty.
    """
    out = set()
    bs = _as_dict(by_stem)
    if not isinstance(bs, dict) or not bs:
        return out
    rules = RULES.get("TIMPANI", {})
    boosts = trace.setdefault("boosts", {}).setdefault("timpani", {})

    # Variants for timpani in model labels
    cand = ["timpani","Timpani","kettledrum","Kettledrum"]
    # Try to resolve once using any available stem
    timp_key = None
    for stem_name, stem_scores in bs.items():
        timp_key = _resolve_key(cand, stem_scores)
        if timp_key:
            break
    boosts["resolved_key"] = timp_key
    if not timp_key:
        boosts["why"] = "no-timpani-label"
        return out

    mix_m  = _stem_mean(bs, "mix", timp_key)
    oth_m  = _stem_mean(bs, "other", timp_key)
    sum_m  = 0.0
    for stem_name, _stem_scores in bs.items():
        sum_m += _stem_mean(bs, stem_name, timp_key)

    # If you keep per-label pos in trace in the future, wire it here. For now gate on means.
    pos_any = 0.0
    boosts.update({"mix_mean": mix_m, "other_mean": oth_m, "sum_means": sum_m, "pos_any": pos_any})

    if (sum_m >= rules.get("SUM_MIN", 1e9) and
        (mix_m >= rules.get("MIX_MIN", 1e9) or oth_m >= rules.get("OTHER_MIN", 1e9)) and
        (pos_any >= rules.get("POS_ANY", 1e9) or pos_any == 0.0)):
        out.add("Timpani")
        boosts["added"] = True
    else:
        boosts["added"] = False

    return out

# --- Helper functions for mix-only boosters ---
def _combined_mean_legacy3(trace, key):
    """Get combined mean from both PANNs and YAMNet for a key."""
    try:
        pm = _get_model_stat(trace, "panns", "mean_probs", key, 0.0)
        ym = _get_model_stat(trace, "yamnet", "mean_probs", key, 0.0)
        return pm + ym
    except Exception:
        return 0.0

def _panns_mean(trace, key):
    """Get PANNs mean for a key."""
    try:
        return _get_model_stat(trace, "panns", "mean_probs", key, 0.0)
    except Exception:
        return 0.0

def _any_pos(trace, key):
    """Get maximum pos_ratio from either PANNs or YAMNet for a key."""
    try:
        pp = _get_model_stat(trace, "panns", "pos_ratio", key, 0.0)
        yp = _get_model_stat(trace, "yamnet", "pos_ratio", key, 0.0)
        return max(pp, yp)
    except Exception:
        return 0.0

def _has(instruments, name):
    """Check if instrument name is in the instruments list."""
    return name in instruments

def _add(instruments, name):
    """Add instrument name to list if not already present."""
    if name not in instruments:
        instruments.append(name)

def _apply_mix_only_bass_trumpet_boost(instruments, trace):
    try:
        # --- Bass Guitar boost (mix-only) ---
        if len(instruments) <= 12:  # don't overgrow lists; normal mixes stay small
            # Only attempt bass if it's not already present.
            if not _has(instruments, "Bass Guitar"):
                try:
                    cm = _combined_mean(trace, "bass_guitar")
                except Exception as e:
                    _log.debug("booster _combined_mean failed for bass_guitar: %s", e)
                    cm = 0.0
                pm = _panns_mean(trace, "bass_guitar")
                need_mean = cm >= MIX_ONLY_TUNE["bass"]["COMBINED_MEAN_MIN"] or pm >= MIX_ONLY_TUNE["bass"]["PANN_MEAN_MIN"]
                allies_ok = all(_has(instruments, ally) for ally in MIX_ONLY_TUNE["bass"]["ALLY_REQUIRE"])
                if need_mean and allies_ok:
                    _add(instruments, "Bass Guitar")

        # --- Trumpet nudge (mix-only) ---
        if _has(instruments, MIX_ONLY_TUNE["trumpet"]["REQUIRE_SECTION"]) and not _has(instruments, "Trumpet"):
            try:
                cm_trp = _combined_mean(trace, "trumpet")
            except Exception as e:
                _log.debug("booster _combined_mean failed for trumpet: %s", e)
                cm_trp = 0.0
            pos_trp = _any_pos(trace, "trumpet")
            if cm_trp >= MIX_ONLY_TUNE["trumpet"]["COMBINED_MEAN_MIN"] and pos_trp >= MIX_ONLY_TUNE["trumpet"]["POS_ANY_MIN"]:
                _add(instruments, "Trumpet")
    except Exception as e:
        # Never let tuning crash the primary pipeline
        if isinstance(trace, dict):
            trace.setdefault("errors", []).append(f"mix_only_bass_trumpet_boost: {type(e).__name__}: {e}")

def _apply_mix_only_core_v2(instruments, trace):
    """Mix-only core booster v2 with relaxed thresholds for drums and guitars."""
    try:
        core_instruments = []
        
        # Check drums
        try:
            drum_mean = _combined_mean(trace, "drum_kit")
        except Exception as e:
            _log.debug("booster _combined_mean failed for drum_kit: %s", e)
            drum_mean = 0.0
        drum_pos = _any_pos(trace, "drum_kit")
        
        # Get individual model means for sparse hit logic
        dk_panns_mean = _get_model_stat(trace, "panns", "mean_probs", "drum_kit")
        dk_yam_mean = _get_model_stat(trace, "yamnet", "mean_probs", "drum_kit")
        
        # Thresholds for sparse hit admit path
        DK_MEAN_MAIN = 0.006   # existing main gate
        DK_POS_MAIN = 0.030    # existing main gate
        DK_MEAN_SPARSE_STRICT = 0.010
        DK_MEAN_SPARSE_COMBO = 0.008
        DK_YAM_MEAN_MIN = 0.00025
        DK_MEAN_HINTED = 0.0065
        DK_YAM_MEAN_HINTED = 0.00020
        
        pass_drum_kit = False
        reasons = []
        
        # Original condition (mean >= DK_MEAN_MAIN and pos >= DK_POS_MAIN)
        if (drum_mean >= DK_MEAN_MAIN and drum_pos >= DK_POS_MAIN):
            pass_drum_kit = True
            reasons.append('drum_kit: main gate (mean+pos)')
        
        # Drum transient rescue for piano-dominant mixes
        if not pass_drum_kit:
            # Compute drum transient score from per_window stats if available
            drum_transient_score = 0.0
            try:
                per_window = trace.get("per_window", {})
                if per_window:
                    # Look for drum-related transient evidence
                    drum_keys = ["drum", "snare_drum", "kick_drum", "drum_kit"]
                    for key in drum_keys:
                        panns_transient = per_window.get("panns", {}).get(key, [])
                        yamnet_transient = per_window.get("yamnet", {}).get(key, [])
                        if panns_transient:
                            drum_transient_score = max(drum_transient_score, max(panns_transient))
                        if yamnet_transient:
                            drum_transient_score = max(drum_transient_score, max(yamnet_transient))
            except Exception:
                # Fall back to drum_kit pos_ratio if per_window not available
                drum_transient_score = drum_pos
            
            # Drum rescue condition
            DRUM_RESCUE = (drum_pos >= 0.015) or (drum_mean >= 0.008) or (drum_transient_score >= 0.02)
            
            if DRUM_RESCUE:
                pass_drum_kit = True
                reasons.append('drum_kit: transient rescue (piano-dominant mix)')
                # Add debug stamp for drum rescue
                trace.setdefault("__drum_rescue__", True)
        
        # Sparse hit admit path when pos_ratio == 0 (legacy)
        if not pass_drum_kit and drum_pos == 0:
            # Check for creative hint (snare drum suggestion)
            creative = trace.get("creative", {})
            suggested_instruments = creative.get("suggestedInstruments", [])
            hinted_snare = 'Snare Drum' in suggested_instruments
            
            # Cross-model combo
            if (dk_panns_mean >= DK_MEAN_SPARSE_COMBO and dk_yam_mean >= DK_YAM_MEAN_MIN):
                pass_drum_kit = True
                reasons.append('drum_kit: sparse-combo admit (mean-only cross-model)')
            # Single-model strict mean (more conservative)
            elif dk_panns_mean >= DK_MEAN_SPARSE_STRICT:
                pass_drum_kit = True
                reasons.append('drum_kit: sparse-single admit (panns mean)')
            # Creative hint path (only if user-visible model hinted snare)
            elif hinted_snare and (dk_panns_mean >= DK_MEAN_HINTED and dk_yam_mean >= DK_YAM_MEAN_HINTED):
                pass_drum_kit = True
                reasons.append('drum_kit: hinted admit (creative+means)')
        
        if pass_drum_kit:
            core_instruments.append("Drum Kit (acoustic)")
        
        # Check electric guitar
        try:
            eg_mean = _combined_mean(trace, "electric_guitar")
        except Exception as e:
            _log.debug("booster _combined_mean failed for electric_guitar: %s", e)
            eg_mean = 0.0
        eg_pos = _any_pos(trace, "electric_guitar")
        if (eg_mean >= MIX_ONLY_CORE_V2["electric_guitar"]["mean"] and 
            eg_pos >= MIX_ONLY_CORE_V2["electric_guitar"]["pos"]):
            core_instruments.append("Electric Guitar")
        
        # Check acoustic guitar
        try:
            ag_mean = _combined_mean(trace, "acoustic_guitar")
        except Exception as e:
            _log.debug("booster _combined_mean failed for acoustic_guitar: %s", e)
            ag_mean = 0.0
        ag_pos = _any_pos(trace, "acoustic_guitar")
        if (ag_mean >= MIX_ONLY_CORE_V2["acoustic_guitar"]["mean"] and 
            ag_pos >= MIX_ONLY_CORE_V2["acoustic_guitar"]["pos"]):
            core_instruments.append("Acoustic Guitar")
        
        # Check bass guitar
        try:
            bg_mean = _combined_mean(trace, "bass_guitar")
        except Exception as e:
            _log.debug("booster _combined_mean failed for bass_guitar: %s", e)
            bg_mean = 0.0
        bg_pos = _any_pos(trace, "bass_guitar")
        if (bg_mean >= MIX_ONLY_CORE_V2["bass_guitar"]["mean"] and 
            bg_pos >= MIX_ONLY_CORE_V2["bass_guitar"]["pos"]):
            core_instruments.append("Bass Guitar")
        
        # Add core instruments if not already present
        for inst in core_instruments:
            _add(instruments, inst)
        
        # Trace the decisions
        if isinstance(trace, dict):
            trace.setdefault("boosts", {})["mix_only_core_v2"] = {
                "thresholds": MIX_ONLY_CORE_V2,
                "decisions": {
                    "drum_kit": {
                        "mean": drum_mean, 
                        "pos": drum_pos, 
                        "panns_mean": dk_panns_mean,
                        "yamnet_mean": dk_yam_mean,
                        "added": "Drum Kit (acoustic)" in core_instruments,
                        "reasons": reasons
                    },
                    "electric_guitar": {"mean": eg_mean, "pos": eg_pos, "added": "Electric Guitar" in core_instruments},
                    "acoustic_guitar": {"mean": ag_mean, "pos": ag_pos, "added": "Acoustic Guitar" in core_instruments},
                    "bass_guitar": {"mean": bg_mean, "pos": bg_pos, "added": "Bass Guitar" in core_instruments}
                },
                "added": core_instruments
            }
            
    except Exception as e:
        # Never let tuning crash the primary pipeline
        if isinstance(trace, dict):
            trace.setdefault("errors", []).append(f"mix_only_core_v2: {type(e).__name__}: {e}")

def _apply_mix_only_woodwinds_boost(selected, decision_trace, log_boost):
    """
    Conservative 'Woodwinds (section)' promotion for mix-only mode.
    Fires only with aggregate woodwind evidence and orchestral context.
    """
    try:
        rules = WOODWIND_RULES
        sum_mean, sum_pos, any_pos, per_model_dump = _sum_woodwind_evidence(decision_trace)
        context_ok = True
        if rules.get("REQUIRE_CONTEXT", True):
            # require that strings or brass already made it through earlier passes
            context_ok = any(name in selected for name in ("Strings (section)", "Brass (section)"))

        fired = False
        reason = []
        if context_ok:
            if (sum_mean >= rules["SUM_MEAN_MIN"] and sum_pos >= rules["SUM_POS_MIN"]) or (any_pos >= rules["ANY_POS_MIN"]):
                # Only add once and only if not already there
                if "Woodwinds (section)" not in selected and len([x for x in selected if x == "Woodwinds (section)"]) < rules["MAX_ADD"]:
                    selected.append("Woodwinds (section)")
                    fired = True
                    reason = ["context_ok", f"sum_mean={sum_mean:.4f}>= {rules['SUM_MEAN_MIN']}",
                              f"sum_pos={sum_pos:.4f}>={rules['SUM_POS_MIN']}", f"any_pos={any_pos:.4f}>= {rules['ANY_POS_MIN']} (OR)"]

        log_boost("mix_only_woodwinds_v1", {
            "booster": "mix_only_woodwinds_v1",
            "thresholds": rules,
            "aggregates": {
                "sum_mean": sum_mean,
                "sum_pos": sum_pos,
                "any_pos": any_pos,
                "context_ok": context_ok
            },
            "per_model": per_model_dump,
            "fired": fired,
            "added": ["Woodwinds (section)"] if fired else []
        })
    except Exception as e:
        log_boost("mix_only_woodwinds_v1", {"error": f"{e.__class__.__name__}: {e}"})

def _apply_mix_only_woodwinds_v1(instruments, trace):
    """Mix-only woodwinds booster v1 with relaxed thresholds and single woodwind support."""
    try:
        # Get woodwind evidence
        sum_mean, sum_pos, any_pos, per_model_dump = _sum_woodwind_evidence(trace)
        
        # Check piano domination veto (but not if piano_combined_pos == 0 or very small)
        piano_combined_pos = _combined_mean(trace, "piano")
        piano_dominant = piano_combined_pos > 0.0 and piano_combined_pos >= 0.45
        
        # Check context requirement
        context_ok = any(name in instruments for name in ("Strings (section)", "Brass (section)"))
        
        passed_woodwinds = []
        
        # Check individual woodwinds with relaxed thresholds
        for key in WOODWIND_KEYS:
            try:
                cm = _combined_mean(trace, key)
            except Exception as e:
                _log.debug("booster _combined_mean failed for %s: %s", key, e)
                cm = 0.0
            cp = _any_pos(trace, key)
            
            # Apply relaxed thresholds
            if (cm >= MIX_ONLY_WOODWINDS_V1["per_instrument"]["mean"] and 
                cp >= MIX_ONLY_WOODWINDS_V1["per_instrument"]["pos"]):
                
                # Map to canonical UI names
                canonical_name = {
                    "flute": "Flute",
                    "piccolo": "Flute",  # Map piccolo to Flute
                    "clarinet": "Clarinet",
                    "bass clarinet": "Clarinet",  # Map bass clarinet to Clarinet
                    "oboe": "Oboe",
                    "english horn": "Oboe",  # Map english horn to Oboe
                    "bassoon": "Bassoon"
                }.get(key, key.title())
                
                if canonical_name not in passed_woodwinds:
                    passed_woodwinds.append(canonical_name)
        
        # Check if we should add woodwinds
        should_add = False
        
        # Case 1: Single woodwind passes (new relaxed requirement)
        if len(passed_woodwinds) >= MIX_ONLY_WOODWINDS_V1["section_min_count"]:
            should_add = True
        
        # Case 2: Strong individual woodwind
        for key in WOODWIND_KEYS:
            try:
                cm = _combined_mean(trace, key)
            except Exception as e:
                _log.debug("booster _combined_mean failed for %s: %s", key, e)
                cm = 0.0
            cp = _any_pos(trace, key)
            if (cm >= MIX_ONLY_WOODWINDS_V1["strong_individual"]["mean"] and 
                cp >= MIX_ONLY_WOODWINDS_V1["strong_individual"]["pos"]):
                should_add = True
                break
        
        # Apply piano veto only if piano is truly dominating and no strong individual
        if piano_dominant and not should_add:
            should_add = False
        
        # Add woodwinds if they pass
        if should_add and context_ok:
            # Add individual woodwinds
            for ww in passed_woodwinds:
                _add(instruments, ww)
            
            # Add section if multiple present
            if len(passed_woodwinds) >= 2:
                _add(instruments, "Woodwinds (section)")
        
        # Trace the decisions
        if isinstance(trace, dict):
            trace.setdefault("boosts", {})["mix_only_woodwinds_v1"] = {
                "thresholds": MIX_ONLY_WOODWINDS_V1,
                "evidence": {
                    "sum_mean": sum_mean,
                    "sum_pos": sum_pos,
                    "any_pos": any_pos,
                    "piano_combined_pos": piano_combined_pos,
                    "piano_dominant": piano_dominant,
                    "context_ok": context_ok
                },
                "passed_woodwinds": passed_woodwinds,
                "should_add": should_add,
                "added": [ww for ww in passed_woodwinds if ww in instruments] + 
                        (["Woodwinds (section)"] if "Woodwinds (section)" in instruments else [])
            }
            
    except Exception as e:
        # Never let tuning crash the primary pipeline
        if isinstance(trace, dict):
            trace.setdefault("errors", []).append(f"mix_only_woodwinds_v1: {type(e).__name__}: {e}")

def _family_rollup(decision, decision_trace):
    """
    Adds group labels (Strings/Brass/Woodwinds) to decision['instruments'] when
    family-level evidence is present, logging thresholds & decisions in trace.
    """
    per_model  = decision_trace.get("per_model", {})
    per_window = decision_trace.get("per_window", {})

    have_strings = "Strings (section)" in decision["instruments"]
    have_brass   = "Brass (section)"   in decision["instruments"]

    def model_stat(model, stat_name, subdict, label):
        return subdict.get(model, {}).get(stat_name, {}).get(label, 0.0)

    def family_agg_stats(members):
        # take per-class max across models for both mean and pos; then family max
        fam_max_mean = 0.0
        fam_max_pos  = 0.0
        for lbl in members:
            lbl_mean = max(
                model_stat("panns","mean_probs", per_model, lbl),
                model_stat("yamnet","mean_probs", per_model, lbl)
            )
            lbl_pos = max(
                model_stat("panns","pos_ratio", per_model, lbl),
                model_stat("yamnet","pos_ratio", per_model, lbl)
            )
            if lbl_mean > fam_max_mean: fam_max_mean = lbl_mean
            if lbl_pos  > fam_max_pos:  fam_max_pos  = lbl_pos
        return fam_max_mean, fam_max_pos

    def family_spike(members, spike_gate):
        try:
            for lbl in members:
                s = []
                s += per_window.get("panns", {}).get(lbl, [])
                s += per_window.get("yamnet", {}).get(lbl, [])
                if any(v >= spike_gate for v in s):
                    return True
        except Exception:
            pass
        return False

    rollup_cfg = FAMILY_ROLLUP_V1
    added_groups = []
    family_debug = {}

    for group_label, members in FAMILY_GROUPS.items():
        fam_mean, fam_pos = family_agg_stats(members)
        spike = family_spike(members, rollup_cfg["single_high"])

        # Context rule (helps Woodwinds precision): require Strings or Brass already present
        context_ok = True
        if rollup_cfg["require_context"] and group_label == "Woodwinds":
            try:
                strings_mean = _combined_mean(decision_trace, "strings")
            except Exception as e:
                _log.debug("booster _combined_mean failed for strings: %s", e)
                strings_mean = 0.0
            try:
                brass_mean = _combined_mean(decision_trace, "brass")
            except Exception as e:
                _log.debug("booster _combined_mean failed for brass: %s", e)
                brass_mean = 0.0
            context_ok = (
                have_strings or have_brass or
                (strings_mean >= rollup_cfg.get("context_gate", 0.002)) or
                (brass_mean >= rollup_cfg.get("context_gate", 0.002))
            )

        trigger = (
            (group_label in GROUPS_ALWAYS and (have_strings or have_brass)) or
            (fam_pos  >= rollup_cfg["agg_pos"])  or
            (fam_mean >= rollup_cfg["agg_mean"]) or
            spike
        )

        family_debug[group_label] = {
            "members": members,
            "fam_mean": round(fam_mean, 5),
            "fam_pos":  round(fam_pos, 5),
            "spike":    spike,
            "context_ok": context_ok,
            "agg_mean_gate": rollup_cfg["agg_mean"],
            "agg_pos_gate":  rollup_cfg["agg_pos"],
            "single_high":   rollup_cfg["single_high"],
            "lenient": (os.getenv("RNA_WW_LENIENT","0") == "1"),
            "always":  (group_label in GROUPS_ALWAYS),
        }

        if context_ok and trigger and group_label not in decision["instruments"]:
            decision["instruments"].append(group_label)
            added_groups.append(group_label)

    if added_groups:
        decision.setdefault("boosts", {})["family_rollup_v1"] = {
            "booster": "family_rollup_v1",
            "added": added_groups,
            "families": family_debug,
        }
        return True
    return False

def _collapse_orchestral_groups(final_list, per_model=None):
    """Collapse orchestral families into groups for final output."""
    present = set(final_list)
    # DEBUG: Log what's in the input list
    print(f"[COLLAPSE_DEBUG] Input list: {final_list}")
    print(f"[COLLAPSE_DEBUG] Present set: {present}")
    # if any member OR an existing section tag is present, add the group label
    add = set()
    # map of instrument synonyms -> canonical members (optional)
    synonyms = {"strings": "strings", "brass": "brass"}
    for group_key, cfg in ORCHESTRAL_GROUPS.items():
        label = cfg["label"]
        # already present? keep it
        if label in present:
            print(f"[COLLAPSE_DEBUG] {label} already in present, adding to keep set")
            add.add(label)
            continue
        members = set(cfg["members"])
        # if any explicit member showed up, add the group
        if any(m in present for m in members):
            add.add(label)
            continue
        # as a fallback: if per_model stats show non-trivial mean on any member, you may add
        # (commented out by default to keep precision)
        # if per_model and max(
        #       max(per_model["panns"]["mean_probs"].get(m, 0.0) for m in members),
        #       max(per_model["yamnet"]["mean_probs"].get(m, 0.0) for m in members)
        #   ) >= 0.002:
        #     add.add(label)
    # remove individual orchestral members from the visible list:
    orchestral_members = {m for g in ORCHESTRAL_GROUPS.values() for m in g["members"]}
    keep = [x for x in final_list if x not in orchestral_members]
    # add group labels in a stable way
    for label in ["Strings (section)", "Brass (section)", "Woodwinds"]:
        if label in add and label not in keep:
            keep.append(label)
    return keep

# Optional HTS-AT dependencies are resolved at runtime.
try:
    import torchaudio
    import torchaudio.functional as AF
    _HTSAT_MODEL = None
    _HTSAT_CLASSNAMES = None
    _HTSAT_READY = False
    _HAS_TORCHAUDIO = True
except Exception:
    _HAS_TORCHAUDIO = False
    _HTSAT_MODEL = None
    _HTSAT_CLASSNAMES = None
    _HTSAT_READY = False
    torchaudio = None
    AF = None

# Audio I/O & DSP
import soundfile as sf
import librosa

# PANNs
from panns_inference import AudioTagging as PANNsAT

# TF / YAMNet
import tensorflow as tf
import tensorflow_hub as hub

# Demucs (optional)
from demucs.pretrained import get_model as demucs_get_model
from demucs.apply import apply_model as demucs_apply

# ----------------------------
# Config
# ----------------------------
WIN_SEC = 5.0
HOP_SEC = 2.5

PANN_SR = 32000
YAM_SR = 16000
DEMUX_SR = 44100

# --- Calibrated thresholds (realistic for PANNs/YAMNet) ---
# A window is "positive" if its probability >= MEAN_THRESH.
# A track is "positive" if enough windows are positive (POS_RATIO_THRESH),
# across both models, OR one model is strongly confident (SINGLE_HIGH).
MEAN_THRESH = 0.006         # allow solid-but-not-hot means to pass (tuned to trace values)
POS_RATIO_THRESH = 0.05     # allow when windows fire consistently across time (tuned to trace values)
SINGLE_HIGH = 0.25          # keep as-is unless you want to relax the single-model override

# Brass remains conservative; we also keep the piano veto.
BRASS_GENERIC_GATE = 0.45
BRASS_GENERIC_PIANO_VETO = 0.50
PIANO_STRONG_RATIO = 0.30
PIANO_STRONG_MEAN = 0.60

# Per-model window thresholds for counting "positive" frames (pos_ratio)
POS_WINDOW_THRESH = {
    "panns": 0.045,   # tuned to avoid pos_ratio = 0 on rock tracks
    "yamnet": 0.018,  # YAMNet is more conservative; use a lower per-window gate
}

# Mix-only (no stems) base thresholds – calibrated for rock/pop while remaining conservative
BASE_RULES = {
    "MEAN_THRESH": 0.012,     # was 0.08 (too high for mix-only)
    "POS_RATIO_THRESH": 0.015,# was 0.12 (too high for mix-only)
    "SINGLE_HIGH": 0.12,      # was 0.25; PANNs rarely hits 0.25 on dense mixes
}

# Woodwinds set for relaxed thresholds
WOODWINDS = {
    "flute", "piccolo", "alto flute", "clarinet", "bass clarinet", 
    "oboe", "english horn", "bassoon", "recorder"
}

# Small, conservative instrument-specific floors used by the fail-safe (invoked only if nothing passes)
FAILSAFE_TH = {
    "electric_guitar": 0.006,
    "bass_guitar":     0.006,
    "drum_kit":        0.008,
    "piano":           0.006,
    "acoustic_guitar": 0.008,
    "organ":           0.004,
}
CANON_NAMES = {
    "electric_guitar": "Electric Guitar",
    "bass_guitar":     "Bass Guitar",
    "drum_kit":        "Drum Kit (acoustic)",
    "piano":           "Piano",
    "acoustic_guitar": "Acoustic Guitar",
    "organ":           "Organ",
    "woodwinds":       "Woodwinds (section)",
}

# --- MIX-ONLY RESCUE (conservative) ---
_MIX_ONLY_CFG = dict(
    MEAN_ANY=0.010,          # combined mean (panns.mean + yamnet.mean)
    POS_ANY=0.080,           # combined pos_ratio (panns.pos_ratio + yamnet.pos_ratio)
    PANN_POS_BONUS=0.060,    # allow if PANNs pos_ratio alone is strong
    MAX_PICKS=4,             # keep tight and reliable
    CORE_KEYS=[
        "acoustic_guitar",
        "electric_guitar",
        "drum_kit",
        "bass_guitar",
        "piano",
        "organ",
    ],
    NAME_MAP={
        "acoustic_guitar": "Acoustic Guitar",
        "electric_guitar": "Electric Guitar",
        "drum_kit": "Drum Kit (acoustic)",
        "bass_guitar": "Bass Guitar",
        "piano": "Piano",
        "organ": "Organ",
    },
)

def _g(d, *keys, default=0.0):
    """Nested get for dicts; returns default if any step missing."""
    cur = d
    for k in keys:
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur

def _mix_only_rescue_from_trace(trace):
    """
    Build a conservative instruments list from decision_trace when Demucs wasn't used
    and the main detector returned empty. Uses combined mean/pos across PANNs+YAMNet,
    with a PANNs-only pos bonus gate.
    """
    cfg = _MIX_ONLY_CFG
    picked = []
    scored = []

    # Access the per_model data structure from the debug dump
    per_model = _g(trace, "per_model", default={})
    panns_data = _g(per_model, "panns", default={})
    yamnet_data = _g(per_model, "yamnet", default={})
    
    panns_means = _g(panns_data, "mean_probs", default={})
    panns_pos = _g(panns_data, "pos_ratio", default={})
    yamnet_means = _g(yamnet_data, "mean_probs", default={})
    yamnet_pos = _g(yamnet_data, "pos_ratio", default={})

    for key in cfg["CORE_KEYS"]:
        p_mean = panns_means.get(key, 0.0)
        p_pos  = panns_pos.get(key, 0.0)
        y_mean = yamnet_means.get(key, 0.0)
        y_pos  = yamnet_pos.get(key, 0.0)

        comb_mean = p_mean + y_mean
        comb_pos  = p_pos + y_pos

        passes = ((comb_mean >= cfg["MEAN_ANY"] and comb_pos >= cfg["POS_ANY"])
                  or (p_pos >= cfg["PANN_POS_BONUS"]))

        # score = primary by combined_pos, tie-breaker by combined_mean
        score = (comb_pos, comb_mean)
        if passes:
            scored.append((score, key, dict(
                panns=dict(mean=p_mean, pos=p_pos),
                yamnet=dict(mean=y_mean, pos=y_pos),
                comb=dict(mean=comb_mean, pos=comb_pos),
            )))

    # sort best first and cap
    scored.sort(key=lambda x: x[0], reverse=True)
    for _, key, dbg in scored[:cfg["MAX_PICKS"]]:
        picked.append((cfg["NAME_MAP"].get(key, key), dbg))

    return picked

# ---------- STEM-AWARE ENSEMBLE SETTINGS ----------
# Instruments we care about for production (add more as needed).
TARGET_INSTRUMENTS = [
    "Electric Guitar",
    "Bass Guitar",
    "Drum Kit (acoustic)",
    "Piano",
    "Trumpet",
    "Trombone",
    "Saxophone"
]

# Preferred stems for each instrument (Demucs htdemucs order: [drums, bass, other, vocals])
# We'll weight evidence from preferred stems higher, and non-preferred stems lower.
STEM_PRIORS = {
    "Electric Guitar": {"other": 1.0, "mix": 0.5, "vocals": 0.1, "drums": 0.1, "bass": 0.1},
    "Bass Guitar":    {"bass": 1.0,  "mix": 0.6, "other": 0.2, "drums": 0.1, "vocals": 0.1},
    "Drum Kit (acoustic)": {"drums": 1.0, "mix": 0.6, "other": 0.2, "bass": 0.1, "vocals": 0.1},
    "Piano":          {"other": 1.0, "mix": 0.5, "vocals": 0.1, "drums": 0.1, "bass": 0.1},
    "Trumpet":        {"other": 1.0, "mix": 0.4, "vocals": 0.2, "drums": 0.1, "bass": 0.1},
    "Trombone":       {"other": 1.0, "mix": 0.4, "vocals": 0.2, "drums": 0.1, "bass": 0.1},
    "Saxophone":      {"other": 1.0, "mix": 0.4, "vocals": 0.2, "drums": 0.1, "bass": 0.1},
}

# Slightly different acceptance thresholds when Demucs is used (per instrument).
# We allow lower mean/ratio when the evidence dominantly comes from the preferred stem(s).
STEM_THRESHOLDS = {
    "Electric Guitar": {"MEAN": 0.055, "POS": 0.12, "SINGLE_HIGH": 0.22},
    "Bass Guitar":     {"MEAN": 0.040, "POS": 0.12, "SINGLE_HIGH": 0.20},
    "Drum Kit (acoustic)": {"MEAN": 0.070, "POS": 0.16, "SINGLE_HIGH": 0.22},
    "Piano":           {"MEAN": 0.035, "POS": 0.10, "SINGLE_HIGH": 0.18},
    "Trumpet":         {"MEAN": 0.016, "POS": 0.03, "SINGLE_HIGH": 0.028},
    "Trombone":        {"MEAN": 0.015, "POS": 0.03, "SINGLE_HIGH": 0.027},
    "Saxophone":       {"MEAN": 0.009, "POS": 0.02, "SINGLE_HIGH": 0.018},
}

# --- Mix-only tuning rules (bass + trumpet) ---
MIX_ONLY_TUNE = {
    "bass": {
        # Bass can show weak/zero pos_ratio in YAMNet; rely on mean + PANNs help.
        "COMBINED_MEAN_MIN": 0.0048,  # ~just below evidence seen on Beatles logs
        "PANN_MEAN_MIN": 0.0035,      # PANNs alone is often the strongest bass cue
        "ALLY_REQUIRE": ["Drum Kit (acoustic)"],   # safer when a kit is present
        "MAX_INJECTIONS": 1           # keep very conservative
    },
    "trumpet": {
        # Only nudge trumpet when Brass (section) already passed.
        "COMBINED_MEAN_MIN": 0.0022,  # tuned to pass Beatles traces (trumpet ≈ 0.0027)
        "POS_ANY_MIN": 0.0050,        # lowered to allow short transient trumpet windows to count
        "REQUIRE_SECTION": "Brass (section)"
    }
}

# --- Mix-only core booster v2 thresholds ---
MIX_ONLY_CORE_V2 = {
    "acoustic_guitar": {
        "mean": 0.006,     # updated from 0.007; cp≈0.023 observed
        "pos": 0.023       # was 0.035; cp≈0.023 observed
    },
    "drum_kit": {
        "mean": 0.006,     # improved recall for soft/brush kits
        "pos": 0.020       # v1.1.0: brushed/soft kits often show pos ~0.01–0.02; keep mean at 0.006
    },
    "electric_guitar": {
        "mean": 0.006,     # updated from 0.005; cp≈0.023 observed
        "pos": 0.023       # was 0.03; cp≈0.023 observed
    },
    "bass_guitar": {
        "mean": 0.004,     # updated from 0.006
        "pos": 0.000       # updated from 0.012
    }
}

TARGETS = {
    # key              display name              synonyms in AudioSet labels (lowercased)
    "piano":          ("Piano",                 ("piano",)),
    "trumpet":        ("Trumpet",               ("trumpet",)),
    "trombone":       ("Trombone",              ("trombone",)),
    "saxophone":      ("Saxophone",             ("saxophone",)),
    "brass":          ("Brass (section)",       ("brass instrument", "horn (instrument)")),
    "electric_guitar":("Electric Guitar",       ("electric guitar", "guitar, electric", "distorted electric guitar")),
    "acoustic_guitar":("Acoustic Guitar",       ("acoustic guitar", "guitar, acoustic")),
    "bass_guitar":    ("Bass Guitar",           ("bass guitar", "electric bass", "bass (musical instrument)")),
    "drum_kit":       ("Drum Kit (acoustic)",   ("drum kit", "drum set", "drums")),
    "organ":          ("Organ",                 ("organ", "electronic organ", "hammond organ")),
    # Strings kept conservative
    "strings":        ("Strings",               ("string section", "string orchestra", "violin", "cello", "viola")),
    
    # Woodwinds with canonical UI names
    "flute":          ("Flute",                 ("flute", "piccolo", "alto flute", "recorder")),
    "clarinet":       ("Clarinet",              ("clarinet", "bass clarinet")),
    "oboe":           ("Oboe",                  ("oboe", "english horn")),
    "bassoon":        ("Bassoon",               ("bassoon",)),
}

# Per-instrument calibrated thresholds and agreement policy
# Defaults remain conservative; robust instruments allow single-model positives.
THRESHOLDS = {
    # robust rhythm section
    "electric_guitar": {"mean": 0.06, "ratio": 0.12, "single": 0.20, "require_both": False},
    "bass_guitar":     {"mean": 0.06, "ratio": 0.12, "single": 0.20, "require_both": False},
    "drum_kit":        {"mean": 0.06, "ratio": 0.12, "single": 0.18, "require_both": False},
    "acoustic_guitar": {"mean": 0.07, "ratio": 0.15, "single": 0.22, "require_both": False},
    "piano":           {"mean": 0.07, "ratio": 0.15, "single": 0.22, "require_both": False},
    "organ":           {"mean": 0.08, "ratio": 0.15, "single": 0.25, "require_both": False},

    # families that are commonly confused — keep stricter
    "strings":   {"mean": 0.10, "ratio": 0.18, "single": 0.30, "require_both": True},
    "trumpet":   {"mean": 0.10, "ratio": 0.15, "single": 0.30, "require_both": True},
    "trombone":  {"mean": 0.10, "ratio": 0.15, "single": 0.30, "require_both": True},
    "saxophone": {"mean": 0.10, "ratio": 0.15, "single": 0.30, "require_both": True},
    "brass":     {"mean": 0.12, "ratio": 0.20, "single": 0.35, "require_both": True},
    
    # Woodwinds with relaxed thresholds
    "flute":     {"mean": 0.009, "ratio": 0.010, "single": 0.15, "require_both": True},
    "clarinet":  {"mean": 0.009, "ratio": 0.010, "single": 0.15, "require_both": True},
    "oboe":      {"mean": 0.009, "ratio": 0.010, "single": 0.15, "require_both": True},
    "bassoon":   {"mean": 0.009, "ratio": 0.010, "single": 0.15, "require_both": True},
}

RULES = {
    "mean_thresh": MEAN_THRESH,
    "pos_ratio_thresh": POS_RATIO_THRESH,
    "single_high": SINGLE_HIGH,
    "brass_generic_gate": 0.45,
    "brass_generic_piano_veto": 0.5,
    "piano_strong_ratio": 0.3,
    "piano_strong_mean": 0.6,
    # --- New, orchestra-friendly horn assist (empirical; tuned on Beatles/Beach Boys tests) ---
    "orchestral_horn_sum_mean_min": 0.014,   # sum of means across stems for Trumpet+Trombone
    "orchestral_trumpet_other_mean_min": 0.0025,
    "orchestral_trombone_other_mean_min": 0.0025,
    "orchestral_horn_mix_mean_min": 0.0016,
    "orchestral_allow_section_if_two_close": True
}

# --- Mix-only woodwinds v2 (robust key resolution) ---
RULES['mix_only_woodwinds_v2'] = {
    # sum across all woodwinds (combined PANNs+YAMNet)
    'SUM_MEAN_MIN': 0.0045,   # was 0.006 but your trace showed sums were near-zero due to key miss; we compute real sums now
    'SUM_POS_MIN':  0.015,    # was 0.02; bring within reach of current per-model pos
    'ANY_POS_MIN':  0.010,    # any single instrument pos can help (PANNs or YAMNet)
    'CTX_GATE':     0.005,    # require some orchestral context already present
    'SAX_GUARD_RATIO': 1.4,   # if sax dominates woodwinds by this factor, hold back
    'MAX_ADDS': 2,            # keep it conservative
}

# --- Orchestral horn boost v2 (adds French Horn) ---
RULES["orchestral_horn_boost_v2"] = {
    # Sum across MIX + OTHER stems (Trumpet + Trombone + French Horn if present)
    "SUM3_MIN": 0.012,
    # Per-stem minimums for French Horn (conservative but permissive on stems)
    "FRHN_MIN_MIX": 0.0008,
    "FRHN_MIN_OTHER": 0.0012,
    # Section promotion: at least 2 horns detected -> ensure "Brass (section)"
    "SECTION_MIN_COUNT": 2,
}

# --- Strings section boost v1 ---
RULES["strings_section_boost_v1"] = {
    # Sum across MIX+OTHER for all string instruments and generic strings
    "SUM_ALL_MIN": 0.022,
    # Per-stem minima for individual instruments (conservative floors)
    "INST_MIN_MIX": 0.0015,
    "INST_MIN_OTHER": 0.0020,
    # Generic strings label (if present) needs slightly higher floors to avoid rock false-positives
    "GEN_MIN_MIX": 0.0025,
    "GEN_MIN_OTHER": 0.0035,
    # Section promotion requires at least 2 distinct string instruments OR (generic strings + 1 instrument)
    "SECTION_MIN_COUNT": 2,
    # If only the generic "Strings" key fires (no individuals), require a higher total sum
    "GEN_ONLY_SUM_MIN": 0.028,
}

# --- Strings (section) conservative, stem-aware thresholds ---
STRINGS_RULES = {
    # Require evidence across stems + combined energy so we don't light up on pads.
    # Tuned to prefer real orchestral strings in "other" (+ a little in "mix").
    "SUM_MIN": 0.018,          # total strings energy across stems & models
    "MIX_MIN_EACH": 0.0009,    # per-instrument floor in mix stem
    "OTHER_MIN_EACH": 0.0018,  # per-instrument floor in other stem
    "SECTION_MIN_COUNT": 2,    # promote section if any 2 of {violin, viola, cello, double bass} pass
}

# Conservative, tuned to favor precision over recall.
RULES["WOODWINDS"] = {
    # Sum of means across stems (flute+clarinet+oboe+bassoon)
    "SUM_MIN": 0.010,         # total woodwind energy threshold (PANNs+YAMNet)
    # Individual stem minimums (very low but non-zero to avoid pure noise)
    "MIX_MIN": 0.0009,        # min mean in mix stem for at least 2 instruments
    "OTHER_MIN": 0.0011,      # min mean in "other" stem for at least 2 instruments
    "POS_ANY": 0.015,         # combined pos_ratio gate
    # Promote section when >=2 members have evidence above stem mins
    "SECTION_MIN_COUNT": 2,
    # Optional single-instrument display (only flute for now, very conservative)
    "FLUTE_SINGLE": {
        "SUM_MIN": 0.006,
        "MIX_MIN": 0.0022,
        "OTHER_MIN": 0.0030,
        "POS_ANY": 0.025
    }
}

RULES["TIMPANI"] = {
    # Distinct low orchestral drum; allow either stem to carry it.
    "SUM_MIN": 0.0065,
    "MIX_MIN": 0.0040,
    "OTHER_MIN": 0.0040,
    "POS_ANY": 0.020
}

# --- Woodwinds (mix-only) conservative thresholds ---
WOODWIND_RULES = {
    # Aggregate evidence across quiet woodwinds
    # (these values are intentionally lower than brass/strings;
    #  they must pass multiple gates + orchestral context)
    "SUM_MEAN_MIN": 0.0040,     # sum of means over {flute, clarinet, oboe, bassoon, piccolo}
    "SUM_POS_MIN":  0.0100,     # sum of pos_ratios over the same set
    "ANY_POS_MIN":  0.0300,     # OR: any single woodwind pos_ratio is strong on its own
    "REQUIRE_CONTEXT": True,    # only allow if strings or brass already selected
    "MAX_ADD": 1,               # we only add 'Woodwinds (section)' at most once
}

# --- Mix-only woodwinds booster v1 thresholds ---
MIX_ONLY_WOODWINDS_V1 = {
    "per_instrument": {
        "mean": 0.0025,    # keep
        "pos": 0.010       # was 0.02; flute cp≈0.0115 observed
    },
    "section_min_count": 1,     # was 2
    "strong_individual": {
        "mean": 0.006,     # keep
        "pos": 0.035       # was 0.05
    },
    "sax_pos_strong": 0.045,
    "piano_dom_ratio": 0.45
}

# canonical keys used in decision_trace.per_model[*]
WOODWIND_KEYS = ["flute", "piccolo", "clarinet", "oboe", "bassoon"]

# Families and their member labels as emitted by your models/parsers
FAMILY_GROUPS = {
    "Strings (section)": ["violin", "viola", "cello", "double_bass", "strings"],
    "Brass (section)":   ["trumpet", "trombone", "french_horn", "tuba", "brass"],
    "Woodwinds":         ["flute", "clarinet", "oboe", "bassoon", "saxophone"],  # include sax as woodwind
}

# Default (precise) family roll-up gates; evidence is across PANNs & YAMNet
FAMILY_ROLLUP_V1 = {
    "agg_mean": 0.001,     # was 0.002 - more permissive for woodwinds recall
    "agg_pos":  0.0,       # was 0.01 - ignore pos ratio entirely
    "single_high": 0.01,   # was 0.2 - much lower spike threshold
    "require_context": True,  # for Woodwinds, require Strings or Brass present to reduce FPs
    "context_gate": 0.002,  # minimum combined-mean evidence to count as orchestral "context"
}

# Per-run recall toggle (more permissive)
if os.getenv("RNA_WW_LENIENT", "0") == "1":
    # even more permissive for lenient mode
    FAMILY_ROLLUP_V1.update({
        "agg_mean": 0.0005,
        "agg_pos":  0.0,
        "single_high": 0.005,
        "context_gate": 0.001,
    })

# Absolute demo switch: always add groups listed here when orchestral context is present.
# Example: export RNA_GROUPS_ALWAYS="Woodwinds"
GROUPS_ALWAYS = {s.strip() for s in os.getenv("RNA_GROUPS_ALWAYS", "").split(",") if s.strip()}

# --- Orchestral grouping configuration ---
ORCHESTRAL_GROUPS = {
    "Strings (section)": {
        "members": ["violin", "viola", "cello", "double_bass", "strings"],
        "label": "Strings (section)"
    },
    "Brass (section)": {
        "members": ["trumpet", "trombone", "french_horn", "tuba", "brass"],
        "label": "Brass (section)"
    },
    "Woodwinds": {
        # include sax by default in "woodwinds" (can be toggled by env if needed)
        "members": ["flute", "clarinet", "oboe", "bassoon", "saxophone"],
        "label": "Woodwinds"
    }
}


# Candidates per instrument label (AudioSet / PANNs variations)
_STRINGS_LABELS = {
    "violin": {
        "contains": ["violin", "fiddle"],
        "equals":   ["violin", "violin, fiddle", "fiddle"],
    },
    "viola": {
        "contains": ["viola"],
        "equals":   ["viola"],
    },
    "cello": {
        "contains": ["cello"],
        "equals":   ["cello"],
    },
    "double_bass": {
        "contains": ["double bass", "contrabass", "upright bass"],
        "equals":   ["double bass", "contrabass", "double_bass"],
    },
    # Optional generic catch-all if a model exposes a section label directly
    "section_generic": {
        "contains": ["string section", "strings (section)", "strings section", "strings"],
        "equals":   ["Strings (section)", "String section", "strings"],
    },
}

# ----------------------------
# Helpers
# ----------------------------

# --- Safe helpers & normalizers ---
def _is_num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool)

def _as_dict(x):
    return x if isinstance(x, dict) else {}

def _normalize_by_stem(by_stem_raw: dict | None) -> dict:
    """
    Returns a dict with fixed stem keys and dict values only.
    Unknown stems are ignored. Missing stems become {}.
    """
    stems = ("mix", "other", "bass", "drums", "vocals")
    out = {s: {} for s in stems}
    if isinstance(by_stem_raw, dict):
        for s in stems:
            val = by_stem_raw.get(s)
            out[s] = val if isinstance(val, dict) else {}
    return out

def _combined_mean_legacy4(stats: dict | None) -> float:
    """
    Sum of model means (PANNs + YAMNet) for one instrument entry.
    stats format: {"panns": {"mean": float}, "yamnet": {"mean": float}, ...}
    """
    if not isinstance(stats, dict):
        return 0.0
    total = 0.0
    panns = stats.get("panns")
    yamnet = stats.get("yamnet")
    if isinstance(panns, dict) and _is_num(panns.get("mean")):
        total += float(panns["mean"])
    if isinstance(yamnet, dict) and _is_num(yamnet.get("mean")):
        total += float(yamnet["mean"])
    return total

def _stem_mean(by_stem: dict, stem: str, inst_key: str | None) -> float:
    """
    Combined (PANNs+YAMNet) mean for a specific stem+instrument key.
    Safe for missing stems/keys.
    """
    if not inst_key:
        return 0.0
    stem_bucket = by_stem.get(stem)
    if not isinstance(stem_bucket, dict):
        return 0.0
    return _combined_mean(stem_bucket.get(inst_key))

def _sum_all_means(by_stem: dict) -> float:
    """
    Sum of combined means across all stems & all instruments.
    Ignores non-dict buckets and non-dict entries.
    """
    total = 0.0
    for stem in ("mix", "other", "bass", "drums", "vocals"):
        bucket = by_stem.get(stem)
        if not isinstance(bucket, dict):
            continue
        for _k, stats in bucket.items():
            total += _combined_mean(stats)
    return total

def _resolve_key(candidates, scores_for_stem):
    """
    Find the first available label key for an instrument across model vocab variants.
    `candidates` is a list of possible label strings (e.g., ["flute","Flute","piccolo","Piccolo"]).
    `scores_for_stem` is the dict for a single stem (already normalized to dicts of dicts).
    Returns the winning key or None.
    """
    for k in candidates:
        if not isinstance(scores_for_stem, dict):
            continue
        if k in scores_for_stem:
            return k
    return None

def _resolve_woodwind_keys(by_stem):
    """
    Resolve model-specific label keys for flute/clarinet/oboe/bassoon across stems.
    Returns a dict: {"flute": "Flute", "clarinet": "clarinet", "oboe": "Oboe", "bassoon": "Bassoon"} (as present),
    omitting any that aren't found anywhere.
    """
    variants = {
        "flute":    ["flute","Flute","piccolo","Piccolo"],
        "clarinet": ["clarinet","Clarinet","bass clarinet","Bass clarinet","contrabass clarinet","Contra-clarinet","Contra clarinet"],
        "oboe":     ["oboe","Oboe"],
        "bassoon":  ["bassoon","Bassoon"],
    }
    resolved = {}
    for stem_name, stem_scores in _as_dict(by_stem).items():
        for name, cand in variants.items():
            if name in resolved:
                continue  # already resolved
            hit = _resolve_key(cand, stem_scores)
            if hit:
                resolved[name] = hit
    return resolved

# ---- Strings helpers (safe on both Demucs and mix-only) ----
STRINGS_FAMILY = ["violin", "viola", "cello", "double_bass", "strings"]

def _combined_mean_safe(panns_mean, yamnet_mean):
    try:
        a = float(panns_mean or 0.0)
        b = float(yamnet_mean or 0.0)
    except Exception:
        a, b = 0.0, 0.0
    return a + b

def _ensure_mix_by_stem(per_model, by_stem):
    """
    Guarantee by_stem['mix'] exists and is a dict of label->combined_mean
    so that section boosts can run even without Demucs.
    """
    if not isinstance(by_stem, dict):
        by_stem = {}
    if "mix" not in by_stem or not isinstance(by_stem.get("mix"), dict):
        by_stem["mix"] = {}
    # Aggregate both models into a single 'mix' mean
    pm = per_model.get("panns", {}).get("mean_probs", {}) if isinstance(per_model, dict) else {}
    ym = per_model.get("yamnet", {}).get("mean_probs", {}) if isinstance(per_model, dict) else {}
    all_keys = set(pm.keys()) | set(ym.keys())
    for k in all_keys:
        by_stem["mix"][k] = _combined_mean_safe(pm.get(k, 0.0), ym.get(k, 0.0))
    return by_stem

def _sum_family_across_stems(by_stem, labels):
    total = 0.0
    if not isinstance(by_stem, dict):
        return 0.0
    for stem_dict in by_stem.values():
        if not isinstance(stem_dict, dict):
            continue
        for lbl in labels:
            val = stem_dict.get(lbl)
            if isinstance(val, (int, float)):
                total += float(val)
    return total

def _stem_gate(by_stem, stem_name, label, thr):
    """
    Passes if by_stem[stem_name][label] >= thr (safe on missing keys).
    """
    try:
        v = float(by_stem.get(stem_name, {}).get(label, 0.0))
        return v >= float(thr)
    except Exception:
        return False

def _count_family_meets_any(by_stem, labels, thr):
    """
    Count how many labels have any stem mean >= thr.
    """
    cnt = 0
    for lbl in labels:
        hit = False
        for stem_name, stem_map in (by_stem.items() if isinstance(by_stem, dict) else []):
            try:
                if float(stem_map.get(lbl, 0.0)) >= float(thr):
                    hit = True
                    break
            except Exception:
                pass
        if hit:
            cnt += 1
    return cnt

def _apply_orchestral_strings_boost(by_stem, out_instruments, trace, relax_factor=1.0):
    """
    Detects 'Strings (section)' conservatively using stem-aware evidence.
    Works in Demucs and mix-only (thanks to _ensure_mix_by_stem).
    """
    # Tuned on Beatles/Beach Boys material; multiplied by relax_factor when invoked in rescue mode.
    RULES = {
        "SUM_MIN": 0.020 * relax_factor,             # total strings-family energy over all stems
        "MIX_MIN": 0.0016 * relax_factor,            # evidence in mix stem
        "OTHER_MIN": 0.0022 * relax_factor,          # evidence in "other" stem (where sections often live)
        "FAMILY_ANY_MIN": 0.0011 * relax_factor,     # at least N family members exceed this anywhere
        "FAMILY_ANY_COUNT": 2,                        # require at least 2 of {violin, viola, cello, db, strings}
    }
    if not isinstance(out_instruments, (set, list)):
        return

    total = _sum_family_across_stems(by_stem, STRINGS_FAMILY)
    mix_ok = _stem_gate(by_stem, "mix", "strings", RULES["MIX_MIN"]) \
             or _stem_gate(by_stem, "mix", "violin", RULES["MIX_MIN"])
    other_ok = _stem_gate(by_stem, "other", "strings", RULES["OTHER_MIN"]) \
               or _stem_gate(by_stem, "other", "violin", RULES["OTHER_MIN"])
    fam_hits = _count_family_meets_any(by_stem, STRINGS_FAMILY, RULES["FAMILY_ANY_MIN"])

    why = {
        "total_strings_sum": round(total, 6),
        "mix_gate": bool(mix_ok),
        "other_gate": bool(other_ok),
        "family_hits": int(fam_hits),
        "rules": RULES,
    }
    trace.setdefault("strings_section", {})["decision"] = why

    if total >= RULES["SUM_MIN"] and (mix_ok or other_ok) and fam_hits >= RULES["FAMILY_ANY_COUNT"]:
        if isinstance(out_instruments, set):
            out_instruments.add("Strings (section)")
        else:
            if "Strings (section)" not in out_instruments:
                out_instruments.append("Strings (section)")
        trace["strings_section"]["added"] = True
    else:
        trace["strings_section"]["added"] = False

def _rescue_if_empty(by_stem, instruments, trace):
    """
    If nothing passed yet, run a relaxed orchestral pass (strings + horns v1/v2 if present).
    """
    if instruments:
        return
    trace.setdefault("rescue", {})
    trace["rescue"]["triggered"] = True
    # Relaxed strings
    _apply_orchestral_strings_boost(by_stem, instruments, trace, relax_factor=0.7)
    # Existing horn boosts (v1/v2) are assumed present; call them in relaxed mode if available.
    try:
        if "_apply_orchestral_horn_boost" in globals():
            _apply_orchestral_horn_boost(by_stem, instruments, trace)  # its own internal thresholds
    except Exception as e:
        trace["rescue"]["horns_v1_error"] = str(e)
    try:
        if "_apply_orchestral_horn_boost_v2" in globals():
            _apply_orchestral_horn_boost_v2(by_stem, instruments, trace)  # french horn + section logic
    except Exception as e:
        trace["rescue"]["horns_v2_error"] = str(e)

def _mix_only_rescue_from_trace(per_model: dict, *, max_picks: int = 4):
    """
    Build a small, conservative set of core instruments from per-model stats when Demucs
    isn't used (mix-only) or when the stem path fails and the current instrument list is empty.
    Uses tight thresholds to avoid hallucinations.
    """
    if not isinstance(per_model, dict):
        return []

    # Thresholds (conservative)
    MEAN_ANY = 0.006      # combined (panns+yamnet) mean
    POS_ANY  = 0.02       # combined pos_ratio
    PANN_POS_BONUS = 0.06 # allow if PANNs pos_ratio alone is strong
    PIANO_DOM_RATIO = 0.45  # if piano dominates too strongly, don't promote sections

    # Canonical keys in per_model (snake_case)
    CORE = ["electric_guitar", "acoustic_guitar", "bass_guitar", "drum_kit", "piano", "organ"]
    SECTIONS = ["strings", "brass"]

    def mget(model: str, field: str, key: str, default: float = 0.0) -> float:
        return float(per_model.get(model, {}).get(field, {}).get(key, default) or 0.0)

    picks = []
    # Score builder
    for k in CORE:
        mean = mget("panns", "mean_probs", k) + mget("yamnet", "mean_probs", k)
        pos  = mget("panns", "pos_ratio",   k) + mget("yamnet", "pos_ratio",   k)
        pann_pos = mget("panns", "pos_ratio", k)
        if (mean >= MEAN_ANY and pos >= POS_ANY) or (pann_pos >= PANN_POS_BONUS):
            # Rank by combined evidence
            score = mean + pos + (0.5 * pann_pos)
            picks.append((k, score))

    # Consider sections only if piano isn't overwhelmingly dominant
    sum_core_mean = sum(mget("panns","mean_probs",k)+mget("yamnet","mean_probs",k) for k in CORE)
    piano_mean = mget("panns","mean_probs","piano") + mget("yamnet","mean_probs","piano")
    piano_dominant = (sum_core_mean > 0) and (piano_mean / max(sum_core_mean, 1e-9) > PIANO_DOM_RATIO)

    if not piano_dominant:
        for k in SECTIONS:
            mean = mget("panns", "mean_probs", k) + mget("yamnet", "mean_probs", k)
            pos  = mget("panns", "pos_ratio",   k) + mget("yamnet", "pos_ratio",   k)
            pann_pos = mget("panns", "pos_ratio", k)
            if (mean >= MEAN_ANY and pos >= POS_ANY) or (pann_pos >= PANN_POS_BONUS):
                score = mean + pos + (0.5 * pann_pos)
                picks.append((k, score))

    # Rank & cap
    picks.sort(key=lambda x: x[1], reverse=True)
    picks = picks[:max_picks]

    # Map snake_case to display names used elsewhere
    NAMES = {
        "electric_guitar": "Electric Guitar",
        "acoustic_guitar": "Acoustic Guitar",
        "bass_guitar":     "Bass Guitar",
        "drum_kit":        "Drum Kit (acoustic)",
        "piano":           "Piano",
        "organ":           "Organ",
        "strings":         "Strings (section)",
        "brass":           "Brass (section)",
    }
    return [NAMES[k] for (k, _) in picks if k in NAMES]

def _pos_ratio_from_windows(win_probs, model_key, thr=None):
    """
    Compute positive-ratio for a time series of probabilities using a per-model threshold.
    - win_probs: 1D numpy array/list of frame/window probabilities for a class
    - model_key: 'panns' or 'yamnet'
    """
    import numpy as np
    if win_probs is None:
        return 0.0
    arr = np.asarray(win_probs, dtype=float)
    gate = POS_WINDOW_THRESH.get(model_key, 0.05) if thr is None else float(thr)
    if arr.size == 0:
        return 0.0
    return float((arr >= gate).mean())

def _first_key_like(bucket: dict, candidates: dict) -> str | None:
    """
    Given a stem bucket (dict of {label: stats}) and a label pattern set,
    return the first key matching either an equals or contains rule (case-insensitive).
    """
    if not isinstance(bucket, dict):
        return None
    keys = list(bucket.keys())
    # exact (case-insensitive)
    eq = {k.lower() for k in candidates.get("equals", [])}
    for k in keys:
        if k.lower() in eq:
            return k
    # contains (case-insensitive substring)
    subs = [s.lower() for s in candidates.get("contains", [])]
    for k in keys:
        lk = k.lower()
        if any(s in lk for s in subs):
            return k
    return None

def _resolve_strings_keys(by_stem: dict) -> dict:
    """
    Resolve the actual model keys for violin/viola/cello/double_bass (and optional section_generic)
    by looking across 'other' then 'mix' stems for best chance of finding them.
    Returns {"violin": key|None, "viola": key|None, "cello": key|None, "double_bass": key|None, "section_generic": key|None}
    """
    out = {k: None for k in _STRINGS_LABELS.keys()}
    for inst, patt in _STRINGS_LABELS.items():
        key = None
        # prefer 'other', then 'mix'
        other_b = by_stem.get("other")
        mix_b = by_stem.get("mix")
        key = _first_key_like(other_b, patt) or _first_key_like(mix_b, patt)
        out[inst] = key
    return out

def _apply_strings_section_boost(by_stem: dict, present: set, trace: dict) -> None:
    """
    Stem-aware, conservative detector for 'Strings (section)'.
    Requires Demucs stems with per-stem scores (already normalized to dicts).
    Will only add 'Strings (section)' when multiple individual strings show
    consistent energy across 'other' and 'mix' stems and the total strings
    energy exceeds SUM_MIN.
    """
    try:
        if not isinstance(by_stem, dict):
            return
        # ensure required stems exist (they will be {} if missing due to _normalize_by_stem)
        if "mix" not in by_stem or "other" not in by_stem:
            return

        keys = _resolve_strings_keys(by_stem)

        # Pull per-stem combined means using the safe helper
        vm = _stem_mean(by_stem, "mix",   keys.get("violin"))
        vo = _stem_mean(by_stem, "other", keys.get("violin"))
        iam = _stem_mean(by_stem, "mix",   keys.get("viola"))
        iao = _stem_mean(by_stem, "other", keys.get("viola"))
        cm = _stem_mean(by_stem, "mix",   keys.get("cello"))
        co = _stem_mean(by_stem, "other", keys.get("cello"))
        dbm = _stem_mean(by_stem, "mix",   keys.get("double_bass"))
        dbo = _stem_mean(by_stem, "other", keys.get("double_bass"))

        # Total strings energy across stems (robust to missing keys)
        total_strings_energy = (
            vm + vo + iam + iao + cm + co + dbm + dbo
        )
        # Also add generic section key if model exposed it (as supporting energy only)
        sec_key = keys.get("section_generic")
        if sec_key:
            total_strings_energy += _stem_mean(by_stem, "mix", sec_key)
            total_strings_energy += _stem_mean(by_stem, "other", sec_key)

        RULE = STRINGS_RULES
        # Count how many instruments pass BOTH stem floors
        def passes_pair(mix_val: float, other_val: float) -> bool:
            return (mix_val >= RULE["MIX_MIN_EACH"]) and (other_val >= RULE["OTHER_MIN_EACH"])

        passed = 0
        if passes_pair(vm, vo):   passed += 1
        if passes_pair(iam, iao): passed += 1
        if passes_pair(cm, co):   passed += 1
        if passes_pair(dbm, dbo): passed += 1

        decision = {
            "vmix": vm, "vother": vo,
            "violamix": iam, "violaother": iao,
            "cellomix": cm, "celloother": co,
            "dbmix": dbm, "dbother": dbo,
            "sum": total_strings_energy,
            "passed_count": passed,
            "rule": RULE,
            "sec_key": sec_key,
        }

        # Promote section if enough individual parts pass AND the total energy is high enough
        if (passed >= RULE["SECTION_MIN_COUNT"]) and (total_strings_energy >= RULE["SUM_MIN"]):
            present.add("Strings (section)")
            decision["result"] = "added"
        else:
            decision["result"] = "no_add"

        trace.setdefault("strings_section", []).append(decision)

    except Exception as e:
        trace.setdefault("errors", []).append({
            "strings_section": f"{type(e).__name__}: {e}"
        })

def load_audio_mono(path: str) -> Tuple[np.ndarray, int]:
    x, sr = sf.read(path, always_2d=False)
    if x.ndim == 2:
        x = x.mean(axis=1)
    return x.astype("float32"), sr

def resample(x: np.ndarray, orig_sr: int, target_sr: int) -> np.ndarray:
    if orig_sr == target_sr:
        return x
    return librosa.resample(x, orig_sr=orig_sr, target_sr=target_sr, res_type="kaiser_best").astype("float32")

def frame_indices(n_samples: int, sr: int, win_sec: float, hop_sec: float) -> List[Tuple[int,int]]:
    win = int(round(win_sec * sr))
    hop = int(round(hop_sec * sr))
    idxs = []
    i = 0
    while i + win <= n_samples:
        idxs.append((i, i+win))
        i += hop
    if not idxs and n_samples > 0 and n_samples < win:
        # short clip: single window
        idxs.append((0, n_samples))
    return idxs

@dataclass
class ModelMaps:
    panns: Dict[str, List[int]]
    yamnet: Dict[str, List[int]]

def build_label_maps_panns(panns_model) -> Dict[str, List[int]]:
    # panns_inference exposes .labels (AudioSet display names)
    labels = [str(s).lower() for s in getattr(panns_model, "labels", [])]
    maps: Dict[str, List[int]] = {}
    for key, (_, synonyms) in TARGETS.items():
        idxs = []
        # prefer exact match; fall back to substring-contains
        for i, lbl in enumerate(labels):
            if any(lbl == syn for syn in synonyms) or any(syn in lbl for syn in synonyms):
                idxs.append(i)
        maps[key] = sorted(set(idxs))
    return maps

def build_label_maps_yamnet(yam_model) -> Dict[str, List[int]]:
    # YAMNet exposes a class map CSV via model.class_map_path()
    maps: Dict[str, List[int]] = {}
    try:
        class_map_path = yam_model.class_map_path().numpy().decode("utf-8")
        import csv, tensorflow as tf
        with tf.io.gfile.GFile(class_map_path, "r") as f:
            reader = list(csv.DictReader(f))
        labels = [row.get("display_name","").strip().lower() for row in reader]
    except Exception:
        labels = []  # fallback: nothing
    for key, (_, synonyms) in TARGETS.items():
        idxs = []
        for i, lbl in enumerate(labels):
            if any(lbl == syn for syn in synonyms) or any(syn in lbl for syn in synonyms):
                idxs.append(i)
        maps[key] = sorted(set(idxs))
    return maps

def max_prob_from_indices(vec: np.ndarray, idxs: List[int]) -> float:
    if not idxs:
        return 0.0
    vals = [float(vec[i]) for i in idxs if i < len(vec)]
    return float(max(vals)) if vals else 0.0

def _classify_waveform_for_targets(wav_np, sr, cnn14_model, yamnet_model, targets):
    """
    Run the existing windowed scoring on one mono/stereo float32 waveform.
    Returns: dict[instrument] -> {"panns": {...}, "yamnet": {...}, "mean": float, "pos_ratio": float}
    NOTE: This reuses existing functions that compute per-window scores,
    then aggregate to mean/pos_ratio per instrument.
    """
    # Build label maps for the models
    maps = ModelMaps(
        panns=build_label_maps_panns(cnn14_model),
        yamnet=build_label_maps_yamnet(yamnet_model),
    )
    
    # Run the existing windowed analysis
    per_win, nwin = run_models_over_windows(wav_np, cnn14_model, yamnet_model, maps)
    
    # Summarize results for both models
    panns_mean, panns_ratio = summarize_model_windows(per_win["panns"], "panns")
    yam_mean, yam_ratio = summarize_model_windows(per_win["yamnet"], "yamnet")

    out = {}
    for inst in targets:
        # Map target instrument to TARGETS key
        target_key = None
        for key, (display_name, _) in TARGETS.items():
            if display_name == inst:
                target_key = key
                break
        
        if target_key is None:
            continue
            
        p_mean = panns_mean.get(target_key, 0.0)
        p_ratio = panns_ratio.get(target_key, 0.0)
        y_mean = yam_mean.get(target_key, 0.0)
        y_ratio = yam_ratio.get(target_key, 0.0)
        
        out[inst] = {
            "panns": {"mean": p_mean, "pos_ratio": p_ratio, "max": p_mean},
            "yamnet": {"mean": y_mean, "pos_ratio": y_ratio, "max": y_mean},
            "mean": max(p_mean, y_mean),
            "pos_ratio": max(p_ratio, y_ratio),
            "max": max(p_mean, y_mean),
        }
    return out

# ----------------------------
# Main inference
# ----------------------------
def run_models_over_windows(wav: np.ndarray, panns: PANNsAT, yamnet, maps: ModelMaps) -> Tuple[Dict[str, List[float]], int]:
    """
    Returns per-window probabilities per target for both models.
    out["panns"][key] -> [p1, p2, ...]; out["yamnet"][key] -> [...]
    """
    # Pre-resample full signals once
    wav_panns = resample(wav, orig_sr=GLOBAL_SR, target_sr=PANN_SR)
    wav_yam = resample(wav, orig_sr=GLOBAL_SR, target_sr=YAM_SR)

    idxs_p = frame_indices(len(wav_panns), PANN_SR, WIN_SEC, HOP_SEC)
    idxs_y = frame_indices(len(wav_yam), YAM_SR, WIN_SEC, HOP_SEC)
    # Align by number of windows (use min)
    n = min(len(idxs_p), len(idxs_y))
    idxs_p, idxs_y = idxs_p[:n], idxs_y[:n]

    panns_out: Dict[str, List[float]] = {k: [] for k in TARGETS.keys()}
    yam_out: Dict[str, List[float]] = {k: [] for k in TARGETS.keys()}

    for (s1, e1), (s2, e2) in zip(idxs_p, idxs_y):
        # PANNs
        seg_p = wav_panns[s1:e1]
        # PANNs expects (batch, samples)
        panns_result = panns.inference(seg_p[None, :])
        if isinstance(panns_result, tuple):
            pr = panns_result[0][0]  # (527,)
        else:
            pr = panns_result["clipwise_output"][0]  # (527,)
        # YAMNet
        seg_y = tf.constant(wav_yam[s2:e2])
        yscores, yemb, yspect = yamnet(seg_y)
        yvec = tf.reduce_mean(yscores, axis=0).numpy()  # (521,)

        for key in TARGETS.keys():
            panns_out[key].append(max_prob_from_indices(pr, maps.panns[key]))
            yam_out[key].append(max_prob_from_indices(yvec, maps.yamnet[key]))

    return {"panns": panns_out, "yamnet": yam_out}, n

def summarize_model_windows(per_win: Dict[str, List[float]], model_key: str = "panns") -> Tuple[Dict[str,float], Dict[str,float]]:
    mean_probs = {k: float(np.mean(v)) if v else 0.0 for k, v in per_win.items()}
    pos_ratio  = {k: _pos_ratio_from_windows(v, model_key) for k, v in per_win.items()}
    return mean_probs, pos_ratio

def decide_track(mean_a: Dict[str,float], ratio_a: Dict[str,float],
                 mean_b: Dict[str,float], ratio_b: Dict[str,float]) -> Dict[str,bool]:
    """
    Per-instrument decision using calibrated thresholds:
      - Compute model-positive for each model with per-key mean/ratio thresholds.
      - If require_both=True: need both models positive OR a strong single (per-key 'single').
      - If require_both=False: need either model positive OR a strong single.
    """
    out: Dict[str,bool] = {}
    for key in TARGETS.keys():
        cfg = THRESHOLDS.get(key, {"mean": BASE_RULES["MEAN_THRESH"], "ratio": BASE_RULES["POS_RATIO_THRESH"], "single": BASE_RULES["SINGLE_HIGH"], "require_both": True})
        mth, rth, single, need_both = cfg["mean"], cfg["ratio"], cfg["single"], cfg["require_both"]
        
        # Apply relaxed thresholds for woodwinds
        if key in WOODWINDS:
            mth = min(mth, 0.009)  # Relax from 0.012 to 0.009
            rth = min(rth, 0.010)  # Relax from 0.015 to 0.010

        a_pos = (mean_a.get(key,0.0) >= mth) and (ratio_a.get(key,0.0) >= rth)
        b_pos = (mean_b.get(key,0.0) >= mth) and (ratio_b.get(key,0.0) >= rth)
        hi_mean = max(mean_a.get(key,0.0), mean_b.get(key,0.0))
        hi_ratio = max(ratio_a.get(key,0.0), ratio_b.get(key,0.0))

        if need_both:
            out[key] = (a_pos and b_pos) or (hi_mean >= single and hi_ratio >= 0.05)
        else:
            out[key] = (a_pos or b_pos) or (hi_mean >= single and hi_ratio >= 0.05)
    return out

def brass_gate(decisions: Dict[str,bool], mean_combined: Dict[str,float],
               piano_strength: Tuple[float,float]) -> Dict[str,bool]:
    """
    Enforce conservative rules for Brass (section).
    """
    family = decisions.get("trumpet",False) or decisions.get("trombone",False) or decisions.get("saxophone",False)
    brass_generic = float(mean_combined.get("brass", 0.0))
    piano_mean, piano_ratio = piano_strength

    # Require family or strong generic brass
    if not family and brass_generic < BRASS_GENERIC_GATE:
        decisions["brass"] = False

    # Piano veto
    if decisions.get("brass", False) and (not family) and (brass_generic < BRASS_GENERIC_PIANO_VETO):
        if (piano_mean >= PIANO_STRONG_MEAN) or (piano_ratio >= PIANO_STRONG_RATIO):
            decisions["brass"] = False

    return decisions

def combine_means(m1: Dict[str,float], m2: Dict[str,float]) -> Dict[str,float]:
    return {k: (float(m1.get(k,0.0)) + float(m2.get(k,0.0))) / 2.0 for k in TARGETS.keys()}

# ---------- helpers for safe access & horn logic ----------
def _stem_means_sums(by_stem: Dict[str, Any], label: str) -> Tuple[float, float]:
    """
    Returns (sum_mean_across_stems, max_mean_any_stem) for a given instrument label,
    combining PANNs and YAMNet means in a simple additive way.
    Structure expected (as already produced by the analyzer):
       by_stem[stem][Label]["panns"|"yamnet"]["mean"]
    Missing keys are treated as 0.0.
    """
    total = 0.0
    max_mean = 0.0
    for stem in ("drums", "bass", "other", "vocals", "mix"):
        s = by_stem.get(stem, {})
        d = s.get(label, {})
        p_mean = float(d.get("panns", {}).get("mean", 0.0))
        y_mean = float(d.get("yamnet", {}).get("mean", 0.0))
        m = p_mean + y_mean
        total += m
        if m > max_mean:
            max_mean = m
    return total, max_mean


def _apply_orchestral_horn_boost(scores_by_stem: Dict[str, Any], rules: Dict[str, Any]) -> Tuple[Set[str], Dict[str, Any]]:
    """
    Stem-aware horn promotion. Fired when the *combined* horn energy across stems is clearly present,
    even if window-level thresholds are not met.
    - Promotes Trumpet/Trombone individually when 'other' or 'mix' stem means exceed calibrated mins.
    - Optionally adds Brass (section) when both are near-threshold together.
    Returns (add_set, trace_dict).
    """
    add: Set[str] = set()
    trace: Dict[str, Any] = {"applied": False, "why": "", "values": {}}

    # Sum across stems for both horns (robust for orchestra passages mixed under vocals/drums)
    tr_sum, tr_max = _stem_means_sums(scores_by_stem, "Trumpet")
    tb_sum, tb_max = _stem_means_sums(scores_by_stem, "Trombone")
    horns_sum = tr_sum + tb_sum

    # Per-stem cues where horns usually sit after Demucs (mostly "other" and sometimes "mix")
    tr_other = _stem_mean(scores_by_stem, "other", "Trumpet")
    tb_other = _stem_mean(scores_by_stem, "other", "Trombone")
    tr_mix   = _stem_mean(scores_by_stem, "mix",   "Trumpet")
    tb_mix   = _stem_mean(scores_by_stem, "mix",   "Trombone")

    trace["values"] = {
        "tr_sum": round(tr_sum, 6), "tb_sum": round(tb_sum, 6),
        "horns_sum": round(horns_sum, 6),
        "tr_other": round(tr_other, 6), "tb_other": round(tb_other, 6),
        "tr_mix": round(tr_mix, 6), "tb_mix": round(tb_mix, 6),
    }

    if horns_sum >= rules["orchestral_horn_sum_mean_min"]:
        # Individual promotions if the instrument is clearly in 'other' (primary horn stem) or present in 'mix'
        if tr_other >= rules["orchestral_trumpet_other_mean_min"] or tr_mix >= rules["orchestral_horn_mix_mean_min"]:
            add.add("Trumpet")
        if tb_other >= rules["orchestral_trombone_other_mean_min"] or tb_mix >= rules["orchestral_horn_mix_mean_min"]:
            add.add("Trombone")

        # Section label when two are close together, to help search facets if both present
        if rules.get("orchestral_allow_section_if_two_close", True) and {"Trumpet", "Trombone"} <= add:
            add.add("Brass (section)")

    if add:
        trace["applied"] = True
        trace["why"] = "orchestral_horn_boost"
    else:
        trace["applied"] = False
        trace["why"] = "no horn thresholds met"
    return add, trace

def _apply_orchestral_horn_boost_v2(by_stem: dict, instruments: list[str], trace: dict) -> None:
    """
    Stem-aware French Horn detection + section promotion using any two horns.
    Runs only when Demucs stems are available. Keeps conservative thresholds.
    """
    try:
        if not isinstance(by_stem, dict) or ("mix" not in by_stem or "other" not in by_stem):
            return

        R = RULES["orchestral_horn_boost_v2"]

        # Fixed horn keys we already use
        TPT = "Trumpet"
        TBN = "Trombone"

        # Resolve the actual label key used for French Horn by the ensemble
        FRHN = _resolve_french_horn_key(by_stem)  # may be None if model doesn't expose horn explicitly

        # Gather MIX+OTHER means (PANNs+YAMNet combined mean already computed by _stem_mean)
        tpt_mix = _stem_mean(by_stem, "mix", TPT) or 0.0
        tpt_oth  = _stem_mean(by_stem, "other", TPT) or 0.0
        tbn_mix = _stem_mean(by_stem, "mix", TBN) or 0.0
        tbn_oth  = _stem_mean(by_stem, "other", TBN) or 0.0

        frhn_mix = 0.0
        frhn_oth = 0.0
        if FRHN:
            frhn_mix = _stem_mean(by_stem, "mix", FRHN) or 0.0
            frhn_oth = _stem_mean(by_stem, "other", FRHN) or 0.0

        # Sum of MIX+OTHER across the horns we have
        sum3 = (tpt_mix + tpt_oth) + (tbn_mix + tbn_oth) + (frhn_mix + frhn_oth)

        # Decide French Horn
        frhn_pass = False
        if FRHN:
            if (frhn_mix >= R["FRHN_MIN_MIX"]) and (frhn_oth >= R["FRHN_MIN_OTHER"]) and (sum3 >= R["SUM3_MIN"]):
                frhn_pass = True
                if "French Horn" not in instruments:
                    instruments.append("French Horn")

        # Section promotion: ensure "Brass (section)" when any 2 horns are present
        horn_present = set()
        if TPT in instruments: horn_present.add("TPT")
        if TBN in instruments: horn_present.add("TBN")
        if frhn_pass or (FRHN and FRHN in instruments): horn_present.add("FRHN")

        if len(horn_present) >= R["SECTION_MIN_COUNT"] and "Brass (section)" not in instruments:
            instruments.append("Brass (section)")

        # Trace
        rules = trace.setdefault("rules", [])
        rules.append({
            "rule": "orchestral_horn_boost_v2",
            "why": {
                "sum_means_mix+other": round(sum3, 6),
                "mix": {
                    "Trumpet": round(tpt_mix, 6),
                    "Trombone": round(tbn_mix, 6),
                    "FrenchHorn": round(frhn_mix, 6),
                },
                "other": {
                    "Trumpet": round(tpt_oth, 6),
                    "Trombone": round(tbn_oth, 6),
                    "FrenchHorn": round(frhn_oth, 6),
                },
                "thresholds": {
                    "SUM3_MIN": R["SUM3_MIN"],
                    "FRHN_MIN_MIX": R["FRHN_MIN_MIX"],
                    "FRHN_MIN_OTHER": R["FRHN_MIN_OTHER"],
                    "SECTION_MIN_COUNT": R["SECTION_MIN_COUNT"],
                },
                "frhn_key": FRHN or None,
            }
        })

    except Exception as e:
        # Never break main analysis
        rules = trace.setdefault("rules", [])
        rules.append({
            "rule": "orchestral_horn_boost_v2",
            "error": str(e),
        })
        return

def _apply_strings_section_boost_v1(by_stem: dict, instruments: list[str], trace: dict) -> None:
    """
    Stem-aware detection for orchestral strings with conservative thresholds.
    Adds individual instruments {Violin, Viola, Cello, Double Bass, Harp} when present,
    and promotes 'Strings (section)' when multiple strings agree or the generic 'Strings'
    label is strong. No-ops without Demucs stems.
    """
    try:
        if not isinstance(by_stem, dict) or ("mix" not in by_stem or "other" not in by_stem):
            return

        R = RULES["strings_section_boost_v1"]

        # Candidate labels across PANNs / YAMNet
        CANDS = {
            "StringsGeneric": [
                "Strings", "String section", "Orchestral strings", "strings", "string_section"
            ],
            "Violin": ["Violin", "violin", "Fiddle", "fiddle"],
            "Viola": ["Viola", "viola"],
            "Cello": ["Cello", "Violoncello", "cello"],
            "Double Bass": ["Double bass", "Contrabass", "Upright bass", "double_bass", "contrabass", "upright_bass"],
            "Harp": ["Harp", "harp"],
        }

        # Resolve actual keys used by current models
        keys = {name: _resolve_key_for(by_stem, cands) for name, cands in CANDS.items()}

        # Helper to read combined mean for a given stem/key
        def sm(stem: str, key_name: str) -> float:
            k = keys.get(key_name)
            return float(_stem_mean(by_stem, stem, k)) if k else 0.0

        # MIX + OTHER means for each instrument
        per_inst = {}
        inst_names = ["Violin", "Viola", "Cello", "Double Bass", "Harp"]
        for n in inst_names:
            m = sm("mix", n)
            o = sm("other", n)
            per_inst[n] = {"mix": m, "other": o, "sum": m + o}

        # Generic "Strings"
        gen_mix = sm("mix", "StringsGeneric")
        gen_oth = sm("other", "StringsGeneric")
        gen_sum = gen_mix + gen_oth

        # Total sum across all strings (including generic)
        sum_all = gen_sum + sum(v["sum"] for v in per_inst.values())

        # Decide individuals
        added = []
        for n in inst_names:
            v = per_inst[n]
            if (
                v["mix"] >= R["INST_MIN_MIX"]
                and v["other"] >= R["INST_MIN_OTHER"]
                and sum_all >= R["SUM_ALL_MIN"]
            ):
                if n not in instruments:
                    instruments.append(n)
                added.append(n)

        # Section promotion logic
        section_ok = False
        # Case A: >= 2 individual strings detected
        if len(added) >= R["SECTION_MIN_COUNT"]:
            section_ok = True
        # Case B: strong generic + >=1 individual
        elif (
            gen_mix >= R["GEN_MIN_MIX"]
            and gen_oth >= R["GEN_MIN_OTHER"]
            and sum_all >= R["SUM_ALL_MIN"]
            and len(added) >= 1
        ):
            section_ok = True
        # Case C: generic only, very strong
        elif (
            gen_mix >= R["GEN_MIN_MIX"]
            and gen_oth >= R["GEN_MIN_OTHER"]
            and sum_all >= R["GEN_ONLY_SUM_MIN"]
        ):
            section_ok = True

        if section_ok and "Strings (section)" not in instruments:
            instruments.append("Strings (section)")

        # Trace
        rules = trace.setdefault("rules", [])
        rules.append({
            "rule": "strings_section_boost_v1",
            "why": {
                "sum_all_mix+other": round(sum_all, 6),
                "generic": {
                    "mix": round(gen_mix, 6),
                    "other": round(gen_oth, 6),
                    "sum": round(gen_sum, 6),
                    "key": keys.get("StringsGeneric"),
                },
                "per_instrument": {
                    n: {
                        "mix": round(per_inst[n]["mix"], 6),
                        "other": round(per_inst[n]["other"], 6),
                        "sum": round(per_inst[n]["sum"], 6),
                        "key": keys.get(n),
                    } for n in inst_names
                },
                "added": added,
                "thresholds": {
                    "SUM_ALL_MIN": R["SUM_ALL_MIN"],
                    "INST_MIN_MIX": R["INST_MIN_MIX"],
                    "INST_MIN_OTHER": R["INST_MIN_OTHER"],
                    "GEN_MIN_MIX": R["GEN_MIN_MIX"],
                    "GEN_MIN_OTHER": R["GEN_MIN_OTHER"],
                    "GEN_ONLY_SUM_MIN": R["GEN_ONLY_SUM_MIN"],
                    "SECTION_MIN_COUNT": R["SECTION_MIN_COUNT"],
                }
            }
        })

    except Exception as e:
        rules = trace.setdefault("rules", [])
        rules.append({
            "rule": "strings_section_boost_v1",
            "error": str(e),
        })
        return

def _load_stereo_44100(audio_path: str, target_sr: int = 44100, device: str = "cpu"):
    """
    Returns a torch.Tensor shaped [1, 2, T], float32 in [-1, 1], resampled to 44.1k.
    Prefers torchaudio; falls back to librosa if needed.
    """
    w = None
    sr = None

    # First try torchaudio (usually already installed for Demucs envs)
    if torchaudio is not None:
        try:
            wav, sr = torchaudio.load(audio_path)  # float32 [-1,1] by default
            # Resample if needed
            if sr != target_sr:
                wav = AF.resample(wav, orig_freq=sr, new_freq=target_sr)
                sr = target_sr
            # Channel fix: make stereo (2ch)
            if wav.shape[0] == 1:
                wav = wav.repeat(2, 1)
            elif wav.shape[0] > 2:
                wav = wav[:2, :]
            w = wav
        except Exception:
            w = None

    # Fallback to librosa if torchaudio failed/unavailable
    if w is None:
        import librosa
        y, sr = librosa.load(audio_path, sr=target_sr, mono=False)
        if y.ndim == 1:
            y = np.stack([y, y], axis=0)  # mono -> stereo
        elif y.shape[0] > 2:
            y = y[:2, :]
        w = torch.from_numpy(y.astype(np.float32))

    # Shape to [1,2,T] and move to device
    if w.dim() == 1:
        w = w.unsqueeze(0).repeat(2, 1)
    w = w.unsqueeze(0).to(device)  # [1,2,T]
    return w, sr

def _first_present_key(d: dict, candidates: list[str]) -> str | None:
    for k in candidates:
        if k in d:
            return k
    return None

def _resolve_french_horn_key(by_stem: dict) -> str | None:
    """
    Try to find the instrument key used by the models for French Horn.
    Handles common variants across model label sets (PANNs/YAMNet).
    """
    candidates = ["French Horn", "French horn", "Horn", "Horn (instrument)", "french_horn", "horn"]
    for stem in ("other", "mix", "bass", "drums", "vocals"):
        insts = by_stem.get(stem) or {}
        key = _first_present_key(insts, candidates)
        if key:
            return key
    return None

def _resolve_key_for(by_stem: dict, candidates: list[str]) -> str | None:
    """
    Returns the first instrument label key present in any stem from `candidates`.
    """
    for stem in ("other", "mix", "bass", "drums", "vocals"):
        insts = by_stem.get(stem) or {}
        for c in candidates:
            if c in insts:
                return c
    return None

def _load_htsat(device):
    """
    Best-effort loader for an HTS-AT AudioSet model.
    Returns (model, classnames) or (None, None) if unavailable.
    * Never raises — all failures degrade gracefully.
    """
    global _HTSAT_MODEL, _HTSAT_CLASSNAMES, _HTSAT_READY
    if _HTSAT_READY:
        return _HTSAT_MODEL, _HTSAT_CLASSNAMES
    try:
        # HTS-AT relies on timm/torchlibrosa; we avoid hard deps here.
        # We try hub first; if that fails, we skip HTS-AT silently.
        import torch.hub as _hub
        model = _hub.load(
            'qiuqiangkong/audioset_tagging_cnn',
            'htsat',
            pretrained=True,
            source='github'
        )
        model.to(device)
        model.eval()
        # Try to discover class names on the model; if not present, fall back to AudioSet names inside the package.
        classes = getattr(model, 'classes', None)
        if classes is None:
            try:
                # AudioSet label csv is shipped in that repo as utils/class_labels_indices.csv
                from audioset_tagging_cnn.utils import audioset_classes
                classes = audioset_classes()
            except Exception:
                classes = []
        _HTSAT_MODEL = model
        _HTSAT_CLASSNAMES = [str(c).lower() for c in classes] if classes else []
        _HTSAT_READY = True
    except Exception as e:
        # Don't spam logs; just mark unavailable.
        _HTSAT_MODEL, _HTSAT_CLASSNAMES = None, None
        _HTSAT_READY = False
    return _HTSAT_MODEL, _HTSAT_CLASSNAMES

def _infer_htsat_clipwise(wav_t, sr, device):
    """
    Returns dict(label -> float) of HTS-AT clipwise scores over the full mix.
    If HTS-AT is unavailable, returns {}.
    """
    if not _HAS_TORCHAUDIO:
        return {}
    model, classes = _load_htsat(device)
    if not model or not classes:
        return {}
    try:
        # HTS-AT models are trained around 32 kHz AudioSet features; resample if needed.
        target_sr = 32000
        if sr != target_sr:
            wav_t = torchaudio.functional.resample(wav_t, sr, target_sr)
            sr = target_sr
        # Model expects [B, T] or [B, C, T]; handle mono/stereo robustly.
        if wav_t.dim() == 2 and wav_t.size(0) == 2:      # [C, T]
            x = wav_t.mean(dim=0, keepdim=True)          # mono sum
        elif wav_t.dim() == 1:                           # [T]
            x = wav_t.unsqueeze(0)
        else:
            x = wav_t
        x = x.to(device)
        with torch.inference_mode():
            out = model(x)  # model returns clipwise logits or probs depending on wrapper
            # Try common attributes; fall back to sigmoid if logits.
            if isinstance(out, dict):
                clip = out.get('clipwise_output', None)
                if clip is None:
                    clip = out.get('framewise_output', None)
                    if clip is not None:
                        clip = clip.mean(dim=1)
            else:
                clip = out
            if clip is None:
                return {}
            if clip.dim() > 2:
                clip = clip.mean(dim=1)
            clip = clip.squeeze(0)
            # If logits, apply sigmoid
            if clip.min() < 0 or clip.max() > 1:
                clip = torch.sigmoid(clip)
            clip = clip.detach().cpu().float().tolist()
        scores = {}
        for i, name in enumerate(classes):
            scores[name] = float(clip[i]) if i < len(clip) else 0.0
        return scores
    except Exception:
        return {}

def _robust_family_rollup_v1(instruments, decision_trace):
    """
    Robust family rollup specifically for woodwinds in mix-only mode.
    Very forgiving thresholds, mean-only, requires orchestral context.
    """
    try:
        per_model = decision_trace.get("per_model", {})
        
        # Woodwind family keys
        fam_keys = ["flute", "clarinet", "oboe", "bassoon"]
        
        # Get combined means for each woodwind
        means = []
        for key in fam_keys:
            try:
                mean = _combined_mean(decision_trace, key)
            except Exception as e:
                _log.debug("booster _combined_mean failed for %s: %s", key, e)
                mean = 0.0
            means.append(mean)
        
        # Calculate aggregate mean
        agg_mean = sum(means) / len(fam_keys) if means else 0.0
        
        # Check for orchestral context
        context_present = ("Strings (section)" in instruments or 
                          "Brass (section)" in instruments)
        
        # Very forgiving thresholds for mix-only
        rollup_cfg = {
            "agg_mean": 0.0004,
            "context_gate": 0.0,
            "require_context": True
        }
        
        # Decision logic
        should_add = (context_present and agg_mean >= rollup_cfg["agg_mean"])
        
        if should_add and "Woodwinds (section)" not in instruments:
            instruments.append("Woodwinds (section)")
            added = ["Woodwinds (section)"]
        else:
            added = []
        
        # Record in trace
        decision_trace.setdefault("boosts", {})["family_rollup_v1"] = {
            "thresholds": rollup_cfg,
            "agg_mean": round(agg_mean, 6),
            "context_present": context_present,
            "added": added,
            "woodwind_means": {key: round(mean, 6) for key, mean in zip(fam_keys, means)}
        }
        
    except Exception as e:
        # Never break pipeline
        decision_trace.setdefault("warnings", []).append(f"robust_family_rollup_v1_warn: {type(e).__name__}: {e}")

def _apply_soft_drums_rescue_v1(instruments, trace):
    """Soft drums rescue v1 - improve recall for brush kits with intermittent positives."""
    try:
        per_model = trace.get("per_model", {})
        panns = per_model.get("panns", {})
        yamnet = per_model.get("yamnet", {})
        
        panns_mean = panns.get("mean_probs", {}).get("drum_kit", 0.0)
        panns_pos = panns.get("pos_ratio", {}).get("drum_kit", 0.0)
        yamnet_pos = yamnet.get("pos_ratio", {}).get("drum_kit", 0.0)
        
        # Check if drum kit should be rescued
        rescue_condition1 = (panns_mean >= 0.0032 and yamnet_pos >= 0.018)
        rescue_condition2 = (panns_pos >= 0.035)
        
        if (rescue_condition1 or rescue_condition2) and "Drum Kit (acoustic)" not in instruments:
            instruments.append("Drum Kit (acoustic)")
            
            # Log the rescue decision
            trace.setdefault("boosts", {})["soft_drums_rescue_v1"] = {
                "booster": "soft_drums_rescue_v1",
                "conditions": {
                    "panns_mean": panns_mean,
                    "panns_pos": panns_pos,
                    "yamnet_pos": yamnet_pos,
                    "condition1": rescue_condition1,
                    "condition2": rescue_condition2
                },
                "added": ["Drum Kit (acoustic)"]
            }
            
    except Exception as e:
        trace.setdefault("errors", []).append(f"soft_drums_rescue_v1: {type(e).__name__}: {e}")

def _apply_woodwinds_section_any_v1(instruments, trace):
    """Woodwinds section any v1 - add section label based on any woodwind evidence."""
    try:
        per_model = trace.get("per_model", {})
        panns = per_model.get("panns", {})
        yamnet = per_model.get("yamnet", {})
        
        # Compute woodwinds score mean (max of flute, clarinet, saxophone)
        ww_keys = ["flute", "clarinet", "saxophone"]
        ww_score_mean = max(
            panns.get("mean_probs", {}).get(key, 0.0) for key in ww_keys
        )
        
        # Compute woodwinds pos (max across all models and keys)
        ww_pos = max(
            max(panns.get("pos_ratio", {}).get(key, 0.0) for key in ww_keys),
            max(yamnet.get("pos_ratio", {}).get(key, 0.0) for key in ww_keys)
        )
        
        # Add woodwinds section if conditions met
        if (ww_score_mean >= 0.0015 or ww_pos >= 0.008) and "Woodwinds (section)" not in instruments:
            instruments.append("Woodwinds (section)")
            
            # Log the decision
            trace.setdefault("boosts", {})["woodwinds_section_any_v1"] = {
                "booster": "woodwinds_section_any_v1",
                "evidence": {
                    "ww_score_mean": ww_score_mean,
                    "ww_pos": ww_pos,
                    "individual_means": {key: panns.get("mean_probs", {}).get(key, 0.0) for key in ww_keys},
                    "individual_pos": {key: panns.get("pos_ratio", {}).get(key, 0.0) for key in ww_keys}
                },
                "added": ["Woodwinds (section)"]
            }
            
    except Exception as e:
        trace.setdefault("errors", []).append(f"woodwinds_section_any_v1: {type(e).__name__}: {e}")

def _apply_strings_pad_guard_v1(instruments, trace):
    """Strings pad guard v1 - demote synth string pads in 80s/early-90s productions."""
    try:
        per_model = trace.get("per_model", {})
        panns = per_model.get("panns", {})
        yamnet = per_model.get("yamnet", {})
        
        # Check if strings section is present
        if "Strings (section)" in instruments:
            strings_pos = panns.get("pos_ratio", {}).get("strings", 0.0)
            
            # Check individual string instruments
            string_keys = ["violin", "cello", "viola", "double_bass"]
            max_individual_pos = max(
                max(panns.get("pos_ratio", {}).get(key, 0.0) for key in string_keys),
                max(yamnet.get("pos_ratio", {}).get(key, 0.0) for key in string_keys)
            )
            
            # Check for keyboard presence
            keyboard_present = any(
                key in instruments for key in ["Organ", "Piano", "Synthesizer", "Keyboard"]
            )
            
            # Demote if conditions met
            # v1.1.0: widen pad guard to catch synth-pad cases with tiny per-string evidence
            if (strings_pos < 0.025 and 
                max_individual_pos < 0.012 and 
                keyboard_present):
                
                instruments.remove("Strings (section)")
                
                # Log the demotion
                trace.setdefault("boosts", {})["strings_pad_guard_v1"] = {
                    "booster": "strings_pad_guard_v1",
                    "conditions": {
                        "strings_pos": strings_pos,
                        "max_individual_pos": max_individual_pos,
                        "keyboard_present": keyboard_present,
                        "individual_pos": {key: panns.get("pos_ratio", {}).get(key, 0.0) for key in string_keys}
                    },
                    "removed": ["Strings (section)"]
                }
                
    except Exception as e:
        trace.setdefault("errors", []).append(f"strings_pad_guard_v1: {type(e).__name__}: {e}")

def analyze(audio_path: str, use_demucs: bool = True, diag: bool = False) -> Dict[str, Any]:
    """
    Returns dict with:
      - instruments: List[str]
      - scores: Dict[str, Dict[str,float]]
      - decision_trace: Dict[str, Any]
      - used_demucs: bool
    """
    wav, sr = load_audio_mono(audio_path)
    global GLOBAL_SR
    GLOBAL_SR = sr

    # Instantiate models once
    panns = PANNsAT(device="cpu")
    yamnet = hub.load("https://tfhub.dev/google/yamnet/1")

    # --- mixture analysis
    per_win, nwin = run_models_over_windows(wav, panns, yamnet, ModelMaps(
        panns=build_label_maps_panns(panns),
        yamnet=build_label_maps_yamnet(yamnet),
    ))
    p_mean, p_ratio = summarize_model_windows(per_win["panns"], "panns")
    y_mean, y_ratio = summarize_model_windows(per_win["yamnet"], "yamnet")
    decisions = decide_track(p_mean, p_ratio, y_mean, y_ratio)
    mean_combined = combine_means(p_mean, y_mean)

    # --- optional: Demucs 'other' stem to refine piano evidence only
    used_demucs = False
    stem_aware = False
    piano_mean_other = 0.0
    piano_ratio_other = 0.0
    decision_trace = {}  # Initialize decision trace early
    if use_demucs:
        stem_aware = True
        try:
            import torch, torchaudio
            device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
            model = demucs_get_model("htdemucs").to(device)
            # Load audio as stereo 44.1k for Demucs
            wav_t, sr = _load_stereo_44100(audio_path, target_sr=44100, device=device)
            # wav_t is guaranteed [1,2,T] float32 on the correct device
            
            # Enforce stereo input before Demucs
            if wav_t.ndim == 2:
                # [C, T] -> [1, C, T]
                wav_t = wav_t.unsqueeze(0)
            if wav_t.shape[1] == 1:
                # duplicate mono -> stereo
                wav_t = wav_t.repeat(1, 2, 1)
            
            with torch.inference_mode():
                est = demucs_apply(model, wav_t, device=device, shifts=1, overlap=0.25, progress=False)[0]  # [S,C,T]
            
            # Record that Demucs actually ran
            decision_trace["demucs_input_shape"] = list(wav_t.shape)
            decision_trace["demucs_sr"] = int(sr)
            
            # ----- Build stem map (as numpy float32, mono mixdown per stem) -----
            def _to_np_mono(tensor):
                # tensor shape [C, T] (channels, time) -> np.float32 mono
                x = tensor.detach().cpu().numpy().astype("float32")
                if x.ndim == 2 and x.shape[0] == 2:
                    return (0.5 * (x[0] + x[1])).astype("float32")
                elif x.ndim == 2 and x.shape[0] == 1:
                    return x[0].astype("float32")
                else:
                    # unexpected, fall back to first channel
                    return x[0].astype("float32")

            # htdemucs naming: 0=drums, 1=bass, 2=other, 3=vocals
            stems = {
                "drums":  _to_np_mono(est[0]),
                "bass":   _to_np_mono(est[1]),
                "other":  _to_np_mono(est[2]),
                "vocals": _to_np_mono(est[3]),
                "mix":    wav,  # original mono mix you already computed earlier
            }

            # Classify each stem with existing scorer
            per_stem = {}
            for stem_name, wav_mono in stems.items():
                per_stem[stem_name] = _classify_waveform_for_targets(
                    wav_mono, sr, panns, yamnet, TARGET_INSTRUMENTS
                )

            # Normalize by_stem structure to ensure dict values only
            per_stem = _normalize_by_stem(per_stem)
            
            # Optional: trace the shapes to aid debugging (non-fatal)
            decision_trace.setdefault("shapes", {})["by_stem_types"] = {
                k: type(v).__name__ for k, v in per_stem.items()
            }

            # Combine with priors into final per-instrument scores
            combined = {}
            for inst in TARGET_INSTRUMENTS:
                wsum_mean = 0.0
                wsum_pos  = 0.0
                wtot      = 0.0
                priors = STEM_PRIORS.get(inst, {})
                for stem_name, scores in per_stem.items():
                    w = priors.get(stem_name, 0.2)  # small weight for non-listed stems
                    s = scores[inst]
                    wsum_mean += w * s["mean"]
                    wsum_pos  += w * s["pos_ratio"]
                    wtot      += w
                mean_c = (wsum_mean / max(wtot, 1e-6))
                pos_c  = (wsum_pos  / max(wtot, 1e-6))
                # keep also the best single-model max across stems to allow SINGLE_HIGH acceptance
                best_max = 0.0
                for stem_name, scores in per_stem.items():
                    best_max = max(best_max, scores[inst].get("max", 0.0))
                combined[inst] = {"mean": float(mean_c), "pos_ratio": float(pos_c), "max": float(best_max)}

            # --- HTS-AT (optional) fusion ----------------------------------------
            # Convert numpy array to torch tensor for HTS-AT
            import torch
            wav_t = torch.from_numpy(wav).float()
            device = torch.device("cpu")  # Use CPU for now
            
            htsat_scores = _infer_htsat_clipwise(wav_t, sr, device)

            # Map HTS-AT labels to our canonical instruments.
            # NOTE: we only "add" confidence; we never override an existing score downward.
            def _get(name_list):
                for k in name_list:
                    v = htsat_scores.get(k, 0.0)
                    if v > 0:
                        return v
                return 0.0

            # Coarse-to-fine label bundles found in AudioSet:
            # --- Brass family
            hts_trumpet    = max(_get(['trumpet']), _get(['cornet']))
            hts_trombone   = _get(['trombone'])
            hts_sax        = max(_get(['saxophone', 'alto saxophone', 'tenor saxophone']))
            hts_fhorn      = _get(['french horn'])
            hts_tuba       = _get(['tuba'])
            hts_brass_any  = max(_get(['brass instrument','orchestra brass']), hts_trumpet, hts_trombone, hts_fhorn, hts_tuba, hts_sax)

            # --- Strings family
            hts_violin     = _get(['violin'])
            hts_viola      = _get(['viola'])
            hts_cello      = _get(['cello'])
            hts_dbass      = max(_get(['double bass','contrabass','upright bass']))
            hts_strings_any= max(_get(['string section','orchestra strings','orchestra']), hts_violin, hts_viola, hts_cello, hts_dbass)

            # --- Choir (Beatles/Beach Boys often use vocal ensembles)
            hts_choir      = max(_get(['choir','chorus','vocal ensemble','vocal choir']))

            # Lightly boost our combined means if HTS-AT agrees (bounded to avoid FP explosions).
            # These multipliers are intentionally small and applied only for brass-family classes.
            def _boost(v, add):
                if add <= 0.0:
                    return v
                # Convert HTS score to a gentle additive bump.
                bump = min(0.12, 0.35 * add)  # cap bump at 0.12
                return v + bump

            if 'Trumpet' in combined:
                combined['Trumpet']['mean'] = _boost(combined['Trumpet']['mean'], hts_trumpet)
                combined['Trumpet']['max']  = max(combined['Trumpet']['max'], hts_trumpet)
            if 'Trombone' in combined:
                combined['Trombone']['mean'] = _boost(combined['Trombone']['mean'], hts_trombone)
                combined['Trombone']['max']  = max(combined['Trombone']['max'], hts_trombone)
            if 'Saxophone' in combined:
                combined['Saxophone']['mean'] = _boost(combined['Saxophone']['mean'], hts_sax)
                combined['Saxophone']['max']  = max(combined['Saxophone']['max'], hts_sax)

            # Strings family light boost (only nudges means; keeps system conservative)
            for _name, _v in [('Violin', hts_violin), ('Viola', hts_viola), ('Cello', hts_cello), ('Double Bass', hts_dbass)]:
                if _name in combined:
                    combined[_name]['mean'] = _boost(combined[_name]['mean'], _v)
                    combined[_name]['max']  = max(combined[_name]['max'], _v)

            # Expose optional telemetry (no effect on detections unless meta gates below fire)
            instrument_scores['Choir'] = round(float(hts_choir), 4)
            
            # Store HTS-AT variables for later use
            htsat_vars = {
                'hts_trumpet': hts_trumpet,
                'hts_trombone': hts_trombone,
                'hts_sax': hts_sax,
                'hts_fhorn': hts_fhorn,
                'hts_tuba': hts_tuba,
                'hts_brass_any': hts_brass_any,
                'hts_violin': hts_violin,
                'hts_viola': hts_viola,
                'hts_cello': hts_cello,
                'hts_dbass': hts_dbass,
                'hts_strings_any': hts_strings_any,
                'hts_choir': hts_choir
            }

            # Decision using stem-aware thresholds
            accepted = []
            decision_trace = {}
            for inst in TARGET_INSTRUMENTS:
                th = STEM_THRESHOLDS.get(inst, {"MEAN": 0.06, "POS": 0.12, "SINGLE_HIGH": 0.22})
                c  = combined[inst]
                ok = False

                # rule 1: single model very confident anywhere
                if c["max"] >= th["SINGLE_HIGH"]:
                    ok = True
                    reason = f"max>={th['SINGLE_HIGH']}"
                # rule 2: weighted mean + ratio over stem priors
                elif (c["mean"] >= th["MEAN"] and c["pos_ratio"] >= th["POS"]):
                    ok = True
                    reason = f"mean>={th['MEAN']} & pos>={th['POS']}"
                else:
                    reason = f"below ({c['mean']:.3f},{c['pos_ratio']:.3f},{c['max']:.3f})"

                decision_trace[inst] = {"accepted": ok, "scores": c, "thresholds": th, "why": reason}
                if ok:
                    accepted.append(inst)
            
            # --- HORN BOOST (Demucs-aware) ---
            if stem_aware and ('other' in per_stem):
                horn_specs = {
                    "Trumpet":  {"MEAN": 0.016, "POS": 0.03, "SINGLE_HIGH": 0.028},
                    "Trombone": {"MEAN": 0.015, "POS": 0.03, "SINGLE_HIGH": 0.027},
                    "Saxophone":{"MEAN": 0.009, "POS": 0.02, "SINGLE_HIGH": 0.018},
                }
                for inst, th in horn_specs.items():
                    # Skip if already accepted
                    if decision_trace.get(inst, {}).get("accepted"):
                        continue

                    # Pull "other" stem summary (already computed alongside panns/yamnet)
                    s_other = per_stem.get("other", {}).get(inst, {})
                    other_mean = float(s_other.get("mean", 0.0) or 0.0)
                    other_max  = float(s_other.get("max", 0.0) or 0.0)

                    # Require tangible energy in the non-vocal, non-bass stem
                    if other_mean >= 0.020 and other_max >= 0.020:
                        sc = combined.get(inst, {})
                        c_mean = float(sc.get("mean", 0.0) or 0.0)
                        c_pos  = float(sc.get("pos_ratio", 0.0) or 0.0)
                        c_max  = float(sc.get("max", 0.0) or 0.0)

                        # Re-check against the calibrated horn thresholds
                        passes = (c_mean >= th["MEAN"] and c_pos >= th["POS"]) or (c_max >= th["SINGLE_HIGH"])
                        if passes:
                            # Mark accepted and annotate the reason
                            if inst not in accepted:
                                accepted.append(inst)
                            if inst not in decision_trace:
                                decision_trace[inst] = {}
                            decision_trace[inst]["accepted"] = True
                            decision_trace[inst]["why"] = (
                                f"horn-boost: other stem strong (mean={other_mean:.3f}, max={other_max:.3f})"
                            )
            # --- end HORN BOOST ---
            
            used_demucs = True
        except Exception as e:
            # Graceful fallback: no stems, keep analyzing the full mix.
            stem_aware = False
            print(f"[ENSEMBLE][WARN] Demucs failed ({type(e).__name__}: {e}). Falling back to mix-only.", flush=True)
            
            # Ensure by_stem is always a dict even when Demucs fails
            decision_trace.setdefault("warnings", []).append({"demucs": str(e)})
            per_stem = _normalize_by_stem({"mix": {}})  # ensure dict under "mix"

    # Use stem-aware results if Demucs was successful, otherwise fall back to mix-only
    if used_demucs and 'accepted' in locals():
        # Use stem-aware results
        instruments = accepted
        
        # Initialize instrument_scores for meta rules
        instrument_scores = {}
        
        # ------------------------------------------------------------------
        # Horns (Trumpet/Trombone) promotion rule (Demucs-aware, conservative)
        # ------------------------------------------------------------------
        # Why: PANNs/YAMNet often under-score orchestral brass unless you catch brief
        # peaks. We allow promotion when any Demucs stem shows a strong local max OR
        # a modest mean with some recurrence. No reliance on LLM/creative fields.
        #
        # Gates:
        # - Only runs when Demucs is enabled (use_demucs == True).
        # - Does NOT run if "Piano veto" for BRASS (section) fired (we keep that for
        #   the generic "Brass (section)" label only; individual horns get their own test).
        #
        # Thresholds are intentionally low but multi-criteria to avoid false positives:
        #   HORN_SINGLE_MAX   : accept if any stem has panns.max >= 0.035  OR yamnet.max >= 0.050
        #   HORN_MEAN_MIN     : accept if any stem has panns.mean >= 0.020 AND panns.pos_ratio >= 0.05
        #   MIX_SAFETY        : alternatively, mix stem panns.mean >= 0.015 AND pos_ratio >= 0.08
        # If either trumpet OR trombone meets the rule, we add that specific instrument.
        #
        HORN_SINGLE_MAX_PANNS = 0.035
        HORN_SINGLE_MAX_YAM   = 0.050
        HORN_MEAN_MIN         = 0.020
        HORN_POS_RATIO_MIN    = 0.05
        MIX_MEAN_MIN          = 0.015
        MIX_POS_RATIO_MIN     = 0.08

        def _horn_hit(label: str) -> bool:
            """
            Return True if `label` (e.g., 'Trumpet' or 'Trombone') satisfies any of the horn criteria
            on any stem or on the mix. Uses values already computed into `by_stem`.
            Safe on missing keys.
            """
            try:
                stems = by_stem or {}
            except NameError:
                stems = {}

            # Check each available stem
            for stem_name, stem_dict in stems.items():
                ldict = stem_dict.get(label, {})
                panns = ldict.get("panns", {})
                yam   = ldict.get("yamnet", {})
                p_mean = float(panns.get("mean", 0.0) or 0.0)
                p_pos  = float(panns.get("pos_ratio", 0.0) or 0.0)
                p_max  = float(panns.get("max", 0.0) or 0.0)
                y_max  = float(yam.get("max", 0.0) or 0.0)

                # Criterion A: single strong local hit on any stem
                if p_max >= HORN_SINGLE_MAX_PANNS or y_max >= HORN_SINGLE_MAX_YAM:
                    return True

                # Criterion B: modest mean with recurrence (panns pos_ratio acts as recurrence)
                if p_mean >= HORN_MEAN_MIN and p_pos >= HORN_POS_RATIO_MIN:
                    return True

            # Criterion C: safety via mix-only (helps when stems smear brass energy)
            mix = stems.get("mix", {}).get(label, {})
            p_mix = mix.get("panns", {})
            if float(p_mix.get("mean", 0.0) or 0.0) >= MIX_MEAN_MIN and float(p_mix.get("pos_ratio", 0.0) or 0.0) >= MIX_POS_RATIO_MIN:
                return True

            return False

        # Only attempt horn promotion if Demucs was used (stem-aware context)
        horn_labels = ("Trumpet", "Trombone")
        if use_demucs:
            for _lbl in horn_labels:
                try:
                    hit = _horn_hit(_lbl)
                except Exception:
                    hit = False
                if hit:
                    instruments.append(_lbl)
        
        # ------------------------
        # Meta: Brass (section)
        # Fire only when at least 2 horn classes show consistent activity
        # without relaxing individual horn thresholds.
        HORNS = ["Trumpet", "Trombone", "Saxophone"]
        pos_ok_count = 0
        brass_mean_sum = 0.0
        for h in HORNS:
            if h in combined:
                brass_mean_sum += float(combined[h]["mean"])
                if float(combined[h]["pos_ratio"]) >= 0.03:
                    pos_ok_count += 1
        # conservative but fits your track: two horns moving together + enough energy overall
        if pos_ok_count >= 2 and brass_mean_sum >= 0.040:
            if "Brass (section)" not in instruments:
                instruments.append("Brass (section)")
            # expose a score so UI can sort/show strength
            instrument_scores["Brass (section)"] = round(brass_mean_sum, 4)
            decision_trace["Brass (section)"] = {
                "accepted": True,
                "scores": {"mean_sum": brass_mean_sum, "pos_ok_count": pos_ok_count},
                "thresholds": {"POS_AT_LEAST": 0.03, "MEAN_SUM": 0.040, "REQUIRE_AT_LEAST": 2},
                "why": "meta: ≥2 horns pos≥0.03 & sum(mean)≥0.040"
            }
        
        
        # --- Meta rule: sax assist when brass section is present ---
        try:
            final_set = set(instruments)  # or whatever variable holds the accepted list so far
            brass_ok = ("Brass (section)" in final_set)
            horn_ok  = any(
                decision_trace.get(h, {}).get("accepted") for h in ("Trumpet", "Trombone")
            )
            sax_scores = combined.get("Saxophone")

            if brass_ok and horn_ok and sax_scores:
                # near-threshold criteria just for this meta assist
                if sax_scores.get("mean", 0.0) >= 0.006 and sax_scores.get("pos_ratio", 0.0) >= 0.015:
                    if "Saxophone" not in final_set:
                        instruments.append("Saxophone")
                    # annotate decision trace
                    dt = decision_trace.setdefault("Saxophone", {})
                    dt["accepted"] = True
                    dt["why"] = (dt.get("why", "") + " | ").strip(" |") + \
                                "meta: brass present + near-threshold sax"
                    dt["thresholds_meta"] = {"MEAN": 0.006, "POS": 0.015}
        except Exception as e:
            print(f"[ENSEMBLE][WARN] meta_rule_sax_with_brass failed: {e}")
        
        # --- HTS-AT Brass (section) meta rule (if HTS-AT was available) ---
        if 'htsat_vars' in locals():
            hts_trumpet = htsat_vars['hts_trumpet']
            hts_trombone = htsat_vars['hts_trombone']
            hts_sax = htsat_vars['hts_sax']
            hts_fhorn = htsat_vars['hts_fhorn']
            hts_tuba = htsat_vars['hts_tuba']
            hts_brass_any = htsat_vars['hts_brass_any']
            
            # Fire only when multiple brass-family members exhibit evidence.
            brass_members = [
                ('Trumpet',   combined.get('Trumpet',   {'mean':0,'max':0})),
                ('Trombone',  combined.get('Trombone',  {'mean':0,'max':0})),
                ('Saxophone', combined.get('Saxophone', {'mean':0,'max':0})),
            ]
            # Soft signals from HTS-AT count too
            brass_soft_votes = sum([
                1 if hts_trumpet  > 0.08 else 0,
                1 if hts_trombone > 0.08 else 0,
                1 if hts_fhorn    > 0.08 else 0,
                1 if hts_tuba     > 0.08 else 0,
                1 if hts_sax      > 0.10 else 0,
            ])

            # Near-miss check relative to your stem-aware thresholds (don't relax global thresholds).
            def _near_miss(name, scores, rel=0.8):
                th = STEM_THRESHOLDS.get(name, {})
                m_ok  = scores.get('mean', 0) >= rel * th.get('MEAN', 1e9)
                pr_ok = scores.get('pos_ratio', 0) >= rel * th.get('POS', 1e9)
                mx_ok = scores.get('max', 0)  >= rel * th.get('SINGLE_HIGH', 1e9)
                return (m_ok and pr_ok) or mx_ok

            brass_hard_votes = sum(1 for n, s in brass_members if _near_miss(n, s, rel=0.8))

            add_brass_section = (brass_hard_votes >= 2) or (brass_hard_votes >= 1 and brass_soft_votes >= 2) or (hts_brass_any >= 0.20 and brass_soft_votes >= 1)

            if add_brass_section:
                # Expose a pooled score so downstream tools can inspect it (optional).
                pooled = max(
                    combined.get('Trumpet', {}).get('mean', 0),
                    combined.get('Trombone', {}).get('mean', 0),
                    combined.get('Saxophone', {}).get('mean', 0),
                    hts_brass_any
                )
                instrument_scores['Brass (section)'] = round(float(pooled), 4)
                # Only append to the final list if not present.
                # We keep canonical instrument list flat (no duplicates).
                if 'Brass (section)' not in instruments:
                    instruments.append('Brass (section)')

            # --- Meta: Strings (section) ------------------------------------------
            strings_members = [
                ('Violin',      combined.get('Violin',      {'mean':0,'max':0})),
                ('Viola',       combined.get('Viola',       {'mean':0,'max':0})),
                ('Cello',       combined.get('Cello',       {'mean':0,'max':0})),
                ('Double Bass', combined.get('Double Bass', {'mean':0,'max':0})),
            ]
            strings_soft_votes = sum([
                1 if hts_violin  > 0.08 else 0,
                1 if hts_viola   > 0.08 else 0,
                1 if hts_cello   > 0.08 else 0,
                1 if hts_dbass   > 0.08 else 0,
                1 if hts_strings_any > 0.12 else 0,
            ])
            strings_hard_votes = sum(1 for n, s in strings_members if _near_miss(n, s, rel=0.8))
            add_strings_section = (strings_hard_votes >= 2) or (strings_hard_votes >= 1 and strings_soft_votes >= 2) or (hts_strings_any >= 0.22 and strings_soft_votes >= 1)
            if add_strings_section:
                pooled = max(
                    combined.get('Violin', {}).get('mean', 0),
                    combined.get('Viola',  {}).get('mean', 0),
                    combined.get('Cello',  {}).get('mean', 0),
                    combined.get('Double Bass', {}).get('mean', 0),
                    hts_strings_any
                )
                instrument_scores['Strings (section)'] = round(float(pooled), 4)
                if 'Strings (section)' not in instruments:
                    instruments.append('Strings (section)')
        
        scores = {inst: round(float(combined[inst]["mean"]), 4) for inst in TARGET_INSTRUMENTS}
        trace = {
            "window_sec": WIN_SEC,
            "hop_sec": HOP_SEC,
            "num_windows": nwin,
            "stem_aware": True,
            "per_stem": per_stem,
            "combined": combined,
            "decision_trace": decision_trace,
            "rules": {
                "mean_thresh": "stem_aware",
                "pos_ratio_thresh": "stem_aware", 
                "single_high": "stem_aware",
            }
        }
    else:
        # Fall back to mix-only analysis
        piano_mean = (p_mean.get("piano",0.0) + y_mean.get("piano",0.0)) / 2.0
        piano_ratio = (p_ratio.get("piano",0.0) + y_ratio.get("piano",0.0)) / 2.0
        piano_mean = max(piano_mean, piano_mean_other)
        piano_ratio = max(piano_ratio, piano_ratio_other)

        # Apply brass gate & piano veto
        decisions = brass_gate(decisions, mean_combined, (piano_mean, piano_ratio))

        # Build final instrument list (display names) conservatively
        instruments = []
        for key, (disp, _) in TARGETS.items():
            if key == "brass":
                if decisions.get("brass", False):
                    instruments.append(disp)
            else:
                if decisions.get(key, False):
                    instruments.append(disp)
        
        # ------------------------
        # Meta: Brass (section)
        # Fire only when at least 2 horn classes show consistent activity
        # without relaxing individual horn thresholds.
        HORNS = ["Trumpet", "Trombone", "Saxophone"]
        pos_ok_count = 0
        brass_mean_sum = 0.0
        for h in HORNS:
            if h in mean_combined:
                brass_mean_sum += float(mean_combined[h])
                # For mix-only, we need to check if the horn was detected
                if decisions.get(h.lower(), False):
                    pos_ok_count += 1
        # conservative but fits your track: two horns moving together + enough energy overall
        if pos_ok_count >= 2 and brass_mean_sum >= 0.040:
            if "Brass (section)" not in instruments:
                instruments.append("Brass (section)")
        
        # --- Meta rule: sax assist when brass section is present ---
        try:
            final_set = set(instruments)  # or whatever variable holds the accepted list so far
            brass_ok = ("Brass (section)" in final_set)
            horn_ok  = any(
                decisions.get(h.lower(), False) for h in ("Trumpet", "Trombone")
            )
            sax_mean = mean_combined.get("saxophone", 0.0)
            sax_pos = (p_ratio.get("saxophone", 0.0) + y_ratio.get("saxophone", 0.0)) / 2.0

            if brass_ok and horn_ok:
                # near-threshold criteria just for this meta assist
                if sax_mean >= 0.006 and sax_pos >= 0.015:
                    if "Saxophone" not in final_set:
                        instruments.append("Saxophone")
        except Exception as e:
            print(f"[ENSEMBLE][WARN] meta_rule_sax_with_brass failed: {e}")
        
        # Scores for debugging (combined model means per target)
        scores = {k: round(float(mean_combined.get(k,0.0)), 4) for k in TARGETS.keys()}

        trace = {
            "window_sec": WIN_SEC,
            "hop_sec": HOP_SEC,
            "num_windows": nwin,
            "per_model": {
                "panns": { "mean_probs": {k: round(p_mean.get(k,0.0),4) for k in TARGETS.keys()},
                           "pos_ratio":  {k: round(p_ratio.get(k,0.0),4) for k in TARGETS.keys()} },
                "yamnet":{ "mean_probs": {k: round(y_mean.get(k,0.0),4) for k in TARGETS.keys()},
                           "pos_ratio":  {k: round(y_ratio.get(k,0.0),4) for k in TARGETS.keys()} },
            },
            "rules": {
                "mean_thresh": MEAN_THRESH,
                "pos_ratio_thresh": POS_RATIO_THRESH,
                "single_high": SINGLE_HIGH,
                "brass_generic_gate": BRASS_GENERIC_GATE,
                "brass_generic_piano_veto": BRASS_GENERIC_PIANO_VETO,
                "piano_strong_ratio": PIANO_STRONG_RATIO,
                "piano_strong_mean": PIANO_STRONG_MEAN
            }
        }

    # --- Section → child promotion ---------------------------------------
    # Only run if HTS-AT variables are available (stem-aware path)
    if 'htsat_vars' in locals():
        hts_trumpet = htsat_vars['hts_trumpet']
        hts_trombone = htsat_vars['hts_trombone']
        hts_sax = htsat_vars['hts_sax']
        hts_fhorn = htsat_vars['hts_fhorn']
        hts_tuba = htsat_vars['hts_tuba']
        hts_violin = htsat_vars['hts_violin']
        hts_viola = htsat_vars['hts_viola']
        hts_cello = htsat_vars['hts_cello']
        hts_dbass = htsat_vars['hts_dbass']
        
        # Promote specific brass children when Brass (section) is present AND a child is a strong near-miss.
        if 'Brass (section)' in instruments:
            # Consider either HTS-AT high or stem-aware 'max' as the promotion trigger.
            def _promote_child(name, hts_score_key, pr_rel=0.9, max_gate=0.35, hts_gate=0.25):
                s = combined.get(name, {})
                near = _near_miss(name, s, rel=pr_rel)
                hts_score = {
                    'Trumpet': hts_trumpet, 'Trombone': hts_trombone,
                    'French Horn': hts_fhorn, 'Tuba': hts_tuba,
                    'Saxophone': hts_sax
                }.get(name, 0.0)
                strong = (s.get('max', 0.0) >= max_gate) or (hts_score >= hts_gate)
                if near and strong and name not in instruments:
                    instruments.append(name)
            # Try common brass chairs (we only add names that exist in your taxonomy).
            for child in ['Trumpet', 'Trombone', 'Saxophone', 'French Horn', 'Tuba']:
                _promote_child(child, child)

        # Promote string chairs when Strings (section) passes and chair is a strong near-miss.
        if 'Strings (section)' in instruments:
            def _promote_string(name, hts_val, pr_rel=0.9, max_gate=0.32, hts_gate=0.22):
                s = combined.get(name, {})
                near = _near_miss(name, s, rel=pr_rel)
                strong = (s.get('max', 0.0) >= max_gate) or (hts_val >= hts_gate)
                if near and strong and name not in instruments:
                    instruments.append(name)
            _promote_string('Violin',      hts_violin)
            _promote_string('Viola',       hts_viola)
            _promote_string('Cello',       hts_cello)
            _promote_string('Double Bass', hts_dbass)

    # Apply orchestral horn boost if Demucs was used and by_stem data is available
    try:
        if used_demucs and 'per_stem' in locals():
            horn_add, horn_trace = _apply_orchestral_horn_boost(per_stem, RULES)
            if 'decision_trace' not in locals():
                decision_trace = {}
            decision_trace["orchestral_horn_boost"] = horn_trace
            for lbl in horn_add:
                if lbl not in instruments:
                    instruments.append(lbl)
            
            # Apply v2 orchestral horn boost (adds French Horn detection)
            _apply_orchestral_horn_boost_v2(per_stem, instruments, decision_trace)
            
            # Apply strings section boost (adds orchestral strings detection)
            _apply_strings_section_boost_v1(per_stem, instruments, decision_trace)
            
            # Apply conservative strings section boost (stem-aware)
            _apply_strings_section_boost(per_stem, set(instruments), decision_trace)
            
            # --- New boosters: woodwinds section + timpani ---
            try:
                added_wood = _apply_woodwinds_boost(per_stem, combined, decision_trace)
            except Exception as e:
                decision_trace.setdefault("warnings", []).append(f"woodwinds_boost_warn: {e}")
                added_wood = set()
            try:
                added_timp = _apply_timpani_boost(per_stem, decision_trace)
            except Exception as e:
                decision_trace.setdefault("warnings", []).append(f"timpani_boost_warn: {e}")
                added_timp = set()

            # Merge these into your instrument set BEFORE finalization
            for lab in (added_wood | added_timp):
                if lab not in instruments:
                    instruments.append(lab)
    except Exception as e:
        # never crash analysis; record and continue
        if 'decision_trace' not in locals():
            decision_trace = {}
        decision_trace.setdefault("warnings", []).append(f"orchestral_horn_boost_warn: {e}")

    # -----------------------------
    # STEM-AWARE ORCHESTRAL HORN RULE (Trumpet & Trombone)
    # Calibrated on your Beatles/Beach Boys tests.
    # This rule only runs when Demucs per-stem data is present.
    # It is conservative: requires (a) a small global horns sum AND
    # (b) per-stem evidence for BOTH trumpet and trombone.
    # If both pass, promote "Brass (section)" in addition to the horns.
    # -----------------------------

    def _stem_mean(by_stem: dict, stem: str, label: str) -> float:
        """Safe getter for mean score of `label` in `stem` from instrument_by_stem."""
        try:
            return float(by_stem.get(stem, {}).get(label, {}).get("mean", 0.0))
        except Exception:
            return 0.0

    try:
        by_stem = per_stem if 'per_stem' in locals() else {}
        if by_stem:
            # Read core horn means from stems most likely to carry horn energy post-Demucs.
            tpt_mix   = _stem_mean(by_stem, "mix",   "Trumpet")
            tbn_mix   = _stem_mean(by_stem, "mix",   "Trombone")
            tpt_other = _stem_mean(by_stem, "other", "Trumpet")
            tbn_other = _stem_mean(by_stem, "other", "Trombone")

            # Global presence gate: total horn energy across mix+other must clear this.
            # (Low absolute numbers but enforced across two instruments and stems.)
            SUM_MIN        = 0.010

            # Per-stem minimums (tuned from your JSONs; mix is lower than other):
            MIX_MIN_TPT    = 0.0012
            MIX_MIN_TBN    = 0.0012
            OTHER_MIN_TPT  = 0.0020
            OTHER_MIN_TBN  = 0.0028

            horns_sum = (tpt_mix + tbn_mix + tpt_other + tbn_other)
            tpt_ok = (tpt_other >= OTHER_MIN_TPT) or (tpt_mix >= MIX_MIN_TPT)
            tbn_ok = (tbn_other >= OTHER_MIN_TBN) or (tbn_mix >= MIX_MIN_TBN)

            horn_pass = (horns_sum >= SUM_MIN) and tpt_ok and tbn_ok

            if horn_pass:
                inst = set(instruments)
                inst.add("Trumpet")
                inst.add("Trombone")
                inst.add("Brass (section)")  # section promotion when both horns present
                instruments = sorted(inst)

                # Add a clear trace so you can audit why this fired.
                if 'decision_trace' not in locals():
                    decision_trace = {}
                if "instrument_decision_trace" not in decision_trace:
                    decision_trace["instrument_decision_trace"] = {}
                trace = decision_trace["instrument_decision_trace"]
                rules = trace.setdefault("rules", [])
                rules.append({
                    "rule": "orchestral_horn_boost_v1",
                    "why": {
                        "sum_means_mix+other": round(horns_sum, 6),
                        "mix":   {"Trumpet": round(tpt_mix, 6),   "Trombone": round(tbn_mix, 6)},
                        "other": {"Trumpet": round(tpt_other, 6), "Trombone": round(tbn_other, 6)},
                        "thresholds": {
                            "SUM_MIN": SUM_MIN,
                            "MIX_MIN_TPT": MIX_MIN_TPT, "MIX_MIN_TBN": MIX_MIN_TBN,
                            "OTHER_MIN_TPT": OTHER_MIN_TPT, "OTHER_MIN_TBN": OTHER_MIN_TBN
                        }
                    }
                })
    except Exception as e:
        # Never crash analysis if stems are missing / shape changed.
        if 'decision_trace' not in locals():
            decision_trace = {}
        if "instrument_decision_trace" not in decision_trace:
            decision_trace["instrument_decision_trace"] = {}
        trace = decision_trace["instrument_decision_trace"]
        warnings = trace.setdefault("warnings", [])
        warnings.append(f"horn_rule_skip:{type(e).__name__}")
    # ----------------------------- END HORN RULE -----------------------------

    # --- apply conservative mix-only rescue if main list is empty ---
    # Expect these locals to exist at this point:
    #   instruments (list of names), decision_trace (dict), used_demucs (bool)
    try:
        if not instruments and not used_demucs:
            rescue = _mix_only_rescue_from_trace(decision_trace if isinstance(decision_trace, dict) else {})
            if rescue:
                # rescue is list of (display_name, dbg) tuples
                instruments = [name for name, _dbg in rescue]
                # expose trace for wrapper/debugging
                if not isinstance(decision_trace, dict):
                    decision_trace = {}
                decision_trace.setdefault("mix_only_rescue", {})
                decision_trace["mix_only_rescue"]["picked"] = instruments
                decision_trace["mix_only_rescue"]["thresholds"] = dict(
                    MEAN_ANY=_MIX_ONLY_CFG["MEAN_ANY"],
                    POS_ANY=_MIX_ONLY_CFG["POS_ANY"],
                    PANN_POS_BONUS=_MIX_ONLY_CFG["PANN_POS_BONUS"],
                    MAX_PICKS=_MIX_ONLY_CFG["MAX_PICKS"],
                )
                # include raw scores for transparency
                decision_trace["mix_only_rescue"]["evidence"] = [
                    dict(name=name, **dbg) for name, dbg in rescue
                ]
    except Exception as e:
        # never let rescue crash the pipeline
        if isinstance(decision_trace, dict):
            decision_trace.setdefault("warnings", [])
            decision_trace["warnings"].append(f"mix_only_rescue_warn: {e!r}")

    # Core instrument failsafe - ensure drums and guitars are added if they meet thresholds
    if not used_demucs:  # Only in mix-only mode
        core_instruments = []
        # Use MIX_ONLY_CORE_V2 thresholds
        drum_mean = p_mean.get("drums", 0.0) + y_mean.get("drums", 0.0)
        drum_pos = max(p_ratio.get("drums", 0.0), y_ratio.get("drums", 0.0))
        if drum_mean >= 0.006 and drum_pos >= 0.030:
            core_instruments.append("Drum Kit (acoustic)")
        
        ag_mean = p_mean.get("acoustic_guitar", 0.0) + y_mean.get("acoustic_guitar", 0.0)
        ag_pos = max(p_ratio.get("acoustic_guitar", 0.0), y_ratio.get("acoustic_guitar", 0.0))
        if ag_mean >= 0.006 and ag_pos >= 0.023:
            core_instruments.append("Acoustic Guitar")
        
        eg_mean = p_mean.get("electric_guitar", 0.0) + y_mean.get("electric_guitar", 0.0)
        eg_pos = max(p_ratio.get("electric_guitar", 0.0), y_ratio.get("electric_guitar", 0.0))
        if eg_mean >= 0.006 and eg_pos >= 0.023:
            core_instruments.append("Electric Guitar")
        
        # Add core instruments if not already present
        for inst in core_instruments:
            if inst not in instruments:
                instruments.append(inst)

    # Build the output dictionary first
    out = {
        "instruments": instruments,
        "instrument_source": instrument_source if 'instrument_source' in locals() else "ensemble",
        "instruments_ensemble": instruments,  # keep legacy mirror if present in your file
        "scores": scores,
        "decision_trace": trace,
        "used_demucs": used_demucs,
        "by_stem": per_stem if 'per_stem' in locals() else {},  # detailed per-stem aggregates for debugging UI (optional)
    }

    # Mix-only orchestral/keyboard booster (conservative)
    try:
        if not out.get("used_demucs", False):
            trace = out.get("decision_trace", {}) or {}
            current = out.get("instruments", []) or []
            # Only bother if we returned nothing or very few (keeps it conservative)
            if len(current) <= 2:
                extra = _boost_mix_only_orchestral(trace, current)
                if extra:
                    out["instruments"] = _merge_instruments(current, extra)
    except Exception as e:
        try:
            out.setdefault("decision_trace", {})
            out["decision_trace"].setdefault("warnings", []).append(
                f"mix_only_orchestral_boost_warn: {type(e).__name__}: {e}"
            )
        except Exception:
            pass

    # Mix-only core booster (after orchestral booster)
    try:
        # Only in mix-only mode
        if not used_demucs:
            trace = out.get("decision_trace", {}) or {}
            current = out.get("instruments", []) or []
            core_added, core_decisions = _apply_mix_only_core_boost(trace, current)
            if core_added:
                # Dedup while preserving order
                for lbl in core_added:
                    if lbl not in current:
                        current.append(lbl)

                # Update the output
                out["instruments"] = current

                # Audit trail in decision_trace
                boosts = trace.setdefault("boosts", {})
                boosts["mix_only_core_v2"] = {
                    "booster": "mix_only_core_v2",
                    "thresholds": {
                        "acoustic_guitar": {"mean": 0.006, "pos": 0.023},
                        "drum_kit":        {"mean": 0.006, "pos": 0.030},
                        "electric_guitar": {"mean": 0.006, "pos": 0.023},
                        "bass_guitar":     {"mean": 0.004, "pos": 0.000},
                    },
                    "decisions": core_decisions,
                    "added": core_added,
                }
    except Exception as e:
        # Never break pipeline if booster hiccups
        try:
            out.setdefault("decision_trace", {})
            out["decision_trace"].setdefault("warnings", []).append(
                f"mix_only_core_v2_warn: {type(e).__name__}: {e}"
            )
        except Exception:
            pass

    # Mix-only strings booster (after core booster)
    try:
        # Only in mix-only mode
        if not used_demucs:
            trace = out.get("decision_trace", {}) or {}
            current = out.get("instruments", []) or []
            per_model = trace.get("per_model", {})
            _apply_mix_only_strings_v1(per_model, current, trace)
            # Update the output with any strings added
            out["instruments"] = current
            
            # Woodwinds booster
            _boost_mix_only_woodwinds_v1(current, trace)
            # Update the output with any woodwinds added
            out["instruments"] = current
    except Exception as e:
        # Never break pipeline if booster hiccups
        try:
            out.setdefault("decision_trace", {})
            out["decision_trace"].setdefault("warnings", []).append(
                f"mix_only_strings_v1_warn: {type(e).__name__}: {e}"
            )
        except Exception:
            pass

    # Additional mix-only boosters (woodwinds, percussion, harp)
    try:
        # Only in mix-only mode
        if not used_demucs:
            trace = out.get("decision_trace", {}) or {}
            current = out.get("instruments", []) or []
            per_model = trace.get("per_model", {})
            
            # Woodwinds booster
            added = []
            _mix_only_woodwinds_v2(current, trace, added)
            if added:
                current.extend(added)

            # NEW: Woodwinds section booster (mix-only path)
            ww_added, ww_log = _mix_only_woodwinds_v1(trace)
            trace.setdefault("boosts", {})["mix_only_woodwinds_v1"] = ww_log
            for a in ww_added:
                if a not in current: 
                    current.append(a)

            # Percussion (timpani) booster
            added_timpani = _booster_mix_only_percussion_v1(per_model, trace, current)
            for item in added_timpani:
                if item not in current:
                    current.append(item)

            # Harp booster
            added_harp = _booster_mix_only_harp_v1(per_model, trace, current)
            for item in added_harp:
                if item not in current:
                    current.append(item)

            # Add mix-only Brass booster so we seed a Brass (section) tag for downstream boosters
            try:
                added_brass = _apply_mix_only_brass_boost(current, trace)
                # Guard: ensure we don't duplicate
                for inst in added_brass:
                    if inst and inst not in current:
                        current.append(inst)
            except Exception:
                # Non-fatal: continue even if the brass booster fails
                pass

            # Now run the original horns-specific booster (which can rely on the section tag)
            # Specific horns booster (Trumpet/Trombone)
            added_specific_horns = _booster_mix_only_horns_specific_v1(per_model, trace, current)
            for item in added_specific_horns:
                if item not in current:
                    current.append(item)

            # Mix-only targeted boosts (conservative)
            _apply_mix_only_bass_trumpet_boost(current, trace)
            
            # Core booster v2 with relaxed thresholds (mix-only path)
            _apply_mix_only_core_v2(current, trace)
            
            # Woodwinds section booster (mix-only path)
            _apply_mix_only_woodwinds_boost(current, trace, lambda name, data: trace.setdefault("boosts", {})[name] or trace["boosts"].update({name: data}))
            
            # Woodwinds booster v1 with relaxed thresholds (mix-only path)
            _apply_mix_only_woodwinds_v1(current, trace)
            
            # Soft drums rescue v1 - improve recall for brush kits
            _apply_soft_drums_rescue_v1(current, trace)
            
            # Woodwinds section any v1 - add section label based on any woodwind evidence
            _apply_woodwinds_section_any_v1(current, trace)
            
            # Strings pad guard v1 - demote synth string pads
            _apply_strings_pad_guard_v1(current, trace)
            
            # Family rollup (mix-only path) - add grouped orchestral families if evidence present
            try:
                decision = {"instruments": current}
                _family_rollup(decision, trace)
                current = decision["instruments"]
            except Exception as e:
                # Never break pipeline if rollup hiccups
                trace.setdefault("warnings", []).append(f"family_rollup_warn: {type(e).__name__}: {e}")
            
            # Additional robust family rollup for woodwinds (mix-only)
            try:
                _robust_family_rollup_v1(current, trace)
            except Exception as e:
                trace.setdefault("warnings", []).append(f"robust_family_rollup_v1_warn: {type(e).__name__}: {e}")
            
            # Update the output with any new instruments added
            out["instruments"] = current
            
            # v1.2.0: robust delicate-drums rescue (post-boosters; independent of mix_only_core_v2 state)
            # Based on Adele runs: PANNs drum≈0.0079, YAMNet drum≈0.0003, piano present; earlier passes added drums, others dropped them. This makes the rescue consistent.
            try:
                pm  = trace.get("per_model", {}).get("panns",  {}).get("mean_probs", {})
                ym  = trace.get("per_model", {}).get("yamnet", {}).get("mean_probs", {})
                p_dm = float(pm.get("drum_kit", 0.0))
                y_dm = float(ym.get("drum_kit", 0.0))
                p_pn = float(pm.get("piano",    0.0))
                y_pn = float(ym.get("piano",    0.0))
                # v1.3.0: Use either-model piano context (PANNs mean >=0.006 OR YAMNet pos_ratio >=0.05)
                # and slightly relax drum gates to stabilize soft-kit inclusion on piano-led tracks.
                if ("Drum Kit (acoustic)" not in current
                    and p_dm >= 0.0072                # was 0.0075; slightly looser for Adele's ~0.0079
                    and y_dm <= 0.0006               # was 0.0005; allow tiny YAMNet drum
                    and (
                        p_pn >= 0.006               # PANNs piano mean (Adele ~0.0068)
                        or trace.get("per_model", {}).get("yamnet", {}).get("pos_ratio", {}).get("piano", 0.0) >= 0.05
                       )                             # accept YAMNet piano context (Adele ~0.0781)
                   ):
                    current.append("Drum Kit (acoustic)")
                    out["instruments"] = current
                    trace.setdefault("rescues", []).append("delicate_drums_postboost_v2")
            except Exception as _e:
                trace.setdefault("warnings", []).append(f"postboost_drums_rescue_warn:{_e}")
    except Exception as e:
        # Never break pipeline if booster hiccups
        try:
            out.setdefault("decision_trace", {})
            out["decision_trace"].setdefault("warnings", []).append(
                f"additional_mix_only_boosters_warn: {type(e).__name__}: {e}"
            )
        except Exception:
            pass
    
    # Add diagnostics if requested
    if diag:
        diag_data = {
            "track_level": {
                "panns": {"mean_probs": p_mean, "pos_ratio": p_ratio},
                "yamnet": {"mean_probs": y_mean, "pos_ratio": y_ratio}
            },
            "decisions": decisions,
            "sections": {
                "woodwinds": {
                    "present": any(key in WOODWINDS and decisions.get(key, False) for key in decisions.keys())
                }
            }
        }
        if _PER_WINDOW:
            diag_data["per_window"] = {
                "panns": {k: v[:30] if len(v) > 30 else v for k, v in per_win.get("panns", {}).items()},
                "yamnet": {k: v[:30] if len(v) > 30 else v for k, v in per_win.get("yamnet", {}).items()}
            }
        out["__diag"] = diag_data
    
    # Add sections information for woodwinds
    if "instruments" in out:
        woodwinds_present = []
        for inst in out["instruments"]:
            if inst in ["Flute", "Clarinet", "Oboe", "Bassoon", "Woodwinds (section)"]:
                if inst not in woodwinds_present:
                    woodwinds_present.append(inst)
        
        if woodwinds_present:
            out["sections"] = {
                "woodwinds": {
                    "present": True,
                    "list": sorted(woodwinds_present)
                }
            }
    
    # Add runtime debug stamp to decision_trace
    try:
        decision_trace = out.get("decision_trace", {})
        decision_trace["__module_file__"] = __file__
        decision_trace["__version__"] = __version__
        decision_trace["__thresholds_debug__"] = {
            "mix_only_core_v2": {
                "acoustic_guitar": {"mean": 0.006, "pos": 0.023},
                "drum_kit":        {"mean": 0.006, "pos": 0.030},
                "electric_guitar": {"mean": 0.006, "pos": 0.023},
                "bass_guitar":     {"mean": 0.004, "pos": 0.000}
            },
            "mix_only_woodwinds_v1": {
                "per_instrument": {"mean": 0.0015, "pos": 0.0},
                "section_min_count": 1,
                "strong_individual": {"mean": 0.005, "pos": 0.020}
            },
            "family_rollup_v1": FAMILY_ROLLUP_V1,
            "robust_family_rollup_v1": {
                "agg_mean": 0.0004,
                "require_context": True,
                "context_gate": 0.0
            },
            "woodwinds_rollup": {
                "rollup_min_mean_any": 0.00035,
                "rollup_min_pos_any": 0.0,
                "section_min_hits": 1
            },
            "section_requires_pos_ratio": True,
            "woodwinds_group_min_pos_ratio": 0.01,
            "__sparse_drum_policy__": {
                "combo": {"panns_mean": 0.008, "yamnet_mean": 0.00025},
                "single": {"panns_mean": 0.010},
                "hinted": {"panns_mean": 0.0065, "yamnet_mean": 0.00020}
            },
            "__family_fallbacks__": {
                "woodwinds_section_minChild": {"pos": 0.005, "mean": 0.003}
            }
        }
        decision_trace["__groups_always__"] = sorted(GROUPS_ALWAYS) if GROUPS_ALWAYS else []
        out["decision_trace"] = decision_trace
    except Exception as _e:
        out.setdefault("errors", []).append(f"debug_stamp_failed:{type(_e).__name__}:{_e}")

    # Apply grouping pass for woodwinds/brass/strings sections
    try:
        current_instruments = out.get("instruments", [])
        decision_trace = out.get("decision_trace", {})
        per_model = decision_trace.get("per_model", {})
        
        # Woodwinds grouping: if any woodwind child passes, add "Woodwinds (section)"
        wood_children = ['flute', 'clarinet', 'oboe', 'bassoon', 'saxophone']
        woodwinds_added = False
        
        for child in wood_children:
            if child in current_instruments:
                # Check if child has pos_ratio >= 0.01 OR (mean >= 0.006 AND pos_ratio > 0)
                try:
                    child_mean = _combined_mean(decision_trace, child)
                except Exception as e:
                    _log.debug("booster _combined_mean failed for %s: %s", child, e)
                    child_mean = 0.0
                child_pos = _any_pos(decision_trace, child)
                
                if (child_pos >= 0.01) or (child_mean >= 0.006 and child_pos > 0):
                    if "Woodwinds (section)" not in current_instruments:
                        current_instruments.append("Woodwinds (section)")
                        woodwinds_added = True
                    break
        
        # Brass grouping: ensure "Brass (section)" requires pos_ratio > 0
        brass_children = ['trumpet', 'trombone', 'saxophone']
        if "Brass (section)" in current_instruments:
            # Check if any brass child has pos_ratio > 0
            has_brass_pos = any(_has_pos(decision_trace, child) for child in brass_children)

            # If no child shows pos_ratio, we used to unconditionally remove the section.
            # However, boosters (e.g., mix_only_brass_v1) may legitimately add the section
            # based on generic evidence. Preserve the section if a brass booster signalled pass
            # or explicitly added "Brass (section)" in the decision trace.
            try:
                boosters = decision_trace if isinstance(decision_trace, dict) else {}
                boosts_map = boosters.get("boosts", {}) if isinstance(boosters, dict) else {}

                # Normalized access for the specific brass booster entry
                brass_boost = boosts_map.get("mix_only_brass_v1", {}) if isinstance(boosts_map, dict) else {}

                # Consider the booster "passed" if it sets 'pass' truthy or explicitly lists "Brass (section)" in its added list
                booster_pass = bool(brass_boost.get("pass")) or ("Brass (section)" in (brass_boost.get("added") or []))
            except Exception:
                # Defensive fallback: if anything goes wrong inspecting the trace, treat booster_pass as False
                booster_pass = False

            # Only remove the section if there is no child pos evidence AND no brass booster approval.
            if (not has_brass_pos) and (not booster_pass):
                current_instruments.remove("Brass (section)")
        
        # Strings grouping: ensure "Strings (section)" requires pos_ratio > 0
        if "Strings (section)" in current_instruments:
            if not _has_pos(decision_trace, "strings"):
                current_instruments.remove("Strings (section)")
        
        out["instruments"] = current_instruments
        
    except Exception as e:
        # Never break pipeline if grouping hiccups
        out.setdefault("errors", []).append(f"grouping_pass_failed:{type(e).__name__}:{e}")

    # Family-level woodwinds promotion (mix-only mode)
    try:
        current_instruments = out.get("instruments", [])
        decision_trace = out.get("decision_trace", {})
        
        WOODWIND_CHILDREN = ['flute', 'clarinet', 'oboe', 'bassoon']
        ww_hits = 0
        
        for child in WOODWIND_CHILDREN:
            try:
                cm = _combined_mean(decision_trace, child)    # panns+yam mean
            except Exception as e:
                _log.debug("booster _combined_mean failed for %s: %s", child, e)
                cm = 0.0
            cp = _any_pos(decision_trace, child)          # any model pos_ratio
            if cp >= 0.005 or (cm >= 0.003 and cp > 0):
                ww_hits += 1
        
        if ww_hits >= 1:
            if "Woodwinds (section)" not in current_instruments:
                current_instruments.append("Woodwinds (section)")
            out.setdefault("sections", {}).setdefault("woodwinds", {})["present"] = True
        
        out["instruments"] = current_instruments
        
    except Exception as e:
        # Never break pipeline if family promotion hiccups
        out.setdefault("errors", []).append(f"family_woodwinds_promotion_failed:{type(e).__name__}:{e}")

    # Apply orchestral grouping to final instruments list
    try:
        final_visible = _collapse_orchestral_groups(out.get("instruments", []), out.get("decision_trace", {}).get("per_model"))
        out["instruments"] = final_visible
    except Exception as _e:
        # Never break pipeline if grouping hiccups
        out.setdefault("errors", []).append(f"orchestral_grouping_failed:{type(_e).__name__}:{_e}")

    return out

def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="Path to input audio file (wav/mp3/flac)")
    ap.add_argument("--json-out", default=None, help="If set, write JSON here; else print to stdout")
    ap.add_argument("--demucs", type=int, default=1, help="1 to use Demucs 'other' stem for piano confirmation; 0 to disable")
    ap.add_argument("--diag", action="store_true", help="Enable detailed diagnostics output")
    args = ap.parse_args()

    out = analyze(args.audio, use_demucs=bool(args.demucs), diag=args.diag)
    
    # Add debug logging
    DO_TRACE = os.environ.get("ENSEMBLE_TRACE", "1") != "0"
    if DO_TRACE:
        try:
            audio_path = args.audio if hasattr(args, 'audio') else ''
            base = _log_basename(audio_path)
            stamp = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
            log_dir = _ens_log_dir()
            _safe_mkdir(log_dir)
            
            # always dump the complete result
            out_name = f"ensemble-python-{base}-{stamp}.json"
            out_path = os.path.join(log_dir, out_name)
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump(out, f, indent=2, ensure_ascii=False)

            # if you have per-model stats, also dump a focused decision-trace file for quick diffs
            if isinstance(out.get('decision_trace'), dict):
                trace_name = f"ensemble-python-{base}-{stamp}-trace.json"
                trace_path = os.path.join(log_dir, trace_name)
                with open(trace_path, 'w', encoding='utf-8') as f:
                    json.dump(out['decision_trace'], f, indent=2, ensure_ascii=False)

        except Exception as _e:
            try:
                error_name = f"ensemble-python-error-{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.json"
                error_path = os.path.join(_ens_log_dir(), error_name)
                with open(error_path, 'w', encoding='utf-8') as f:
                    json.dump({
                        "error": str(_e),
                        "trace": traceback.format_exc()
                    }, f, indent=2, ensure_ascii=False)
            except Exception:
                pass
    
    js = json.dumps(out, ensure_ascii=False, indent=2)
    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            f.write(js)
    else:
        print(js)

if __name__ == "__main__":
    # Only run if caller passes a real file via argv
    if len(sys.argv) > 1:
        main()
