import { app, BrowserWindow, ipcMain, screen } from 'electron';
import type { OpenDocumentPayload } from '../preload';

// Where the cursor lands on a torn-off window: over its first tab.
export const TEAR_OFF_OFFSET = { x: 140, y: 18 };

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

  // Returns the screen point when the tab was released outside every window,
  // so the source renderer can tear it off into a new window there (like
  // Chrome). The drag is consumed then; otherwise the token stays for a drop
  // IPC that may still arrive from another renderer.
  ipcMain.handle('window:endTabDrag', (event, token: string) => {
    if (drag?.token !== token || drag.source.webContents !== event.sender) return null;
    broadcast(false);
    const point = screen.getCursorScreenPoint();
    const overWindow = BrowserWindow.getAllWindows().some((win) => {
      if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return false;
      const b = win.getBounds();
      return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
    });
    if (overWindow) return null;
    drag = null;
    return point;
  });

  // Dragging a window's only tab out moves the window itself.
  ipcMain.on('window:moveToPoint', (event, x: number, y: number) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !Number.isFinite(x) || !Number.isFinite(y)) return;
    win.setPosition(Math.round(x - TEAR_OFF_OFFSET.x), Math.round(y - TEAR_OFF_OFFSET.y));
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
