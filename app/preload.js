const { contextBridge, ipcRenderer } = require('electron');

console.log('[PRELOAD] Loading preload script');

contextBridge.exposeInMainWorld('api', {
    // File operations (needed by dragdrop.js)
    scanDropped: (paths) => ipcRenderer.invoke('scanDropped', { paths }),
    analyzeFile: (filePath) => ipcRenderer.invoke('analyzeFile', filePath),
    
    // Settings (these are fine to keep)
    getSettings: () => ipcRenderer.invoke('getSettings'),
    updateSettings: (settings) => ipcRenderer.invoke('updateSettings', settings),
    chooseFolder: () => ipcRenderer.invoke('chooseFolder'),
    updateDatabase: () => ipcRenderer.invoke('updateDatabase'),
    updateCriteriaDb: () => ipcRenderer.invoke('updateCriteriaDb'),
    runHealthCheck: () => ipcRenderer.invoke('runHealthCheck'),
    
    // Search methods (needed by search functionality)
    searchGetDB: () => ipcRenderer.invoke('search:getDB'),
    searchShowFile: (path) => ipcRenderer.invoke('search:showFile', path),
    searchGetVersions: (path) => ipcRenderer.invoke('search:getVersions', path),
    searchReadJson: (path) => ipcRenderer.invoke('search:readJson', path),
    getWaveformPng: (absPath, options) => ipcRenderer.invoke('waveform:get-png', absPath, options),
    ensureMounted: (mountPoint, smbUrl) => ipcRenderer.invoke('system:ensure-mounted', mountPoint, smbUrl),
    
    // Event listeners for the REAL analysis system
    onQueueUpdate: (callback) => {
        ipcRenderer.on('queueUpdate', callback);
    },
    onJobProgress: (callback) => {
        ipcRenderer.on('jobProgress', callback);
    },
    onJobDone: (callback) => {
        ipcRenderer.on('jobDone', callback);
    },
    onJobError: (callback) => {
        ipcRenderer.on('jobError', callback);
    },
    onLog: (callback) => {
        ipcRenderer.on('log', callback);
    },
    
    // v3.1.0: Instrumentation orchestration - pass only payload
    onStartInstrumentation: (callback) => {
        ipcRenderer.on('analysis:instrumentation:start', (_e, payload) => callback(payload));
    },
    
    // v3.1.0: Instrumentation events - pass only payload
    instrumentation: {
        onProgress: (callback) => {
            ipcRenderer.on('instrumentation:progress', (_e, payload) => {
                console.log('[PRELOAD] instrumentation:progress received:', payload);
                callback(payload);
            });
        },
        onStart: (callback) => {
            ipcRenderer.on('analysis:instrumentation:start', (_e, payload) => {
                console.log('[PRELOAD] analysis:instrumentation:start received:', payload);
                callback(payload);
            });
        }
    }
});

console.log('[PRELOAD] API exposed');


