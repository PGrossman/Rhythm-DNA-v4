const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { analyzeMp3 } = require('./analysis/ffcalc.js');
const DB = require('./db/jsondb.js');

// Terminal logging setup - DISABLED: File logging turned off by request
// To re-enable: Uncomment the code below and comment out the console.log statements
/*
const logDir = '/Volumes/ATOM RAID/Dropbox/_Personal Files/12 - AI Vibe Coding/02 - Cursor Projects/04 - Rhythm DNA v4/Terminal Log';
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').split('.')[0];
const logFile = path.join(logDir, `Terminal Output - ${timestamp}.log`);

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// Create write stream for logging
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

// Override console methods to write to both console and log file
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

function logToFile(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = `[${timestamp}] [${level}] ${args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ')}\n`;
    
    logStream.write(message);
    
    // Also call original console method
    if (level === 'LOG') originalConsoleLog(...args);
    else if (level === 'ERROR') originalConsoleError(...args);
    else if (level === 'WARN') originalConsoleWarn(...args);
}

console.log = (...args) => logToFile('LOG', ...args);
console.error = (...args) => logToFile('ERROR', ...args);
console.warn = (...args) => logToFile('WARN', ...args);

// Log app startup
console.log('=== Rhythm DNA v4 Terminal Log Started ===');
console.log(`Log file: ${logFile}`);
*/

// DISABLED: Terminal file logging - keeping console output only
console.log('=== Rhythm DNA v4 Started (File Logging Disabled) ===');

// App single instance lock
if (!app.requestSingleInstanceLock()) {
    app.quit();
}

// Settings storage
let settings = {
    dbFolder: '',
    autoUpdateDb: false,
    ollamaModel: 'qwen3:8b',
    techConcurrency: 4,
    creativeConcurrency: 2,
    smbShares: {
        // Add your SMB share mappings here
        // Example: "MediaShare": "smb://nas.local/MediaShare"
    }
};

// v3.3.0: Track renderer ready state - MUST be at module scope
let rendererReady = false;
const pendingAnalysis = [];
let mainWindow = null;

// DB paths helper
let dbPaths = null;
async function resolveDbPaths() {
    dbPaths = await DB.getPaths({ 
        dbFolder: settings.dbFolder, 
        userData: app.getPath('userData') 
    });
}

// Helper function for directory scanning
async function scanDirectory(dir) {
    const results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...await scanDirectory(fullPath));
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (['.mp3', '.wav', '.aif', '.aiff'].includes(ext)) {
                results.push(fullPath);
            }
        }
    }
    return results;
}

// Check if analysis files exist for a given file
function hasExistingAnalysis(filePath) {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    const jsonPath = path.join(dir, `${baseName}.json`);
    const csvPath = path.join(dir, `${baseName}.csv`);
    // Return true if either JSON or CSV exists
    return fs.existsSync(jsonPath) || fs.existsSync(csvPath);
}

// Settings file path
const getSettingsPath = () => path.join(app.getPath('userData'), 'settings.json');

// Load settings from file
const loadSettings = async () => {
    try {
        const data = await fsPromises.readFile(getSettingsPath(), 'utf8');
        const loaded = JSON.parse(data);
        settings = { ...settings, ...loaded };
        console.log('[MAIN] Settings loaded from file:', settings);
    } catch (err) {
        console.log('[MAIN] No settings file found, using defaults');
    }
};

// Save settings to file
const saveSettings = async () => {
    await fsPromises.writeFile(getSettingsPath(), JSON.stringify(settings, null, 2));
    console.log('[MAIN] Settings saved to file');
};

// Get installed Ollama models (restricted to supported set)
const getInstalledModels = async () => {
    const SUPPORTED_MODELS = [
        'qwen2.5:32b-instruct',
        'gemma2:27b-instruct',
        'mixtral:8x7b',
        'qwen3:30b',
        'qwen3:8b'
    ];
    try {
        const res = await fetch('http://127.0.0.1:11434/api/tags');
        if (!res.ok) return [];
        const data = await res.json();
        const installedModels = (data.models || []).map(m => m.name);
        return SUPPORTED_MODELS.filter(model => installedModels.some(m => m === model || m.startsWith(model + ':')));
    } catch (e) {
        console.log('[MAIN] Failed to get Ollama models:', e.message);
        return [];
    }
};

// v3.3.0: Register renderer-ready listener at MODULE LOAD (before createWindow)
// This prevents race condition where renderer sends signal before listener is registered
ipcMain.once('renderer:ready', async () => {
    console.log('[MAIN] Renderer ready signal received');
    rendererReady = true;
    
    // Process any queued analysis requests
    if (pendingAnalysis.length > 0) {
        console.log(`[MAIN] Processing ${pendingAnalysis.length} queued analysis requests`);
        
        // Process each queued request sequentially with full error handling
        for (const { resolve, filePath } of pendingAnalysis) {
            try {
                console.log('[MAIN] Processing queued analysis:', filePath);
                const result = await analyzeMp3(filePath, mainWindow, settings.ollamaModel, settings.dbFolder, settings);
                console.log('[MAIN] Queued analysis complete:', result.jsonPath);
                
                // v1.2.0: Skip DB update if background processing is active (background function handles it)
                if (!result.backgroundProcessing) {
                    // Upsert into Main DB and optionally update criteria
                    try {
                        if (!dbPaths) await resolveDbPaths();
                        const dbResult = await DB.upsertTrack(dbPaths, result.analysis);
                        console.log('[MAIN] DB updated:', dbResult.key, 'Total tracks:', dbResult.total);
                        if (settings.autoUpdateDb) {
                            const criteriaResult = await DB.rebuildCriteria(dbPaths);
                            console.log('[MAIN] Criteria auto-updated:', criteriaResult.counts);
                        }
                    } catch (e) {
                        console.error('[MAIN] DB upsert failed:', e);
                    }
                } else {
                    console.log('[MAIN] Skipping DB update for queued (background processing active)');
                }
                
                resolve({ success: true, ...result });
            } catch (error) {
                console.error('[MAIN] Queued analysis error:', error);
                resolve({ success: false, error: error.message });
            }
        }
        pendingAnalysis.length = 0;
    }
});

const createWindow = () => {
    const win = new BrowserWindow({
        width: 1200,
        height: 980,  // Tall enough for 10 cards comfortably
        icon: path.join(app.getAppPath(), 'app', 'assets', 'icon.png'),
        webPreferences: {
            preload: path.join(app.getAppPath(), 'app', 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    win.loadFile(path.join(app.getAppPath(), 'app', 'renderer.html'));
    
    // v3.3.0: Store window reference for module-level listener
    mainWindow = win;
    
    // v3.3.0: Backup timeout - mark ready if signal not received within 5 seconds
    setTimeout(() => {
        if (!rendererReady) {
            console.log('[MAIN] Renderer ready timeout - assuming ready');
            rendererReady = true;
        }
    }, 5000);
    
    // Register IPC handler for drag-drop
    ipcMain.handle('scanDropped', async (event, { paths }) => {
        console.log('[MAIN] scanDropped:', paths.length, 'paths');
        const tracks = [];
        const seen = new Set();
        for (const filePath of paths) {
            try {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    const files = await scanDirectory(filePath);
                    for (const file of files) {
                        const basename = path.basename(file, path.extname(file)).toLowerCase();
                        if (!seen.has(basename)) {
                            seen.add(basename);
                            const hasAnalysis = hasExistingAnalysis(file);
                            tracks.push({
                                path: file,
                                fileName: path.basename(file),
                                status: hasAnalysis ? 'RE-ANALYZE' : 'QUEUED',
                                hasExistingAnalysis: hasAnalysis
                            });
                        }
                    }
                } else if (stat.isFile()) {
                    const ext = path.extname(filePath).toLowerCase();
                    if (['.mp3', '.wav', '.aif', '.aiff'].includes(ext)) {
                        const basename = path.basename(filePath, ext).toLowerCase();
                        if (!seen.has(basename)) {
                            seen.add(basename);
                            const hasAnalysis = hasExistingAnalysis(filePath);
                            tracks.push({
                                path: filePath,
                                fileName: path.basename(filePath),
                                status: hasAnalysis ? 'RE-ANALYZE' : 'QUEUED',
                                hasExistingAnalysis: hasAnalysis
                            });
                        }
                    }
                }
            } catch (err) {
                console.error('[MAIN] Error processing:', filePath, err);
            }
        }
        return { tracks };
    });
    
    // Register IPC handlers
    ipcMain.handle('getSettings', async () => {
        return settings;
    });
    // Installed Ollama models
    ipcMain.handle('getInstalledModels', async () => {
        return getInstalledModels();
    });
    
    ipcMain.handle('updateSettings', async (event, newSettings) => {
        settings = { ...settings, ...newSettings };
        console.log('[MAIN] Settings updated:', settings);
        await saveSettings();
        await resolveDbPaths();
        return { success: true };
    });
    
    ipcMain.handle('chooseFolder', async () => {
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
        return { folder: result.canceled ? null : result.filePaths[0] };
    });
    
    ipcMain.handle('updateDatabase', async () => {
        try {
            if (!dbPaths) await resolveDbPaths();
            const summary = await DB.getSummary(dbPaths);
            console.log('[MAIN] DB summary:', summary);
            return { success: true, summary };
        } catch (e) {
            console.error('[MAIN] updateDatabase error:', e);
            return { success: false, error: String(e) };
        }
    });
    
    ipcMain.handle('updateCriteriaDb', async () => {
        try {
            if (!dbPaths) await resolveDbPaths();
            const result = await DB.rebuildCriteria(dbPaths);
            console.log('[MAIN] Criteria rebuilt:', result);
            return { success: true, ...result };
        } catch (e) {
            console.error('[MAIN] updateCriteriaDb error:', e);
            return { success: false, error: String(e) };
        }
    });
    
    ipcMain.handle('runHealthCheck', async () => {
        return { ffprobe: true, ffmpeg: true, ollama: false };
    });
    
    
    // FFmpeg analysis handler
    ipcMain.handle('analyzeFile', async (event, filePath) => {
        try {
            // v3.3.0: Wait for renderer to be ready before starting analysis
            if (!rendererReady) {
                console.log('[MAIN] Renderer not ready, queuing analysis for:', filePath);
                return new Promise((resolve) => {
                    pendingAnalysis.push({ filePath, resolve });
                    // The promise will be resolved when renderer:ready fires
                });
            }
            
            console.log('[MAIN] Analyzing:', filePath);
            // Pass mainWindow to send progress events
            const { analyzeMp3 } = require('./analysis/ffcalc.js');
            const result = await analyzeMp3(filePath, mainWindow, settings.ollamaModel, settings.dbFolder, settings);
            console.log('[MAIN] Analysis complete:', result.jsonPath);
            
            // v1.2.0: Skip DB update if background processing is active (background function handles it)
            if (!result.backgroundProcessing) {
                // Upsert into Main DB and optionally update criteria
                try {
                    if (!dbPaths) await resolveDbPaths();
                    const dbResult = await DB.upsertTrack(dbPaths, result.analysis);
                    console.log('[MAIN] DB updated:', dbResult.key, 'Total tracks:', dbResult.total);
                    if (settings.autoUpdateDb) {
                        const criteriaResult = await DB.rebuildCriteria(dbPaths);
                        console.log('[MAIN] Criteria auto-updated:', criteriaResult.counts);
                    }
                } catch (e) {
                    console.error('[MAIN] DB upsert failed:', e);
                }
            } else {
                console.log('[MAIN] Skipping DB update (background processing active - will update when complete)');
            }
            return { success: true, ...result };
        } catch (error) {
            console.error('[MAIN] Analysis failed:', error);
            return { success: false, error: error.message };
        }
    });
    
    // Search IPC handlers
    ipcMain.handle('search:getDB', async () => {
        try {
            const dbFolder = settings.dbFolder || path.join(app.getPath('userData'), 'RhythmDNA');
            const criteriaPath = path.join(dbFolder, 'CriteriaDB.json');
            const rhythmPath = path.join(dbFolder, 'RhythmDB.json');
            
            if (!fs.existsSync(criteriaPath) || !fs.existsSync(rhythmPath)) {
                return { success: false, error: 'Database files not found' };
            }
            
            const criteria = JSON.parse(await fsPromises.readFile(criteriaPath, 'utf8'));
            const rhythm = JSON.parse(await fsPromises.readFile(rhythmPath, 'utf8'));
            
            return { success: true, criteria, rhythm };
        } catch (e) {
            console.error('[MAIN] search:getDB error:', e);
            return { success: false, error: e.message };
        }
    });
    
    ipcMain.handle('search:showFile', async (_e, filePath) => {
        shell.showItemInFolder(filePath);
        return { success: true };
    });
    
    ipcMain.handle('search:getVersions', async (_e, filePath) => {
        try {
            const dir = path.dirname(filePath);
            const base = path.basename(filePath, path.extname(filePath));
            const root = base.replace(/\s*\([^)]*\)\s*/g, '').toLowerCase();
            
            const files = await fsPromises.readdir(dir);
            const versions = files.filter(f => {
                const name = path.basename(f, path.extname(f)).toLowerCase();
                return name.includes(root);
            });
            
            const exts = versions.map(f => path.extname(f).toLowerCase());
            return {
                success: true,
                count: versions.length,
                hasWav: exts.includes('.wav'),
                hasMp3: exts.includes('.mp3')
            };
        } catch (e) {
            return { success: false, count: 1 };
        }
    });
    
    ipcMain.handle('search:readJson', async (_e, absPath) => {
        const data = await fsPromises.readFile(absPath, 'utf8');
        return JSON.parse(data);
    });
    
    // Waveform PNG generation with lazy require to avoid circular imports
    // SMB auto-mount handler for NAS shares
    ipcMain.handle('system:ensure-mounted', async (_evt, mountPoint, smbUrl) => {
        const fs = require('fs');
        const { execFile } = require('child_process');
        
        try {
            // Check if already mounted
            if (fs.existsSync(mountPoint)) {
                return { ok: true, already: true };
            }
            
            // Use AppleScript to mount SMB share (uses Keychain for auth)
            await new Promise((resolve, reject) => {
                const script = `try
                    mount volume "${smbUrl}"
                end try`;
                
                execFile('/usr/bin/osascript', ['-e', script], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            
            // Check if mount succeeded
            const ok = fs.existsSync(mountPoint);
            return { ok };
        } catch (e) {
            console.log('[SMB] Mount failed:', e.message);
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('waveform:get-png', async (_evt, absPath, opts = {}) => {
        try {
            const path = require('node:path');
            
            // Always place PNGs alongside the DB, under 'waveforms' folder (plural)
            const dbRoot = settings.dbFolder || path.join(app.getPath('userData'), 'RhythmDNA');
            const cacheRoot = path.join(dbRoot, 'waveforms');  // NOTE: plural 'waveforms'
            
            // Use the analysis waveform generator for consistency
            const { ensureWaveformPng } = require('./analysis/waveform-png.js');
            const { pngPath } = await ensureWaveformPng(absPath, { 
                dbFolder: dbRoot,
                durationSec: null  // Will be calculated if needed
            });
            return { ok: true, png: pngPath };
        } catch (e) {
            console.error('[WAVEFORM IPC] Error:', e.message);
            return { ok: false, error: e.message };
        }
    });
};

app.whenReady().then(() => {
    loadSettings().then(() => {
        // Add Homebrew binaries to PATH for packaged app
        // This allows ffprobe/ffmpeg/python3 to be found from system installation
        if (app.isPackaged) {
            process.env.PATH = `/opt/homebrew/bin:${process.env.PATH}`;
            console.log('[MAIN] Added Homebrew to PATH for packaged app');
        }
        
        // Set dock icon for macOS
        if (process.platform === 'darwin') {
            const iconPath = path.join(app.getAppPath(), 'app', 'assets', 'icon.png');
            if (fs.existsSync(iconPath)) {
                app.dock.setIcon(iconPath);
            }
        }
        
        createWindow();
        resolveDbPaths();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // Always quit when window is closed (including on macOS)
    app.quit();
});

// Cleanup log stream on app quit - DISABLED: File logging turned off
// To re-enable: Uncomment the code below
/*
app.on('before-quit', () => {
    console.log('=== Rhythm DNA v4 Terminal Log Ended ===');
    if (logStream) {
        logStream.end();
    }
});

// Handle process termination
process.on('exit', () => {
    if (logStream) {
        logStream.end();
    }
});

process.on('SIGINT', () => {
    console.log('=== App terminated by SIGINT ===');
    if (logStream) {
        logStream.end();
    }
    process.exit(0);
});
*/

// DISABLED: Terminal file logging cleanup - keeping console output only
app.on('before-quit', () => {
    console.log('=== Rhythm DNA v4 Shutdown (File Logging Disabled) ===');
});

process.on('SIGINT', () => {
    console.log('=== App terminated by SIGINT ===');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('=== App terminated by SIGTERM ===');
    process.exit(0);
});



