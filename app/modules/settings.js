// Settings Store - uses electron-store, schema-validated

export class SettingsStore {
    constructor() {
        console.log('SettingsStore module initialized');
    }
    
    // TODO: Implement settings persistence
    // - Database folder path
    // - Auto-update checkbox
    // - Creative model selection
    // - Concurrency settings
}

// Hidden env-backed setting to enable diagnostics
export function isInstrumentDiagEnabled() {
    return !!process.env.RNA_DIAG_INSTRUMENTS;
}


