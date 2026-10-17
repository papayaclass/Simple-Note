import { app, BrowserWindow, ipcMain } from 'electron';
import type { OpenDocumentPayload } from '../preload';

// A token identifies one drag, while the source document stays in its renderer
// until the destination has loaded it. No document content goes on the dragboard.
export function registerTabTransfers(): void {
  let drag: { token: string; tabId: string; source: BrowserWindow } | null = null;

  const broadcast = (active: boolean): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('window:tabDragState', active);
    }
  };

  app.on('browser-window-created', (_event, win) => {
    win.on('closed', () => {
      if (drag?.source !== win) return;
      drag = null;
      broadcast(false);
    });
  });

  ipcMain.on('window:beginTabDrag', (event, token: string, tabId: string) => {
    const source = BrowserWindow.fromWebContents(event.sender);
    if (!source || typeof token !== 'string' || typeof tabId !== 'string') return;
    drag = { token, tabId, source };
    broadcast(true);
  });

  ipcMain.on('window:endTabDrag', (event, token: string) => {
    if (drag?.token !== token || drag.source.webContents !== event.sender) return;
    broadcast(false);
    // Keep the one token until the next drag or window close: dragend in the
    // source can arrive before the target's drop IPC in another renderer.
  });

  ipcMain.handle('window:moveTabHere', async (event, token: string, paneId: string, index: number) => {
    const target = BrowserWindow.fromWebContents(event.sender);
    const current = drag;
    if (!current || current.token !== token || !target || current.source === target ||
        typeof paneId !== 'string' || !Number.isInteger(index)) return false;
    drag = null; // A drag can be consumed only once.
    broadcast(false);
    const { source, tabId } = current;
    try {
      if (source.isDestroyed()) return false;
      const snapshot: OpenDocumentPayload | null = await source.webContents.executeJavaScript(
        `window.__simpleNote_snapshotTab?.(${JSON.stringify(tabId)}) ?? null`
      );
      if (!snapshot || target.isDestroyed()) return false;
      const received: boolean = await target.webContents.executeJavaScript(
        `window.__simpleNote_receiveTab?.(${JSON.stringify(snapshot)}, ${JSON.stringify(paneId)}, ${index}) ?? false`
      );
      if (!received) return false;
      if (!source.isDestroyed()) {
        const finished: { empty: boolean } | null = await source.webContents.executeJavaScript(
          `window.__simpleNote_finishTabTransfer?.(${JSON.stringify(tabId)}, ${JSON.stringify(snapshot)}) ?? null`
        );
        if (!finished) return false;
        if (finished.empty) source.close();
      }
      if (!target.isDestroyed()) {
        if (target.isMinimized()) target.restore();
        target.show();
        target.focus();
      }
      return true;
    } catch (error) {
      console.error('Failed to move tab between windows:', error);
      return false;
    }
  });
}
