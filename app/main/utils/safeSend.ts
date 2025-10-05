import { BrowserWindow } from 'electron';

export function safeSend(channel: string, payload: any) {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch {
    // swallow; UI may not be ready yet
  }
}
