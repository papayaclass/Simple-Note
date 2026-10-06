import { app, BrowserWindow, ipcMain, dialog, shell, screen } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import Store from 'electron-store';
import { buildMenu } from './menu.js';
import { getPreferences, setPreference, setAllPreferences } from './preferences.js';
import { getYouTubePreview } from './youtube-preview.js';
import { runAI } from './openrouter.js';
import {
  pickVault,
  getVault,
  clearVault,
  listVault,
  readMarkdown,
  createFile,
  createBlankNote,
  createFolder,
  renameEntry,
  deleteEntry,
  duplicateEntry,
  moveEntry,
  revealEntry,
  moveToVault,
  startWatching,
  importExternal,
  saveImageForNote,
  readImageAsDataUrl,
  openSelf,
} from './vault.js';

app.setName('Simple Note');

// A document is written in its plain form only when the target file is a
// Markdown / plain-text / CSV file; everything else (`.snote`, `.ssheet`) gets
// the app's own lossless format. See src/renderer/src/noteFormat.ts and
// src/renderer/src/sheet/sheetFormat.ts. For spreadsheets `markdown` carries
// the CSV text and `snote` the Simple Sheet JSON.
interface NoteContents {
  markdown: string;
  snote: string;
}

function contentForPath(path: string, contents: NoteContents): string {
  const ext = extname(path).toLowerCase();
  return ext === '.md' || ext === '.txt' || ext === '.csv' ? contents.markdown : contents.snote;
}

const NOTE_FILTERS = [
  { name: 'Simple Note', extensions: ['snote'] },
  { name: 'Markdown', extensions: ['md'] },
];

const SHEET_FILTERS = [
  { name: 'Simple Sheet', extensions: ['ssheet'] },
  { name: 'CSV', extensions: ['csv'] },
];

// Save dialogs offer the formats matching the suggested file's kind.
function filtersFor(name: string | undefined): typeof NOTE_FILTERS {
  return name && /\.(ssheet|csv)$/i.test(name) ? SHEET_FILTERS : NOTE_FILTERS;
}

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

// True while a Cmd+Q / app.quit() is in progress. Each window's close handler
// always preventDefault()s to run an async dirty-check, which cancels the quit
// sequence. We use this flag to re-issue app.quit() once it's safe to close, so
// the process actually exits instead of lingering as a windowless background
// app (which keeps showing in the Dock / App Switcher).
let isQuitting = false;
let lastActiveWindow: BrowserWindow | null = null;

// Files double-clicked in Finder before the app finished launching. macOS
// delivers them via 'open-file' (argv won't carry the path on GUI launches),
// possibly before app.whenReady — we buffer them and open them as tabs once the
// app is ready.
const coldStartPaths: string[] = [];

// File paths waiting to be loaded into a specific window, keyed by that
// window's webContents id. We can't push the content until the renderer has
// mounted its listeners; it flushes when the renderer sends 'renderer:ready'.
const pendingOpenByWebContents = new Map<number, string[]>();
const readyWebContents = new Set<number>();
const startupOpenResults = new Map<number, Promise<boolean>>();

function queuePathForWindow(win: BrowserWindow, path: string): void {
  const wcId = win.webContents.id;
  const pending = pendingOpenByWebContents.get(wcId) ?? [];
  pending.push(path);
  pendingOpenByWebContents.set(wcId, pending);
}

async function deliverPathToWindow(win: BrowserWindow | null, path: string): Promise<boolean> {
  if (!win || win.isDestroyed()) return false;
  try {
    const content = await readFile(path, 'utf-8');
    win.setRepresentedFilename(path);
    win.setTitle(path.split('/').pop() ?? 'Simple Note');
    win.webContents.send('file:openInTab', { path, content });
    return true;
  } catch (err) {
    console.error('Failed to read external file:', path, err);
    return false;
  }
}

async function flushPendingPaths(win: BrowserWindow | null): Promise<boolean> {
  if (!win || win.isDestroyed()) return false;
  const wcId = win.webContents.id;
  const paths = pendingOpenByWebContents.get(wcId) ?? [];
  pendingOpenByWebContents.delete(wcId);
  let opened = false;
  for (const path of paths) {
    if (await deliverPathToWindow(win, path)) opened = true;
  }
  return opened;
}

function bringWindowForward(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openPathInExistingWindow(path: string): void {
  const windows = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed());
  const lastActive =
    lastActiveWindow && !lastActiveWindow.isDestroyed() ? lastActiveWindow : null;
  const target = BrowserWindow.getFocusedWindow() ?? lastActive ?? windows.at(-1) ?? null;
  if (!target) {
    createWindow(path);
    return;
  }
  bringWindowForward(target);
  if (!readyWebContents.has(target.webContents.id)) {
    queuePathForWindow(target, path);
    return;
  }
  void deliverPathToWindow(target, path);
}

// macOS delivers paths via 'open-file' (and only this — argv won't carry the
// file path on macOS GUI launches). Register inside will-finish-launching so we
// catch the very first event even when launched cold by double-clicking a file.
// Once the app is running, each opened file becomes a new tab in the existing
// window so it never replaces what's already being edited.
app.on('will-finish-launching', () => {
  app.on('open-file', (event, path) => {
    event.preventDefault();
    if (app.isReady()) {
      openPathInExistingWindow(path);
    } else {
      coldStartPaths.push(path);
    }
  });
});

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

// Place the first window at its saved bounds; cascade every subsequent window
// down-right from the current one so multiple windows don't stack exactly on
// top of each other.
function getNewWindowBounds(): WindowBounds {
  const ref = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(-1) ?? null;
  if (ref && !ref.isDestroyed()) {
    const b = ref.getNormalBounds();
    const cascaded: WindowBounds = {
      x: (b.x ?? 0) + 30,
      y: (b.y ?? 0) + 30,
      width: b.width,
      height: b.height,
    };
    if (intersectsAnyDisplay(cascaded)) return cascaded;
  }
  return getRestoredBounds();
}

function persistWindowBounds(win: BrowserWindow): void {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized() || win.isFullScreen()) return;
  // On macOS, a zoomed/maximized window keeps its previous size in
  // getNormalBounds(), so persist the actual visible bounds instead.
  windowStore.set('bounds', win.getBounds());
}

function createWindow(openPath?: string): BrowserWindow {
  const win = new BrowserWindow({
    ...getNewWindowBounds(),
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

  const wcId = win.webContents.id;
  if (openPath) queuePathForWindow(win, openPath);

  win.on('ready-to-show', () => {
    win.show();
  });

  win.on('focus', () => {
    lastActiveWindow = win;
  });

  win.on('closed', () => {
    if (lastActiveWindow === win) lastActiveWindow = null;
    pendingOpenByWebContents.delete(wcId);
    readyWebContents.delete(wcId);
    startupOpenResults.delete(wcId);
  });

  let saveTimer: NodeJS.Timeout | null = null;
  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persistWindowBounds(win), 300);
  };
  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  // Synchronous save BEFORE the async dirty-check listener below runs, so the
  // bounds are flushed to disk even if the user cancels close from the dialog.
  win.on('close', () => persistWindowBounds(win));

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // preventDefault() must run synchronously — once we `await`, the event loop
  // resumes and Electron has already proceeded with the close. Always prevent
  // first, then do the dirty check / dialog asynchronously, and `destroy()`
  // ourselves when it's safe to close.
  let forceClose = false;
  // Close the window for real. During a quit, re-issue app.quit() (our earlier
  // preventDefault cancelled it) so the process exits; otherwise just destroy
  // the window and leave the app running (standard macOS behaviour).
  const proceedClose = (): void => {
    forceClose = true;
    if (isQuitting) {
      app.quit();
    } else {
      win.destroy();
    }
  };
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    void (async () => {
      // Give the renderer a chance to ask about Markdown-incompatible
      // formatting (and convert those notes to .snote) before the dirty check.
      await win.webContents.executeJavaScript(
        'window.__simpleNote_beforeClose?.() ?? true'
      );
      if (win.isDestroyed()) return;
      const dirty = await win.webContents.executeJavaScript(
        'window.__simpleNote_isDirty?.() ?? false'
      );
      if (!dirty) {
        proceedClose();
        return;
      }
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['儲存', '不儲存', '取消'],
        defaultId: 0,
        cancelId: 2,
        message: '是否要將變更儲存？',
        detail: '若不儲存，所有未儲存的變更會遺失。',
      });
      if (result.response === 0) {
        const saved = await win.webContents.executeJavaScript('window.__simpleNote_save?.()');
        if (saved) {
          proceedClose();
        } else {
          isQuitting = false; // save cancelled / failed — abort any pending quit
        }
      } else if (result.response === 1) {
        proceedClose();
      } else {
        isQuitting = false; // user cancelled — abort any pending quit
      }
    })();
  });

  return win;
}

function sendToFocused(channel: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(channel);
}

// Print the focused window from the main process. The renderer's window.print()
// pops the macOS print panel but doesn't reliably dispatch the job to the
// printer (Electron disables Chromium's print-preview pipeline) and reports no
// failure. webContents.print() is the supported path and tells us why a job
// failed via its callback.
function printFocused(): void {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  try {
    win.webContents.print({ printBackground: true }, (success, failureReason) => {
      // "Print job canceled" just means the user dismissed the dialog.
      if (!success && failureReason && failureReason !== 'Print job canceled') {
        console.error('[print] failed:', failureReason);
        dialog.showErrorBox('列印失敗', `無法送出列印工作：${failureReason}`);
      }
    });
  } catch (err) {
    console.error('[print] threw:', err);
    dialog.showErrorBox('列印失敗', String(err instanceof Error ? err.message : err));
  }
}

// File → Open…: pick a file and open it as a new TAB in the focused window
// (Obsidian model). With no window open, fall back to spawning a fresh one.
async function openViaDialog(): Promise<void> {
  const focused = BrowserWindow.getFocusedWindow();
  const options = {
    properties: ['openFile' as const],
    filters: [
      {
        name: 'Simple Note / Simple Sheet / Markdown / CSV / Text',
        extensions: ['snote', 'ssheet', 'md', 'csv', 'txt'],
      },
    ],
  };
  const r = focused
    ? await dialog.showOpenDialog(focused, options)
    : await dialog.showOpenDialog(options);
  if (r.canceled || !r.filePaths[0]) return;
  const path = r.filePaths[0];
  if (focused && !focused.isDestroyed()) {
    const content = await readFile(path, 'utf-8').catch(() => null);
    if (content !== null) {
      focused.webContents.send('file:openInTab', { path, content });
      return;
    }
  }
  createWindow(path);
}

// File → New: open a fresh tab in the focused window, or a new window if none.
function newTabOrWindow(): void {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isDestroyed()) {
    focused.webContents.send('menu:new-tab');
  } else {
    createWindow();
  }
}

// Safety net for Cmd+Q / app.quit() paths where a window's close handler may
// race with process exit. Also flags that a quit is underway so close handlers
// re-issue app.quit() after their async dirty-check (see proceedClose).
app.on('before-quit', () => {
  isQuitting = true;
  const ref = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(-1) ?? null;
  if (ref) persistWindowBounds(ref);
});

function imageMimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/svg+xml':
      return 'svg';
    default:
      return mime.split('/')[1] ?? 'png';
  }
}

app.whenReady().then(() => {
  buildMenu({
    onNew: () => newTabOrWindow(),
    onOpen: () => void openViaDialog(),
    onSave: () => sendToFocused('menu:save'),
    onPrint: () => printFocused(),
    onPreferences: () => sendToFocused('menu:preferences'),
    onCommand: (cmd) => BrowserWindow.getFocusedWindow()?.webContents.send('menu:command', cmd),
  });

  ipcMain.handle('prefs:get', () => getPreferences());
  ipcMain.handle('prefs:set', (_e, key: string, value: unknown) => setPreference(key, value));
  ipcMain.handle('prefs:setAll', (_e, prefs: Record<string, unknown>) => setAllPreferences(prefs));

  // Vault / file-management IPC.
  ipcMain.handle('vault:pick', (e) => pickVault(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('vault:get', () => getVault());
  ipcMain.handle('vault:clear', () => clearVault());
  ipcMain.handle('vault:list', () => listVault());
  ipcMain.handle('vault:read', (_e, path: string) => readMarkdown(path));
  ipcMain.handle('vault:createFile', (_e, dir?: string | null, kind?: 'note' | 'sheet') =>
    createFile(dir, kind)
  );
  ipcMain.handle('vault:createBlankNote', () => createBlankNote());
  ipcMain.handle('vault:createFolder', (_e, dir?: string | null) => createFolder(dir));
  ipcMain.handle('vault:rename', (_e, path: string, newName: string) => renameEntry(path, newName));
  ipcMain.handle('vault:delete', (_e, path: string) => deleteEntry(path));
  ipcMain.handle('vault:duplicate', (_e, path: string) => duplicateEntry(path));
  ipcMain.handle('vault:move', (_e, src: string, destDir: string) => moveEntry(src, destDir));
  ipcMain.handle('vault:reveal', (_e, path: string) => revealEntry(path));
  ipcMain.handle('vault:moveToVault', (e, contents: NoteContents, suggestedName?: string) =>
    moveToVault(BrowserWindow.fromWebContents(e.sender), contents, suggestedName)
  );
  ipcMain.handle('vault:importExternal', (_e, paths: string[], destDir: string | null) =>
    importExternal(paths, destDir)
  );
  ipcMain.handle(
    'vault:saveImageForNote',
    (_e, args: { notePath: string | null; sourcePath?: string; dataUrl?: string }) =>
      saveImageForNote(args)
  );
  ipcMain.handle('vault:readImageAsDataUrl', (_e, noteDir: string | null, src: string) =>
    readImageAsDataUrl(noteDir, src)
  );
  ipcMain.handle('vault:openSelf', () => openSelf());
  // "Open in new window" from a tab's context menu.
  ipcMain.on('window:openFile', (_e, path: string) => createWindow(path));

  ipcMain.on('window:close', (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });

  // Start watching the saved vault (if any) so external changes push updates.
  startWatching(getVault());

  ipcMain.handle('youtube:preview', async (_e, videoId: string) => getYouTubePreview(videoId));

  ipcMain.handle('ai:run', async (_e, userContent: string) => runAI(userContent));

  ipcMain.handle(
    'file:save',
    async (e, contents: NoteContents, options: { path: string | null; suggestedName?: string }) => {
      // The renderer is the source of truth for the current file path; main no
      // longer tracks it (with multiple windows there'd be many). Operate on the
      // window that sent the request.
      const win = BrowserWindow.fromWebContents(e.sender);
      let path = options?.path ?? null;
      if (!path) {
        const saveOptions = {
          defaultPath: options?.suggestedName ?? '未命名筆記.snote',
          filters: filtersFor(options?.suggestedName),
        };
        const r = win
          ? await dialog.showSaveDialog(win, saveOptions)
          : await dialog.showSaveDialog(saveOptions);
        if (r.canceled || !r.filePath) return { ok: false };
        path = r.filePath;
      }
      await writeFile(path, contentForPath(path, contents), 'utf-8');
      win?.setRepresentedFilename(path);
      win?.setTitle(path.split('/').pop() ?? 'Simple Note');
      win?.setDocumentEdited(false);
      return { ok: true, path };
    }
  );

  // "另存新檔": export a copy of the note to an arbitrary location, defaulting to
  // the Downloads folder. Unlike file:save this never rebinds the tab (the
  // renderer keeps its own path), so the window's represented file is untouched.
  ipcMain.handle('file:saveAs', async (e, contents: NoteContents, suggestedName?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const name = suggestedName ?? '未命名筆記.snote';
    const saveOptions = {
      defaultPath: join(app.getPath('downloads'), name),
      filters: filtersFor(name),
    };
    const r = win
      ? await dialog.showSaveDialog(win, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (r.canceled || !r.filePath) return { ok: false };
    await writeFile(r.filePath, contentForPath(r.filePath, contents), 'utf-8');
    return { ok: true, path: r.filePath };
  });

  // "匯出成 MD 文件" / "匯出成 CSV 文件": write the plain copy of a `.snote` /
  // `.ssheet` document, defaulting to the Downloads folder. The tab keeps
  // pointing at its own file.
  ipcMain.handle('file:exportMarkdown', async (e, markdown: string, suggestedName?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const name = suggestedName ?? '未命名筆記.md';
    const saveOptions = {
      defaultPath: join(app.getPath('downloads'), name),
      filters: name.toLowerCase().endsWith('.csv')
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : [{ name: 'Markdown', extensions: ['md'] }],
    };
    const r = win
      ? await dialog.showSaveDialog(win, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (r.canceled || !r.filePath) return { ok: false };
    await writeFile(r.filePath, markdown, 'utf-8');
    return { ok: true, path: r.filePath };
  });

  // Convert a Markdown note that gained Markdown-incompatible formatting into a
  // `.snote` beside it (a `.csv` sheet with formulas / styling into a
  // `.ssheet`); the original goes to the Trash (recoverable).
  ipcMain.handle('file:convertToSnote', async (_e, path: string, snote: string) => {
    try {
      const target = /\.csv$/i.test(path)
        ? path.replace(/\.csv$/i, '') + '.ssheet'
        : path.replace(/\.(md|txt)$/i, '') + '.snote';
      await writeFile(target, snote, 'utf-8');
      if (target !== path) await shell.trashItem(path);
      return { ok: true, path: target };
    } catch (err) {
      console.error('[convert] failed:', err);
      return { ok: false };
    }
  });

  // Ask before losing formatting: on close (offer to convert to .snote) and on
  // Markdown export (the copy will be missing these features).
  ipcMain.handle(
    'file:confirmLossy',
    async (
      e,
      kind: 'convert' | 'export',
      name: string,
      features: string[],
      doc: 'note' | 'sheet' = 'note'
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const list = features.length > 0 ? features.join('、') : '特殊格式';
      const options =
        kind === 'convert' && doc === 'sheet'
          ? {
              type: 'warning' as const,
              buttons: ['轉存為 .ssheet', '維持 CSV'],
              defaultId: 0,
              cancelId: 1,
              message: `「${name}」含有 CSV 不支援的內容`,
              detail: `此試算表使用了 ${list}，以 CSV 儲存時公式只會留下計算結果，顏色與文字樣式也會遺失。要改存成 Simple Sheet 格式 (.ssheet) 嗎？原本的 .csv 檔會移到垃圾桶。`,
            }
          : kind === 'convert'
          ? {
              type: 'warning' as const,
              buttons: ['轉存為 .snote', '維持 Markdown'],
              defaultId: 0,
              cancelId: 1,
              message: `「${name}」含有 Markdown 不支援的格式`,
              detail: `此文件使用了 ${list}，以 Markdown 儲存會遺失這些內容。要改存成 Simple Note 格式 (.snote) 嗎？原本的 .md 檔會移到垃圾桶。`,
            }
          : {
              type: 'warning' as const,
              buttons: ['繼續匯出', '取消'],
              defaultId: 0,
              cancelId: 1,
              message: `「${name}」含有 Markdown 不支援的格式`,
              detail: `此文件使用了 ${list}，匯出的 .md 檔不會包含這些內容（原始文件不受影響）。`,
            };
      const r = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      return r.response === 0;
    }
  );

  // Save an in-editor image (a data URL) to disk. Images are never persisted in
  // the .md, so this is the only way to keep one — invoked from the preview
  // lightbox's "另存新檔…" command.
  ipcMain.handle('file:saveImage', async (e, dataUrl: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(dataUrl);
    if (!m) return { ok: false };
    const ext = imageMimeToExt(m[1]!);
    const saveOptions = {
      defaultPath: `圖片.${ext}`,
      filters: [{ name: 'Image', extensions: [ext] }],
    };
    const r = win
      ? await dialog.showSaveDialog(win, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (r.canceled || !r.filePath) return { ok: false };
    await writeFile(r.filePath, Buffer.from(m[2]!, 'base64'));
    return { ok: true, path: r.filePath };
  });

  ipcMain.on('window:setDirty', (e, dirty: boolean) => {
    BrowserWindow.fromWebContents(e.sender)?.setDocumentEdited(dirty);
  });

  ipcMain.on('window:setTitle', (e, title: string) => {
    BrowserWindow.fromWebContents(e.sender)?.setTitle(title);
  });

  // A window's renderer signals it has mounted listeners; flush the file (if
  // any) that was queued for that specific window.
  ipcMain.handle('renderer:ready', (e) => {
    readyWebContents.add(e.sender.id);
    let result = startupOpenResults.get(e.sender.id);
    if (!result) {
      result = flushPendingPaths(BrowserWindow.fromWebContents(e.sender));
      startupOpenResults.set(e.sender.id, result);
    }
    return result;
  });

  // Open files double-clicked before launch as tabs in a single window;
  // otherwise start with a single blank window.
  if (coldStartPaths.length > 0) {
    const [firstPath, ...restPaths] = coldStartPaths;
    const win = createWindow(firstPath);
    for (const path of restPaths) queuePathForWindow(win, path);
    coldStartPaths.length = 0;
  } else {
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
