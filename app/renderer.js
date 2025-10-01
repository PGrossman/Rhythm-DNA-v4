// Basic three-tab UI controller; logs module init imports

import { DragDrop } from './modules/dragdrop.js';
import { SettingsStore } from './modules/settings.js';
import { normalizeAnalysis } from './renderer/normalize_analysis.js';
import { getDetectedInstruments, getCreativeInstruments, deriveSectionTags } from './renderer/instrument_access.js';

// Safety valve: Only show extra signals when explicitly toggled ON (default OFF)
const SHOW_EXTRAS = false;

// Helper function to render creative instruments as "Suggested (LLM)" with visual distinction
function renderSuggestedInstruments(track) {
    const suggested = getCreativeInstruments(track);
    if (!suggested.length) return null;
    
    // Filter to known taxonomy (optional - you can implement ALL_INSTRUMENT_LABELS if needed)
    // const SUGGESTED_DISPLAY = suggested.filter(x => ALL_INSTRUMENT_LABELS.has(x));
    const SUGGESTED_DISPLAY = suggested; // For now, show all suggested instruments
    
    return {
        instruments: SUGGESTED_DISPLAY,
        label: 'Suggested (LLM – not used for search)',
        muted: true,
        readonly: true
    };
}

// Helper function to render instrument pills with visual styling
function renderPills(instruments, options = {}) {
    const { muted = false, label = '', readonly = false } = options;
    
    if (!instruments || !instruments.length) return '';
    
    const pillClass = muted ? 'instrument-pill muted' : 'instrument-pill';
    const readonlyAttr = readonly ? 'readonly' : '';
    
    const pills = instruments.map(inst => 
        `<span class="${pillClass}" ${readonlyAttr}>${inst}</span>`
    ).join(' ');
    
    return label ? `<div class="instrument-section"><strong>${label}</strong><br/>${pills}</div>` : pills;
}

// Helper function to get detected instruments for display
// This should be used for all UI rendering and filtering - never use creative.instrument
function getDetectedInstrumentsForDisplay(track) {
    const detected = getDetectedInstruments(track);
    return deriveSectionTags(detected);
}

// Instantiate modules to trigger init logs
const dragDrop = new DragDrop();
const settingsStore = new SettingsStore();

const panel = document.getElementById('panel');
let currentQueue = [];
let allowReanalyze = false;

const views = {
    analysis: `
        <h2>Audio Analysis Queue</h2>
        <div id="drop-zone">
            <div class="folder-icon">📁</div>
            <p>Drop audio folder here</p>
            <p class="subtitle">Supports MP3 and WAV files with recursive folder scanning</p>
        </div>
        <div style="margin: 20px 0;">
            <button id="start-analysis" style="padding: 10px 20px; background: #10b981; color: white; border: none; border-radius: 6px; cursor: pointer;">Start Analysis</button>
            <button id="clear-queue" style="padding: 10px 20px; background: #ef4444; color: white; border: none; border-radius: 6px; cursor: pointer; margin-left: 10px;">Clear Queue</button>
            <label style="margin-left: 20px; display: inline-flex; align-items: center; gap: 8px; font-size: 14px;">
                <input type="checkbox" id="allow-reanalyze" style="width: 16px; height: 16px;">
                <span>Re-analyze existing files</span>
            </label>
        </div>
        <div id="queue-display"></div>
    `,
    search: `
        <div style="display:grid;grid-template-columns:260px 1fr;gap:20px;height:calc(100vh - 100px);padding:20px;">
            <!-- Left: filters -->
            <div style="border-right:1px solid #e5e5e5;padding-right:16px;overflow-y:auto;">
                <h3 style="margin:0 0 12px 0;">Filters</h3>
                <button id="clear-filters" style="width:100%;padding:8px;margin-bottom:8px;background:#ef4444;color:#fff;border:none;border-radius:6px;cursor:pointer;">
                    Clear All
                </button>
                <button id="do-search" style="width:100%;padding:8px;margin-bottom:12px;background:#10b981;color:#fff;border:none;border-radius:6px;cursor:pointer;opacity:0.5;" disabled>
                    Search
                </button>
                <div id="search-filters"></div>
            </div>
            <!-- Right: fixed toolbar + scrollable results -->
            <div style="display:flex;flex-direction:column;overflow:hidden;">
                <!-- Fixed top volume bar -->
                <div id="volume-bar"
                     style="position:sticky;top:0;z-index:2;background:#fff;
                            display:flex;align-items:center;gap:8px;
                            justify-content:flex-end;padding:8px 0 10px 0;border-bottom:1px solid #eee;">
                    <span style="font-size:12px;color:#333;">Volume</span>
                    <input id="volume-slider" type="range" min="0" max="100" value="80"
                           style="width:33%;">
                    <span id="volume-value" style="width:38px;text-align:right;font-size:12px;color:#555;">80%</span>
                </div>

                <!-- Scrollable results area -->
                <div style="overflow-y:auto;flex:1;">
                    <h2 style="margin:8px 0 16px 0;">Search Library</h2>
                    
                    <!-- Toolbar with stats and pagination -->
                    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:#f5f5f5;border-radius:6px;margin-bottom:12px;">
                        <div id="result-stats" style="font-size:14px;color:#666;">Loading...</div>
                        <div style="display:flex;gap:8px;align-items:center;">
                            <button id="page-prev" style="padding:4px 12px;background:#fff;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;" disabled>Prev</button>
                            <span id="page-label" style="font-size:13px;">Page 1</span>
                            <button id="page-next" style="padding:4px 12px;background:#fff;border:1px solid #ddd;border-radius:4px;cursor:pointer;font-size:13px;" disabled>Next</button>
                        </div>
                    </div>
                    
                    <div id="search-results"></div>
                </div>
            </div>
        </div>
    `,
    settings: `
        <h2>Settings</h2>
        <button id="save-settings" style="float: right; padding: 10px 20px; background: #007AFF; color: white; border: none; border-radius: 6px; cursor: pointer;">Save Settings</button>
        <div style="clear: both;"></div>
        
        <div style="margin-top: 24px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <h3 style="margin: 0 0 16px 0;">Database Configuration</h3>
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px;">Database Folder</label>
                <div style="display: flex; gap: 12px;">
                    <input type="text" id="db-folder" placeholder="/Users/grossph/Documents/Rhytham DNA" style="flex: 1; padding: 8px 12px; border: 1px solid #d0d0d0; border-radius: 4px;" readonly>
                    <button id="choose-folder">Choose...</button>
                </div>
            </div>
            <div style="margin-bottom: 16px;">
                <label style="display: flex; align-items: center; gap: 8px;">
                    <input type="checkbox" id="auto-update-db">
                    <span>Auto-update database after each file</span>
                </label>
            </div>
            <div style="display: flex; gap: 12px;">
                <button id="update-database">Update Database</button>
                <button id="update-criteria">Update Criteria DB</button>
            </div>
        </div>
        
        <div style="margin-top: 20px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <h3 style="margin: 0 0 16px 0;">Analysis Configuration</h3>
            <div style="margin-bottom: 16px;">
                <label style="display: block; margin-bottom: 8px;">Creative Analysis Model</label>
                <select id="ollama-model" style="width: 100%; padding: 8px 12px; border: 1px solid #d0d0d0; border-radius: 4px;">
                    <option value="qwen2.5:32b-instruct">Qwen2.5 32B Instruct (Most Accurate)</option>
                    <option value="gemma2:27b-instruct">Gemma 2 27B Instruct (Very Accurate)</option>
                    <option value="mixtral:8x7b">Mixtral 8x7B (Accurate)</option>
                    <option value="qwen3:30b">Qwen3 30B (Better Quality)</option>
                    <option value="qwen3:8b">Qwen3 8B (Fast, Default)</option>
                </select>
                <div style="margin-top: 8px; font-size: 12px; color: #666;">
                    Note: Larger models require more RAM and take longer but provide better accuracy. Install models with: <code>ollama pull [model-name]</code>
                </div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                <div>
                    <label style="display: block; margin-bottom: 8px;">Technical Concurrency</label>
                    <input type="number" id="tech-concurrency" min="1" max="8" value="4" style="width: 100%; padding: 8px 12px; border: 1px solid #d0d0d0; border-radius: 4px;">
                </div>
                <div>
                    <label style="display: block; margin-bottom: 8px;">Creative Concurrency</label>
                    <input type="number" id="creative-concurrency" min="1" max="4" value="2" style="width: 100%; padding: 8px 12px; border: 1px solid #d0d0d0; border-radius: 4px;">
                </div>
            </div>
        </div>
        
        <div style="margin-top: 20px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <h3 style="margin: 0 0 16px 0;">Output Configuration</h3>
            <div style="margin-bottom: 16px;">
                <label style="display: flex; align-items: center; gap: 8px;">
                    <input type="checkbox" id="write-csv-artifacts">
                    <span>Write CSV files next to audio files</span>
                </label>
            </div>
        </div>
        
        <div style="margin-top: 20px; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
            <h3 style="margin: 0 0 16px 0;">Health Check</h3>
            <button id="health-check" style="padding: 10px 20px; background: #007AFF; color: white; border: none; border-radius: 6px; cursor: pointer;">Run Health Check</button>
            <div id="health-results" style="margin-top: 16px;"></div>
        </div>
    `
};

let currentView = 'analysis';
let currentSettings = {};
let progressStatus = {};

async function setupSettingsView() {
    try {
        const settings = await window.api.getSettings();
        if (settings.dbFolder) document.getElementById('db-folder').value = settings.dbFolder;
        document.getElementById('auto-update-db').checked = settings.autoUpdateDb || false;
        document.getElementById('ollama-model').value = settings.ollamaModel || 'qwen3:8b';
        document.getElementById('tech-concurrency').value = settings.techConcurrency || 4;
        document.getElementById('creative-concurrency').value = settings.creativeConcurrency || 2;
        
        // Load CSV setting
        document.getElementById('write-csv-artifacts').checked = settings.writeCsvArtifacts || false;
    } catch (err) {
        console.error('Failed to load settings:', err);
    }
    
    document.getElementById('save-settings')?.addEventListener('click', async () => {
        await saveSettings();
        alert('Settings saved successfully');
    });
    
    document.getElementById('choose-folder')?.addEventListener('click', async () => {
        const result = await window.api.chooseFolder();
        if (result.folder) document.getElementById('db-folder').value = result.folder;
    });
    
    document.getElementById('update-database')?.addEventListener('click', async () => {
        await window.api.updateDatabase();
        alert('Database updated');
    });
    
    document.getElementById('update-criteria')?.addEventListener('click', async () => {
        await window.api.updateCriteriaDb();
        alert('Criteria DB updated');
    });
    
    document.getElementById('health-check')?.addEventListener('click', async () => {
        const results = document.getElementById('health-results');
        results.innerHTML = 'Checking...';
        const health = await window.api.runHealthCheck();
        results.innerHTML = 
            (health.ffprobe ? '✓ ffprobe OK<br>' : '✗ ffprobe missing<br>') +
            (health.ffmpeg ? '✓ ffmpeg OK<br>' : '✗ ffmpeg missing<br>') +
            (health.ollama ? '✓ Ollama connected' : '✗ Ollama not running');
    });
}

async function saveSettings() {
    const settings = {
        dbFolder: document.getElementById('db-folder').value,
        autoUpdateDb: document.getElementById('auto-update-db').checked,
        ollamaModel: document.getElementById('ollama-model').value,
        techConcurrency: parseInt(document.getElementById('tech-concurrency').value),
        creativeConcurrency: parseInt(document.getElementById('creative-concurrency').value),
        
        // CSV setting
        writeCsvArtifacts: document.getElementById('write-csv-artifacts').checked
    };
    
    try {
        await window.api.updateSettings(settings);
        console.log('Settings saved:', settings);
    } catch (err) {
        console.error('Failed to save settings:', err);
    }
}

const setView = (name) => {
    currentView = name;
    panel.innerHTML = views[name] || '';
    
    // Update active tab styling
    document.querySelectorAll('.tabs button').forEach(btn => {
        btn.classList.remove('active');
    });
    document.getElementById(`tab-${name}-btn`).classList.add('active');
    
    // Setup view-specific handlers
    if (name === 'analysis') {
        setupAnalysisView();
    } else if (name === 'search') {
        setupSearchView();
    } else if (name === 'settings') {
        setupSettingsView();
    }
};

// Shared audio + state for search playback
let __audio = null;
let __playingPath = null;
let __raf = null;

// Search state with pagination
const PAGE_SIZE = 10;
let ALL_TRACKS = [];          // Full normalized list
let FILTER_STATE = {};        // facet -> Set(values)
let IS_DIRTY = false;         // Filters changed but not applied
let CURRENT_RESULTS = [];     // Last filtered results
let CURRENT_PAGE = 1;         // Current page (1-based)

// v3.3.0: Register IPC listeners on DOMContentLoaded (after preload API is fully ready)
// This ensures window.api.instrumentation exists before trying to register listeners
window.addEventListener('DOMContentLoaded', () => {
    console.log('[RENDERER] DOMContentLoaded - sending ready signal');
    window.api?.sendRendererReady?.();
    
    // Now register instrumentation listeners (preload API is guaranteed to exist)
    console.log('[RENDERER] Registering instrumentation listeners');
    console.log('[RENDERER] window.api.instrumentation exists:', !!window.api?.instrumentation);
    console.log('[RENDERER] window.api.instrumentation.onStart exists:', !!window.api?.instrumentation?.onStart);

    if (window.api?.instrumentation?.onStart) {
        console.log('[RENDERER] Calling window.api.instrumentation.onStart()');
        window.api.instrumentation.onStart(({ file }) => {
            console.log('[RENDERER] Received instrumentation:start event for file:', file);
            console.log('[RENDERER] Current queue length:', currentQueue.length);
            const row = currentQueue.find(t => t.path === file);
            console.log('[RENDERER] Found row:', row ? row.fileName : 'NOT FOUND');
            if (!row) {
                console.warn('[RENDERER] No matching row found for file:', file);
                console.log('[RENDERER] Available paths:', currentQueue.map(t => t.path));
                return;
            }
            console.log('[RENDERER] Updating row instrumentation state to processing');
            row.instrumentationState = 'processing';
            row.instrumentationDisplay = 'PROCESSING';
            row.instrumentationPct = 0;
            updateQueueDisplay();
            console.log('[RENDERER] UI updated');
        });
    } else {
        console.error('[RENDERER] window.api.instrumentation.onStart not available!');
    }

    if (window.api?.instrumentation?.onProgress) {
        console.log('[RENDERER] Calling window.api.instrumentation.onProgress()');
        window.api.instrumentation.onProgress(({ file, pct = 0, label }) => {
            console.log('[RENDERER] Received instrumentation:progress event - file:', file, 'pct:', pct, 'label:', label);
            const row = currentQueue.find(t => t.path === file);
            if (!row) {
                console.warn('[RENDERER] No matching row for progress event:', file);
                return;
            }
            console.log('[RENDERER] Updating instrumentation to', pct + '%');
            row.instrumentationState = 'processing';
            row.instrumentationPct = pct;
            if (pct >= 100) {
                row.instrumentationDisplay = 'COMPLETE';
            } else if (pct >= 75) {
                row.instrumentationDisplay = '75%';
            } else if (pct >= 50) {
                row.instrumentationDisplay = '50%';
            } else if (pct >= 25) {
                row.instrumentationDisplay = '25%';
            } else {
                row.instrumentationDisplay = label || 'PROCESSING';
            }
            updateQueueDisplay();
        });
    } else {
        console.error('[RENDERER] window.api.instrumentation.onProgress not available!');
    }
});

async function setupSearchView() {
    console.log('[SEARCH] Initializing search view');
    
    // Create shared audio element
    if (!__audio) {
        __audio = new Audio();
        __audio.preload = 'metadata';
        __audio.style.display = 'none';
        document.body.appendChild(__audio);
        __audio.addEventListener('ended', () => {
            resetPlaybackUI();
        });
    }

    // Master volume control
    const volEl = document.getElementById('volume-slider');
    const volLbl = document.getElementById('volume-value');
    
    // Helper to apply and persist volume
    function applyVolume(fraction) {
        const v = Math.max(0, Math.min(1, Number(fraction) || 0));  // Clamp 0..1
        __audio.volume = v;
        localStorage.setItem('rdna.volume', String(v));  // Persist across sessions
        if (volEl) volEl.value = String(Math.round(v * 100));
        if (volLbl) volLbl.textContent = `${Math.round(v * 100)}%`;
    }
    
    // Initialize from saved value or default 80%
    const savedVolume = parseFloat(localStorage.getItem('rdna.volume'));
    applyVolume(Number.isFinite(savedVolume) ? savedVolume : 0.8);
    
    // Handle slider changes
    if (volEl) {
        volEl.addEventListener('input', (e) => {
            const pct = e.target.valueAsNumber ?? Number(e.target.value);
            applyVolume(pct / 100);
        });
    }
    
    // Keep UI in sync if volume changes programmatically
    __audio.addEventListener('volumechange', () => {
        const pct = Math.round((__audio.volume || 0) * 100);
        if (volEl) volEl.value = String(pct);
        if (volLbl) volLbl.textContent = `${pct}%`;
    });

    const resultsEl = document.getElementById('search-results');
    const filtersEl = document.getElementById('search-filters');
    
    if (!resultsEl || !filtersEl) {
        console.error('[SEARCH] Missing containers');
        return;
    }

    try {
        // Load database
        const dbData = await window.api.searchGetDB();
        if (dbData && dbData.success === false) {
            throw new Error(dbData.error || 'DB load failed');
        }

        // Normalize tracks once
        ALL_TRACKS = normalizeTracks(dbData.rhythm);
        
        // Normalize analysis objects to prefer ensemble instruments
        ALL_TRACKS.forEach(track => {
            if (track.analysis) {
                normalizeAnalysis(track.analysis);
            }
        });
        
        window.CURRENT_TRACKS = ALL_TRACKS; // Make tracks available for tempo band counting
        console.log('[SEARCH] Loaded', ALL_TRACKS.length, 'tracks');
        
        if (!ALL_TRACKS.length) {
            resultsEl.innerHTML = '<p style="padding:20px;color:#666;">No analyzed tracks found.</p>';
            document.getElementById('result-stats').textContent = 'No tracks';
            return;
        }
        
        // Pre-compute searchable fields for performance
        ALL_TRACKS.forEach(track => {
        // Pre-compute instruments (DETECTED only for filtering)
        // Use only ensemble-driven analysis.instruments - no creative, no audio_probes
        const detected = getDetectedInstruments(track);

        // Derive section tags for display purposes only (not stored in analysis.instruments)
        const displayInstruments = deriveSectionTags(detected);

        // Defensive log to catch any future leakage
        const shown = new Set(track.analysis?.instruments || []);
        const llm = new Set((track.analysis?.creative && track.analysis.creative.suggestedInstruments) || []);
        const leaking = [...llm].filter(x => !shown.has(x));
        if (leaking.length) console.debug('[INSTRUMENTS] ignoring LLM-only labels:', leaking);

        track._instruments = new Set(displayInstruments.map(v => String(v).toLowerCase()));
            
            // Pre-compute vocals (keep original format)
            track._vocals = track.creative?.vocals || track.audio_probes?.vocals || null;
            
            // Pre-compute other facets lowercased
            track._genre = new Set((track.creative?.genre || []).map(v => String(v).toLowerCase()));
            track._mood = new Set((track.creative?.mood || []).map(v => String(v).toLowerCase()));
            track._theme = new Set((track.creative?.theme || []).map(v => String(v).toLowerCase()));
            track._artist = String(track.artist || '').toLowerCase();
            // track._tempoBand = String(track.tempoBand || '').toLowerCase(); // Not needed - using numeric BPM matching
        });

        // Render filters
        renderFilters(dbData.criteria || {});
        
        // Show random 10 initially
        showRandomSample();
        
        // Wire up search and pagination
        setupSearchHandlers();

    } catch (e) {
        console.error('[SEARCH] Error:', e);
        resultsEl.innerHTML = '<p style="padding:20px;color:red;">Error loading search data.</p>';
    }
}

function showRandomSample() {
    const sample = [...ALL_TRACKS].sort(() => Math.random() - 0.5).slice(0, 10);
    CURRENT_RESULTS = sample;
    window.CURRENT_TRACKS = sample; // Update current tracks for tempo band counting
    CURRENT_PAGE = 1;
    
    renderPage(sample, 1);
    document.getElementById('result-stats').textContent = 'Showing 10 random tracks';
    document.getElementById('page-prev').disabled = true;
    document.getElementById('page-next').disabled = true;
    document.getElementById('page-label').textContent = '';
}

function setupSearchHandlers() {
    // Search button
    document.getElementById('do-search').onclick = () => {
        if (!IS_DIRTY && Object.keys(FILTER_STATE).length === 0) {
            // No filters = show random
            showRandomSample();
            return;
        }
        
        // Apply filters
        CURRENT_RESULTS = filterTracksOptimized(ALL_TRACKS, FILTER_STATE);
        window.CURRENT_TRACKS = CURRENT_RESULTS; // Update current tracks for tempo band counting
        CURRENT_PAGE = 1;
        IS_DIRTY = false;
        
        // Update UI
        document.getElementById('do-search').disabled = true;
        document.getElementById('do-search').style.opacity = '0.5';
        
        renderPaginatedResults();
    };
    
    // Pagination
    document.getElementById('page-prev').onclick = () => goToPage(CURRENT_PAGE - 1);
    document.getElementById('page-next').onclick = () => goToPage(CURRENT_PAGE + 1);
    
    // Clear filters
    document.getElementById('clear-filters').onclick = () => {
        document.querySelectorAll('#search-filters input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
        });
        FILTER_STATE = {};
        IS_DIRTY = false;
        document.getElementById('do-search').disabled = true;
        document.getElementById('do-search').style.opacity = '0.5';
        showRandomSample();
    };
    
    // Enter key triggers search
    document.getElementById('search-filters').addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !document.getElementById('do-search').disabled) {
            document.getElementById('do-search').click();
        }
    });
}

function goToPage(page) {
    const maxPage = Math.ceil(CURRENT_RESULTS.length / PAGE_SIZE);
    page = Math.max(1, Math.min(page, maxPage));
    
    if (page === CURRENT_PAGE) return;
    
    // Stop any playback
    stopAllPlayback();
    
    CURRENT_PAGE = page;
    renderPaginatedResults();
}

function renderPaginatedResults() {
    const start = (CURRENT_PAGE - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const pageData = CURRENT_RESULTS.slice(start, end);
    
    renderPage(pageData, CURRENT_PAGE);
    
    // Update stats
    const total = CURRENT_RESULTS.length;
    if (total === 0) {
        document.getElementById('result-stats').textContent = 'No matches found';
    } else {
        const showing = `${start + 1}–${Math.min(end, total)}`;
        document.getElementById('result-stats').textContent = `Showing ${showing} of ${total}`;
    }
    
    // Update pagination controls
    const maxPage = Math.ceil(total / PAGE_SIZE);
    document.getElementById('page-prev').disabled = CURRENT_PAGE <= 1;
    document.getElementById('page-next').disabled = CURRENT_PAGE >= maxPage;
    document.getElementById('page-label').textContent = maxPage > 1 ? `Page ${CURRENT_PAGE} of ${maxPage}` : '';
}

function fmtTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec || 0)));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2,'0')}`;
}

function pickDuration(track) {
    return track.duration_sec ?? track.analysis?.duration_sec ?? track.creative?.duration_sec ?? null;
}

function matchesInstrument(t, tags) {
    const detected = getDetectedInstruments(t);
    const displayInstruments = deriveSectionTags(detected);
    const cur = new Set(displayInstruments.map(v => String(v).toLowerCase()));
    return tags.every(tag => cur.has(String(tag).toLowerCase()));
}

const norm = (s) => String(s).trim().toLowerCase();

function parseTempoRangeLabel(label) {
    // Parses "Medium (90-110 BPM)" or "90-110" to get numeric range
    const match = String(label).match(/(\d+)\s*[-–]\s*(\d+)/);
    if (!match) return null;
    return { min: Number(match[1]), max: Number(match[2]) };
}

// Parse tempo band label to get numeric range
function parseTempoBandLabel(label) {
    for (const band of TEMPO_BANDS) {
        if (band.label === label) {
            return { min: band.min, max: band.max };
        }
    }
    return null;
}

function filterTracksOptimized(tracks, filters) {
    const activeFilters = Object.entries(filters).filter(([, set]) => set && set.size > 0);
    if (activeFilters.length === 0) return tracks;
    
    // Pre-parse tempo ranges once
    const tempoRanges = [];
    if (filters.tempoBands && filters.tempoBands.size > 0) {
        [...filters.tempoBands].forEach(label => {
            // Try new tempo band format first, then fall back to old format
            let range = parseTempoBandLabel(label);
            if (!range) {
                range = parseTempoRangeLabel(label);
            }
            if (range) tempoRanges.push(range);
        });
    }
    
    return tracks.filter(track => {
        // Check tempo bands first (special numeric handling)
        if (tempoRanges.length > 0) {
            const bpm = Number(track.estimated_tempo_bpm || track.creative?.bpm || track.bpm || 0);
            if (!bpm || !tempoRanges.some(r => {
                const okMin = r.min == null || bpm >= r.min;
                const okMax = r.max == null || bpm < r.max;
                return okMin && okMax;
            })) {
                return false;
            }
        }
        
        // Check other facets
        for (const [facet, filterSet] of activeFilters) {
            if (facet === 'tempoBands') continue; // Already handled above
            
            const normalizedFilter = new Set([...filterSet].map(v => String(v).toLowerCase()));
            
            let match = false;
            if (facet === 'instrument') {
                match = matchesInstrument(track, [...normalizedFilter]);
            } else if (facet === 'vocals') {
                // Handle vocals properly - can be array, string, or boolean
                let trackValues = [];
                const v = track.creative?.vocals;
                
                if (Array.isArray(v)) {
                    trackValues = v;  // Keep array values like ['male vocal', 'lead vocal']
                } else if (typeof v === 'string') {
                    trackValues = [v];  // Single string value
                } else if (typeof v === 'boolean') {
                    trackValues = [v ? 'yes' : 'no'];  // Boolean to yes/no
                } else if (typeof track.audio_probes?.vocals === 'boolean') {
                    trackValues = [track.audio_probes.vocals ? 'yes' : 'no'];  // Fallback to probes
                } else {
                    trackValues = [];
                }
                
                // Case-insensitive comparison
                const wanted = new Set([...filterSet].map(norm));
                const have = new Set(trackValues.map(norm));
                match = [...wanted].some(v => have.has(v));
            } else if (facet === 'genre') {
                match = [...normalizedFilter].some(v => track._genre.has(v));
            } else if (facet === 'mood') {
                match = [...normalizedFilter].some(v => track._mood.has(v));
            } else if (facet === 'theme') {
                match = [...normalizedFilter].some(v => track._theme.has(v));
            } else if (facet === 'artists') {
                match = normalizedFilter.has(track._artist);
            } else if (facet === 'keys') {
                // Handle keys if needed
                const trackKeys = track.creative?.keys || [];
                const normalizedKeys = new Set(trackKeys.map(k => String(k).toLowerCase()));
                match = [...normalizedFilter].some(v => normalizedKeys.has(v));
            }
            
            if (!match) return false;
        }
        return true;
    });
}

function stopAllPlayback() {
    if (__audio && !__audio.paused) {
        __audio.pause();
    }
    resetPlaybackUI();
    __playingPath = null;
    cancelAnimationFrame(__raf);
}

function resetPlaybackUI() {
    document.querySelectorAll('.rdna-play').forEach(b => b.textContent = 'Play');
    document.querySelectorAll('.playhead').forEach(ph => {
        ph.style.left = '0';
        ph.style.display = 'none';
    });
}

function toFileUrl(abs) {
    return encodeURI('file://' + String(abs).replace(/\\/g, '/'));
}

function normalizeTracks(rhythm) {
    if (Array.isArray(rhythm)) return rhythm;
    if (rhythm?.tracks && typeof rhythm.tracks === 'object') return Object.values(rhythm.tracks);
    if (rhythm && typeof rhythm === 'object') return Object.values(rhythm);
    return [];
}

function facetLabels(src) {
    if (!src) return [];
    if (Array.isArray(src)) return src.slice().map(String);
    if (typeof src === 'object') return Object.keys(src).map(String);
    return [];
}

// Tempo bands exactly as in the screenshot
const TEMPO_BANDS = [
    { key: 'very_slow', label: 'Very Slow (Below 60 BPM)', min: null, max: 60 },
    { key: 'slow',      label: 'Slow (60-90 BPM)',         min: 60,  max: 90  },
    { key: 'medium',    label: 'Medium (90-110 BPM)',      min: 90,  max: 110 },
    { key: 'upbeat',    label: 'Upbeat (110-140 BPM)',     min: 110, max: 140 },
    { key: 'fast',      label: 'Fast (140-160 BPM)',       min: 140, max: 160 },
    { key: 'very_fast', label: 'Very Fast (160+ BPM)',     min: 160, max: null },
];

// Pull BPM from any of the fields we write in analysis JSON
function getTrackBpm(track) {
    const v = track?.tempo_bpm ?? track?.estimated_tempo_bpm ?? track?.bpm ?? null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// Count how many results land in each band
function countTempoBands(tracks) {
    const counts = {};
    TEMPO_BANDS.forEach(b => counts[b.key] = 0);
    
    for (const t of tracks || []) {
        const bpm = getTrackBpm(t);
        if (bpm == null) continue;
        
        for (const b of TEMPO_BANDS) {
            const okMin = b.min == null || bpm >= b.min;
            const okMax = b.max == null || bpm < b.max;
            if (okMin && okMax) { 
                counts[b.key]++; 
                break; 
            }
        }
    }
    return counts;
}

function renderFilters(criteria) {
    const mount = document.getElementById('search-filters');
    mount.innerHTML = '';
    
    // Get current tracks for tempo band counting
    const currentTracks = window.CURRENT_TRACKS || [];
    const tempoCounts = countTempoBands(currentTracks);
    
    const sections = [
        { key: 'instrument', label: 'Instruments', values: facetLabels(criteria.instrument) },
        { key: 'genre', label: 'Genre', values: facetLabels(criteria.genre) },
        { key: 'mood', label: 'Mood', values: facetLabels(criteria.mood) },
        { key: 'vocals', label: 'Vocals', values: facetLabels(criteria.vocals) },
        { key: 'theme', label: 'Theme', values: facetLabels(criteria.theme) },
        { key: 'tempoBands', label: 'Tempo', values: facetLabels(criteria.tempoBands) },
        { key: 'keys', label: 'Keys', values: facetLabels(criteria.keys) },
        { key: 'artists', label: 'Artists', values: facetLabels(criteria.artists) }
    ];
    
    sections.forEach(({ key, label, values }) => {
        // Special handling for tempo bands
        if (key === 'tempoBands') {
            const box = document.createElement('details');
            box.open = true; // Keep tempo section open by default
            box.style.marginBottom = '12px';
            box.innerHTML = `
                <summary style="cursor:pointer;font-weight:600;padding:4px 0;">${label}</summary>
                <div style="padding-left:10px;max-height:240px;overflow-y:auto;"></div>
            `;
            const body = box.querySelector('div');
            
            // Render tempo band checkboxes
            TEMPO_BANDS.forEach(band => {
                const count = tempoCounts[band.key] || 0;
                if (count === 0) return; // Only show bands with tracks
                
                const row = document.createElement('label');
                row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer;';
                
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.dataset.facet = 'tempoBands';
                checkbox.value = band.label;
                checkbox.style.marginRight = '6px';
                
                const labelSpan = document.createElement('span');
                labelSpan.textContent = band.label;
                
                const countSpan = document.createElement('span');
                countSpan.textContent = `(${count})`;
                countSpan.style.opacity = '0.6';
                
                row.appendChild(checkbox);
                row.appendChild(labelSpan);
                row.appendChild(countSpan);
                body.appendChild(row);
            });
            
            if (body.children.length === 0) {
                // No tempo bands have tracks, don't show the section
                return;
            }
            
            mount.appendChild(box);
            return;
        }
        
        // Regular sections (non-tempo)
        if (!values.length) return;
        const box = document.createElement('details');
        box.open = (key === 'genre' || key === 'mood');
        box.style.marginBottom = '12px';
        box.innerHTML = `
            <summary style="cursor:pointer;font-weight:600;padding:4px 0;">${label}</summary>
            <div style="padding-left:10px;max-height:240px;overflow-y:auto;"></div>
        `;
        const body = box.querySelector('div');
        values.sort().forEach(v => {
            const row = document.createElement('label');
            row.style.cssText = 'display:block;margin:4px 0;cursor:pointer;';
            row.innerHTML = `<input type="checkbox" data-facet="${key}" value="${v}" style="margin-right:6px;"> ${v}`;
            body.appendChild(row);
        });
        mount.appendChild(box);
    });
    
    // Restore checkbox states from current filter state
    mount.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
        const facet = checkbox.dataset.facet;
        const value = checkbox.value;
        if (FILTER_STATE[facet] && FILTER_STATE[facet].has(value)) {
            checkbox.checked = true;
        }
    });
    
    // Track filter changes
    mount.addEventListener('change', (e) => {
        if (e.target.type !== 'checkbox') return;
        
        const facet = e.target.dataset.facet;
        const value = e.target.value;
        
        if (!FILTER_STATE[facet]) {
            FILTER_STATE[facet] = new Set();
        }
        
        if (e.target.checked) {
            FILTER_STATE[facet].add(value);
        } else {
            FILTER_STATE[facet].delete(value);
            if (FILTER_STATE[facet].size === 0) {
                delete FILTER_STATE[facet];
            }
        }
        
        // Mark as dirty and enable search button
        IS_DIRTY = true;
        document.getElementById('do-search').disabled = false;
        document.getElementById('do-search').style.opacity = '1';
    });
}


function startRaf(playhead, audio) {
    cancelAnimationFrame(__raf);
    const loop = () => {
        if (!audio || audio.paused || !isFinite(audio.duration)) return;
        const pct = (audio.currentTime / audio.duration) * 100;
        playhead.style.left = pct + '%';
        __raf = requestAnimationFrame(loop);
    };
    __raf = requestAnimationFrame(loop);
}

function wireScrub(img, track, playhead) {
    img.style.cursor = 'ew-resize';
    
    img.addEventListener('click', (e) => {
        if (!isFinite(__audio.duration) || __audio.src === '') return;
        const rect = img.getBoundingClientRect();
        const pct = Math.min(Math.max(0, (e.clientX - rect.left) / rect.width), 1);
        __audio.currentTime = __audio.duration * pct;
        playhead.style.left = (pct * 100) + '%';
    });
    
    img.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const move = (ev) => {
            if (!isFinite(__audio.duration) || __audio.src === '') return;
            const rect = img.getBoundingClientRect();
            const pct = Math.min(Math.max(0, (ev.clientX - rect.left) / rect.width), 1);
            __audio.currentTime = __audio.duration * pct;
            playhead.style.left = (pct * 100) + '%';
        };
        const up = () => {
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
    });
}

function renderPage(list, pageNum) {
    renderResults(document.getElementById('search-results'), list);
}

function renderResults(mount, list) {
    if (!list.length) {
        mount.innerHTML = '<p style="padding:20px;">No matching tracks found.</p>';
        return;
    }
    
    mount.innerHTML = '';
    
    list.forEach((track) => {
        const title = track.title || track.id3?.title || 
                     track.path?.split('/').pop()?.replace(/\.(mp3|wav)$/i,'') || 
                     'Unknown Track';
        const artist = track.artist || track.id3?.artist || '';
        
        const card = document.createElement('div');
        card.style.cssText = 'border:1px solid #e5e5e5;border-radius:8px;padding:12px;margin-bottom:12px;background:#fff;';
        card.dataset.trackPath = track.path;

        // Header with title and buttons
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:start;margin-bottom:6px;';
        
        const left = document.createElement('div');
        left.innerHTML = `
            <h4 style="margin:0 0 4px 0;font-size:16px;">${title}</h4>
            ${artist ? `<p style="margin:0;color:#666;font-size:13px;">${artist}</p>` : ''}
        `;
        
        const right = document.createElement('div');
        right.style.cssText = 'display:flex;gap:8px;';
        
        const playBtn = document.createElement('button');
        playBtn.className = 'rdna-play';
        playBtn.textContent = 'Play';
        playBtn.style.cssText = 'padding:6px 10px;background:#10b981;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;';
        
        const finderBtn = document.createElement('button');
        finderBtn.textContent = 'Show File';
        finderBtn.style.cssText = 'padding:6px 10px;background:#007AFF;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;';
        finderBtn.onclick = async () => {
            const p = track.path || '';
            
            // Check if this is a /Volumes/<ShareName> path
            const match = p.match(/^\/Volumes\/([^/]+)/);
            if (match) {
                const shareName = match[1];
                try {
                    // Get SMB settings
                    const settings = await window.api.getSettings();
                    const smbUrl = settings.smbShares?.[shareName];
                    
                    if (smbUrl) {
                        // Try to ensure mount before showing file
                        const mountPoint = `/Volumes/${shareName}`;
                        const result = await window.api.ensureMounted(mountPoint, smbUrl);
                        if (!result.ok && !result.already) {
                            console.warn('[SMB] Could not mount share:', shareName);
                        }
                    }
                } catch (e) {
                    console.log('[SMB] Mount check failed:', e);
                }
            }
            
            // Show the file regardless (will fail gracefully if not accessible)
            await window.api.searchShowFile(p);
        };
        
        right.appendChild(playBtn);
        right.appendChild(finderBtn);
        header.appendChild(left);
        header.appendChild(right);
        card.appendChild(header);

        // Waveform with playhead
        const waveWrap = document.createElement('div');
        waveWrap.style.cssText = 'position:relative;margin:8px 0;';
        
        const img = document.createElement('img');
        img.style.cssText = 'width:100%;height:60px;object-fit:cover;border-radius:4px;display:block;user-select:none;';
        img.loading = 'lazy';
        
        const playhead = document.createElement('div');
        playhead.className = 'playhead';
        playhead.style.cssText = 'position:absolute;top:0;left:0;width:2px;height:60px;background:red;display:none;pointer-events:none;';
        
        waveWrap.appendChild(img);
        waveWrap.appendChild(playhead);
        card.appendChild(waveWrap);

        // Meta row under waveform: description + duration + WAV badge
        const desc = track.creative?.description || track.creative?.narrative || 
                     track.description || track.id3?.comment || '';
        const durStr = fmtTime(pickDuration(track));

        const meta = document.createElement('div');
        meta.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:6px;gap:10px;';

        const descEl = document.createElement('div');
        // 2-line clamp without CSS files
        descEl.style.cssText = 'flex:1;max-width:70%;font-size:12px;color:#555;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;';
        descEl.textContent = desc;

        const rightMeta = document.createElement('div');
        rightMeta.style.cssText = 'display:flex;align-items:center;gap:8px;';

        const durEl = document.createElement('span');
        durEl.style.cssText = 'font-size:12px;color:#333;font-weight:500;';
        durEl.textContent = durStr || '';

        const wavPill = document.createElement('span');
        wavPill.className = 'wav-pill';
        wavPill.style.cssText = 'display:none;padding:2px 6px;border-radius:10px;background:#e0f2ff;color:#0369a1;font-size:11px;font-weight:600;';
        wavPill.textContent = 'WAV';

        rightMeta.appendChild(durEl);
        rightMeta.appendChild(wavPill);

        meta.appendChild(descEl);
        meta.appendChild(rightMeta);
        card.appendChild(meta);

        // Load waveform (generate if missing)
        const ensurePng = async () => {
            if (track.waveform_png) return track.waveform_png;
            try {
                const r = await window.api.getWaveformPng(track.path);
                if (r?.ok && r.png) {
                    track.waveform_png = r.png;
                    return r.png;
                }
            } catch {}
            return null;
        };

        (async () => {
            const png = await ensurePng();
            if (png) img.src = toFileUrl(png);
        })();

        wireScrub(img, track, playhead);

        // Wire up playback button
        playBtn.onclick = async () => {
            const src = track.wavPath && track.wavPath.length ? track.wavPath : track.path;
            
            // Auto-mount SMB if needed for playback
            const match = src.match(/^\/Volumes\/([^/]+)/);
            if (match) {
                const shareName = match[1];
                try {
                    const settings = await window.api.getSettings();
                    const smbUrl = settings.smbShares?.[shareName];
                    if (smbUrl) {
                        await window.api.ensureMounted(`/Volumes/${shareName}`, smbUrl);
                    }
                } catch (e) {
                    console.log('[SMB] Mount for playback failed:', e);
                }
            }
            
            const url = toFileUrl(src);
            
            // Stop other tracks
            if (__playingPath && __playingPath !== track.path) {
                document.querySelectorAll('.rdna-play').forEach(b => (b.textContent = 'Play'));
                document.querySelectorAll('.playhead').forEach(ph => {
                    ph.style.display = 'none';
                    ph.style.left = '0';
                });
            }
            
            // Toggle play/pause
            if (__playingPath === track.path && !__audio.paused) {
                __audio.pause();
                playBtn.textContent = 'Play';
                cancelAnimationFrame(__raf);
                return;
            }
            
            __audio.src = url;
            __playingPath = track.path;
            playBtn.textContent = 'Pause';
            playhead.style.display = 'block';
            
            __audio.onloadedmetadata = () => startRaf(playhead, __audio);
            
            try {
                await __audio.play();
            } catch (e) {
                console.error('[SEARCH] Play failed:', e);
                playBtn.textContent = 'Play';
            }
        };

        mount.appendChild(card);

        // Show WAV badge if a WAV version exists
        (async () => {
            let hasWav = Boolean(track.wavPath && track.wavPath.length);
            try {
                // Check if IPC can tell us about versions
                if (!hasWav && window.api.searchGetVersions) {
                    const v = await window.api.searchGetVersions(track.path);
                    hasWav = Boolean(v && (v.hasWav || v.wav));
                }
            } catch {}
            
            // Fallback: check if the original is a WAV
            if (!hasWav) {
                const p = (track.path || '').toLowerCase();
                hasWav = p.endsWith('.wav');
            }
            
            // Show badge if WAV exists
            if (hasWav) {
                const pill = card.querySelector('.wav-pill');
                if (pill) pill.style.display = 'inline-block';
            }
        })();
    });
}

function setupAnalysisView() {
    const dropZone = document.getElementById('drop-zone');
    if (dropZone) {
        dragDrop.setupDropZone(dropZone);
        
        // Just add to queue on drop, don't process (additive with dedupe)
        dropZone.addEventListener('filesDropped', (e) => {
            const incoming = Array.isArray(e.detail?.tracks) ? e.detail.tracks : [];
            console.log('[Renderer] Files dropped:', incoming.length);
            
            // Merge additively by normalized absolute path; keep existing statuses
            const normPath = (p) => String(p || '').replace(/\\/g,'/').toLowerCase();
            const byPath = new Map();
            
            // Seed with existing items first (preserve their status fields)
            for (const t of currentQueue) {
                const key = normPath(t.path || t.fileName || t.filename);
                if (key) byPath.set(key, t);
            }
            
            // Add/merge incoming
            for (const t of incoming) {
                const key = normPath(t.path || t.fileName || t.filename);
                if (!key) continue;
                const existing = byPath.get(key);
                if (existing) {
                    // Augment flags; do NOT downgrade status
                    if (t.hasExistingAnalysis) existing.hasExistingAnalysis = true;
                    if (!existing.fileName && t.fileName) existing.fileName = t.fileName;
                } else {
        // v1.0.0: Initialize instrumentation state for new tracks
        t.instrumentationState = 'waiting';
        t.instrumentationDisplay = 'WAITING';
        t.instrumentationPct = 0; // 0,25,50,75,100
                    byPath.set(key, t);
                }
            }
            
            currentQueue = Array.from(byPath.values());
            updateQueueDisplay();
        });
    }
    
    // Re-analyze checkbox
    const reanalyzeCheckbox = document.getElementById('allow-reanalyze');
    if (reanalyzeCheckbox) {
        reanalyzeCheckbox.addEventListener('change', (e) => {
            allowReanalyze = e.target.checked;
            console.log('[Renderer] Re-analyze mode:', allowReanalyze);
            updateQueueDisplay();
        });
        // Set initial state
        allowReanalyze = reanalyzeCheckbox.checked;
    }
    
    // Start Analysis button
    const startBtn = document.getElementById('start-analysis');
    if (startBtn) {
        startBtn.addEventListener('click', async () => {
            console.log('[Renderer] Start Analysis clicked');
            await processQueue();
        });
    }
    
    // Clear Queue button
    const clearBtn = document.getElementById('clear-queue');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            console.log('[Renderer] Clear Queue clicked');
            currentQueue = [];
            updateQueueDisplay();
        });
    }
    
    updateQueueDisplay();
}

// v1.0.0: Start instrumentation for a specific track
function startInstrumentation(track) {
    console.log('[Renderer] Starting instrumentation for:', track.fileName);
    
    // Set instrumentation to processing
    track.instrumentationState = 'processing';
    track.instrumentationDisplay = 'PROCESSING';
    track.instrumentationPct = 0;
    updateQueueDisplay();
    
    // Note: The actual ensemble analysis happens in the main process
    // This function just updates the UI state when instrumentation starts
}

async function processQueue() {
    console.log('[Renderer] Start Analysis clicked');
    
    if (currentQueue.length === 0) {
        console.log('[Renderer] Queue is empty');
        return;
    }
    
    // Filter to audio files (not just MP3)
    const audioRe = /\.(mp3|wav|m4a|flac|aiff|aif)$/i;
    const audioTracks = currentQueue.filter(track => 
        track.path && audioRe.test(track.path)
    );
    
    if (audioTracks.length === 0) {
        console.log('[Renderer] No audio files in queue');
        return;
    }
    
    // Filter out files that shouldn't be processed
    const tracksToProcess = audioTracks.filter(track => {
        if (track.hasExistingAnalysis && !allowReanalyze) {
            console.log(`[Renderer] Skipping existing: ${track.fileName}`);
            track.status = 'SKIP';
            return false;
        }
        return true;
    });
    
    if (tracksToProcess.length === 0) {
        console.log('[Renderer] All files would be skipped');
        updateQueueDisplay();
        return;
    }
    
    console.log(`[Renderer] Processing ${tracksToProcess.length} of ${audioTracks.length} files`);
    
    // Get concurrency from settings
    const settings = await window.api.getSettings();
    const concurrency = settings.techConcurrency || 4;
    
    // Process with worker pool
    let activeWorkers = 0;
    let trackIndex = 0;
    
    const processNextTrack = async () => {
        if (trackIndex >= tracksToProcess.length) {
            return;
        }
        
        const track = tracksToProcess[trackIndex++];
        activeWorkers++;
        
        try {
            track.status = 'PROCESSING';
            updateQueueDisplay();
            
            const result = await window.api.analyzeFile(track.path);
            
            if (result.success) {
                track.status = 'COMPLETE';
                track.techStatus = 'COMPLETE';
                track.creativeStatus = 'COMPLETE';
                console.log(`[Renderer] Complete: ${track.fileName}`);
                
                // Normalize analysis data if present in result
                if (result.analysis) {
                    normalizeAnalysis(result.analysis);
                }
                
                // v3.0.0: Prefer finalized instruments, then instruments, from the analysis object
                const a = result?.analysis || {};
                const instruments = Array.isArray(a?.final_instruments)
                  ? a.final_instruments
                  : (Array.isArray(a?.instruments) ? a.instruments : []);
                
                // v3.2.0: KISS rule with badge styling - if instruments exist, consider success
                if (instruments.length) {
                    track.instrumentationState = 'complete';
                    track.instrumentationPct = 100;
                    track.instrumentationDisplay = 'COMPLETE';
                } else {
                    // Only mark error when there are truly no instruments
                    track.instrumentationState = 'error';
                    track.instrumentationDisplay = 'ERROR';
                }
            } else {
                track.status = 'ERROR';
                track.instrumentationState = 'error';
                track.instrumentationDisplay = 'ERROR';
                console.error(`[Renderer] Failed: ${track.fileName}`, result.error);
            }
        } catch (error) {
            console.error(`[Renderer] Error: ${track.fileName}:`, error);
            track.status = 'ERROR';
            track.instrumentationState = 'error';
            track.instrumentationDisplay = 'ERROR';
        }
        
        activeWorkers--;
        updateQueueDisplay();
        
        // Start next track
        if (trackIndex < tracksToProcess.length) {
            processNextTrack();
        } else if (activeWorkers === 0) {
            console.log('[Renderer] All files processed');
        }
    };
    
    // Start initial workers
    const initialWorkers = Math.min(concurrency, tracksToProcess.length);
    for (let i = 0; i < initialWorkers; i++) {
        processNextTrack();
    }
}

function updateQueueDisplay() {
    const queueDiv = document.getElementById('queue-display');
    if (!queueDiv) return;
    
    if (currentQueue.length === 0) {
        queueDiv.innerHTML = '';
        return;
    }
    
    // Count files with existing analysis
    const existingCount = currentQueue.filter(t => t.hasExistingAnalysis).length;
    const newCount = currentQueue.length - existingCount;
    
    // Apply any progress updates received from main
    currentQueue.forEach((track) => {
        const p = progressStatus[track.path];
        if (p) {
            if (p.technical) track.techStatus = p.technical.status;
            if (p.creative) track.creativeStatus = p.creative.status;
        }
    });

    // Build the status display for each track
    const getStatusBadge = (status) => {
        const statusClass = status ? status.toLowerCase() : 'queued';
        let label = status || 'QUEUED';
        
        // Handle special cases
        if (status === 'PROCESSING') {
            label = `⏳ ${status}`;
        } else if (status === '25%' || status === '50%' || status === '75%') {
            // v3.2.0: Map percentage states to processing style
            label = status;
        }
        
        return `<span class="status-badge status-${statusClass}">${label}</span>`;
    };

    let html = `
        <h3>Files to Process (${currentQueue.length} total${existingCount > 0 ? ` - ${newCount} new, ${existingCount} existing` : ''})</h3>
        ${existingCount > 0 && !allowReanalyze ? '<p style="color: #f59e0b; margin: 10px 0;">⚠️ Files with existing analysis will be skipped. Check "Re-analyze existing files" to process them.</p>' : ''}
        <table class="queue-table">
            <thead>
                <tr>
                    <th>File</th>
                    <th>Technical</th>
                    <th>Creative</th>
                    <th>Instrumentation</th>
                </tr>
            </thead>
            <tbody>
    `;
    
    currentQueue.forEach(track => {
        const isSkipped = track.hasExistingAnalysis && !allowReanalyze;
        const rowStyle = isSkipped ? 'style="opacity: 0.5;"' : '';
        const displayStatus = track.hasExistingAnalysis ? 
            (allowReanalyze ? 'RE-ANALYZE' : 'SKIP') : 
            track.status;
        
        // v1.0.0: Instrumentation column logic - use stable state management
        let instrumentationDisplay = 'WAITING';
        if (isSkipped) {
            instrumentationDisplay = 'SKIP';
        } else if (track.instrumentationDisplay) {
            // Use the stable instrumentation display value
            instrumentationDisplay = track.instrumentationDisplay;
        } else if (track.instrumentationState === 'waiting') {
            // Only show waiting if explicitly in waiting state
            instrumentationDisplay = 'WAITING';
        } else {
            // Fallback for legacy tracks without state management
            instrumentationDisplay = 'WAITING';
        }
        
        html += `
            <tr ${rowStyle}>
                <td>${track.fileName || track.filename || 'Unknown'}</td>
                <td>${getStatusBadge(isSkipped ? 'SKIP' : (track.techStatus || displayStatus))}</td>
                <td>${getStatusBadge(isSkipped ? 'SKIP' : (track.creativeStatus || 'WAITING'))}</td>
                <td>${isSkipped ? getStatusBadge('SKIP') : getStatusBadge(instrumentationDisplay)}</td>
            </tr>
        `;
    });
    
    html += `
            </tbody>
        </table>
    `;
    
    queueDiv.innerHTML = html;
}

// Listen for progress updates from main process
if (window.api && window.api.onJobProgress) {
    window.api.onJobProgress((event, data) => {
        console.log('[Renderer] Progress update:', data);
        if (!progressStatus[data.trackId]) progressStatus[data.trackId] = {};
        if (data.stage === 'technical') {
            progressStatus[data.trackId].technical = { status: data.status, note: data.note };
        } else if (data.stage === 'creative') {
            progressStatus[data.trackId].creative = { status: data.status, note: data.note };
        }
        updateQueueDisplay();
    });
}


// Listen for queue updates
window.api?.onQueueUpdate?.((event, data) => {
    const track = currentQueue.find(t => t.path === data.trackId);
    if (track) {
        track.techStatus = data.techStatus;
        track.creativeStatus = data.creativeStatus;
        updateQueueDisplay();
    }
});


// Tab navigation
document.getElementById('tab-analysis-btn').addEventListener('click', () => setView('analysis'));
document.getElementById('tab-search-btn').addEventListener('click', () => setView('search'));
document.getElementById('tab-settings-btn').addEventListener('click', () => setView('settings'));

// Default view
setView('analysis');


