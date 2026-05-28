import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import Store from 'electron-store';
import { buildMenu } from './menu.js';
import { getPreferences, setPreference, setAllPreferences } from './preferences.js';
import { getRate, clearRateCache } from './exchange-rate.js';

app.setName('Simple Note');

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1024, height: 768 };

const windowStore = new Store<{ bounds: WindowBounds }>({
  name: 'window-state',
  defaults: { bounds: DEFAULT_BOUNDS },
});

let mainWindow: BrowserWindow | null = null;
let currentFilePath: string | null = null;

// Accept the saved bounds as long as they overlap any connected display at
// all. The previous check rejected perfectly valid bounds whenever the user's
// display setup at restore time differed from save time (e.g. unplugged a
// second monitor) — which silently reset the window to default.
function intersectsAnyDisplay(b: WindowBounds): boolean {
  if (b.x === undefined || b.y === undefined) return false;
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const ix = Math.min(b.x! + b.width, wa.x + wa.width) - Math.max(b.x!, wa.x);
    const iy = Math.min(b.y! + b.height, wa.y + wa.height) - Math.max(b.y!, wa.y);
    return ix > 0 && iy > 0;
  });
}

function getRestoredBounds(): WindowBounds {
  const saved = windowStore.get('bounds', DEFAULT_BOUNDS);
  if (intersectsAnyDisplay(saved)) return saved;
  return { width: saved.width, height: saved.height };
}

function persistBounds(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized() || mainWindow.isFullScreen()) return;
  windowStore.set('bounds', mainWindow.getNormalBounds());
}

function createWindow(): void {
  const bounds = getRestoredBounds();

  mainWindow = new BrowserWindow({
    ...bounds,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistBounds, 300);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  // Synchronous save BEFORE the async dirty-check listener below runs, so the
  // bounds are flushed to disk even if the user cancels close from the dialog.
  mainWindow.on('close', persistBounds);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('close', async (e) => {
    if (!mainWindow) return;
    const dirty = await mainWindow.webContents.executeJavaScript('window.__simpleNote_isDirty?.() ?? false');
    if (!dirty) return;
    e.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['儲存', '不儲存', '取消'],
      defaultId: 0,
      cancelId: 2,
      message: '是否要將變更儲存？',
      detail: '若不儲存，所有未儲存的變更會遺失。',
    });
    if (result.response === 0) {
      const saved = await mainWindow.webContents.executeJavaScript('window.__simpleNote_save?.()');
      if (saved) mainWindow.destroy();
    } else if (result.response === 1) {
      mainWindow.destroy();
    }
  });
}

// Safety net for Cmd+Q / app.quit() paths where the window's close handler
// may race with process exit.
app.on('before-quit', persistBounds);

app.whenReady().then(() => {
  buildMenu({
    onNew: () => mainWindow?.webContents.send('menu:new'),
    onOpen: () => mainWindow?.webContents.send('menu:open'),
    onSave: () => mainWindow?.webContents.send('menu:save'),
    onExportMarkdown: () => mainWindow?.webContents.send('menu:export-md'),
    onPreferences: () => mainWindow?.webContents.send('menu:preferences'),
    onCommand: (cmd) => mainWindow?.webContents.send('menu:command', cmd),
  });

  ipcMain.handle('prefs:get', () => getPreferences());
  ipcMain.handle('prefs:set', (_e, key: string, value: unknown) => setPreference(key, value));
  ipcMain.handle('prefs:setAll', (_e, prefs: Record<string, unknown>) => setAllPreferences(prefs));

  ipcMain.handle('rate:get', async (_e, currency: string) => getRate(currency));
  ipcMain.handle('rate:clear', () => clearRateCache());

  ipcMain.handle('file:save', async (_e, payload: string, suggestedName?: string) => {
    let path = currentFilePath;
    if (!path) {
      const r = await dialog.showSaveDialog(mainWindow!, {
        defaultPath: suggestedName ?? '未命名筆記.sn',
        filters: [{ name: 'Simple Note', extensions: ['sn'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false };
      path = r.filePath;
    }
    await writeFile(path, payload, 'utf-8');
    currentFilePath = path;
    mainWindow?.setRepresentedFilename(path);
    mainWindow?.setTitle(path.split('/').pop() ?? 'Simple Note');
    mainWindow?.setDocumentEdited(false);
    return { ok: true, path };
  });

  ipcMain.handle('file:open', async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Simple Note', extensions: ['sn'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    const text = await readFile(r.filePaths[0], 'utf-8');
    currentFilePath = r.filePaths[0];
    mainWindow?.setRepresentedFilename(currentFilePath);
    mainWindow?.setTitle(currentFilePath.split('/').pop() ?? 'Simple Note');
    mainWindow?.setDocumentEdited(false);
    return { ok: true, path: currentFilePath, content: text };
  });

  ipcMain.handle('file:exportMarkdown', async (_e, markdown: string, suggestedName?: string) => {
    const r = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: suggestedName ?? '未命名筆記.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    await writeFile(r.filePath, markdown, 'utf-8');
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('file:new', () => {
    currentFilePath = null;
    mainWindow?.setRepresentedFilename('');
    mainWindow?.setTitle('未命名筆記');
    mainWindow?.setDocumentEdited(false);
  });

  ipcMain.on('window:setDirty', (_e, dirty: boolean) => {
    mainWindow?.setDocumentEdited(dirty);
  });

  ipcMain.on('window:setTitle', (_e, title: string) => {
    mainWindow?.setTitle(title);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
