import { ipcMain } from 'electron';
// Ensure there is a central forwarder if TECH/INSTR already use it; Creative reuses the same.
// Nothing else required here if renderer subscribes directly to 'pipeline:status'.
