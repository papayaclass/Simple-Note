import { BrowserWindow, dialog, shell } from 'electron';
import { promises as fs, watch, FSWatcher } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { getPreferences, setPreference } from './preferences.js';

// A single node in the vault file tree. Folders carry `children`; files don't.
export interface VaultNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  mtimeMs: number;
  birthtimeMs: number;
  children?: VaultNode[];
}

// ---------------------------------------------------------------------------
// Watcher: one recursive fs.watch on the vault root. macOS supports recursive
// watching natively. Events are debounced (~150ms) then broadcast to every
// window so each renderer can re-fetch the tree.
// ---------------------------------------------------------------------------
let watcher: FSWatcher | null = null;
let watchedPath: string | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

function notifyVaultChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('vault:changed');
  }
}

export function startWatching(vaultPath: string | null): void {
  if (watcher && watchedPath === vaultPath) return;
  if (watcher) {
    watcher.close();
    watcher = null;
    watchedPath = null;
  }
  if (!vaultPath) return;
  try {
    watcher = watch(vaultPath, { recursive: true }, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(notifyVaultChanged, 150);
    });
    watchedPath = vaultPath;
  } catch (err) {
    console.error('[vault] watch failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Vault path management (persisted in preferences).
// ---------------------------------------------------------------------------
export function getVault(): string | null {
  const p = getPreferences().vaultPath;
  return p || null;
}

export async function pickVault(win: BrowserWindow | null): Promise<string | null> {
  const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths[0]) return null;
  const path = r.filePaths[0];
  setPreference('vaultPath', path);
  startWatching(path);
  return path;
}

export function clearVault(): void {
  setPreference('vaultPath', '');
  startWatching(null);
}

// ---------------------------------------------------------------------------
// Tree listing. Only folders and `.md` files are included; dotfiles skipped.
// ---------------------------------------------------------------------------
async function readDir(dir: string): Promise<VaultNode[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: VaultNode[] = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      nodes.push({
        name: ent.name,
        path: full,
        type: 'folder',
        mtimeMs: stat.mtimeMs,
        birthtimeMs: stat.birthtimeMs,
        children: await readDir(full),
      });
    } else if (ent.isFile() && extname(ent.name).toLowerCase() === '.md') {
      const stat = await fs.stat(full).catch(() => null);
      if (!stat) continue;
      nodes.push({
        name: ent.name,
        path: full,
        type: 'file',
        mtimeMs: stat.mtimeMs,
        birthtimeMs: stat.birthtimeMs,
      });
    }
  }
  return nodes;
}

export async function listVault(): Promise<VaultNode[]> {
  const vault = getVault();
  if (!vault) return [];
  return readDir(vault);
}

// ---------------------------------------------------------------------------
// File / folder operations. `dir` defaults to the vault root.
// ---------------------------------------------------------------------------
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Build a non-colliding path: `<base><ext>`, then `<base> 1<ext>`, etc. `ext`
// includes the leading dot for files, or '' for folders.
async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = join(dir, `${base}${ext}`);
  let i = 1;
  while (await exists(candidate)) {
    candidate = join(dir, `${base} ${i}${ext}`);
    i++;
  }
  return candidate;
}

export async function createFile(dir?: string | null): Promise<{ ok: boolean; path?: string }> {
  const target = dir || getVault();
  if (!target) return { ok: false };
  const path = await uniquePath(target, '未命名', '.md');
  await fs.writeFile(path, '', 'utf-8');
  return { ok: true, path };
}

export async function createFolder(dir?: string | null): Promise<{ ok: boolean; path?: string }> {
  const target = dir || getVault();
  if (!target) return { ok: false };
  const path = await uniquePath(target, '未命名資料夾', '');
  await fs.mkdir(path);
  return { ok: true, path };
}

export async function renameEntry(
  path: string,
  newName: string
): Promise<{ ok: boolean; path?: string; reason?: string }> {
  const dir = dirname(path);
  const stat = await fs.stat(path).catch(() => null);
  if (!stat) return { ok: false, reason: 'missing' };
  // Files keep their .md extension even if the user omitted it while renaming.
  let finalName = newName.trim();
  if (!finalName) return { ok: false, reason: 'empty' };
  if (stat.isFile() && extname(path).toLowerCase() === '.md' && !/\.md$/i.test(finalName)) {
    finalName += '.md';
  }
  const target = join(dir, finalName);
  if (target === path) return { ok: true, path };
  if (await exists(target)) return { ok: false, reason: 'exists' };
  try {
    await fs.rename(path, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

export async function deleteEntry(path: string): Promise<{ ok: boolean }> {
  try {
    await shell.trashItem(path);
    return { ok: true };
  } catch (err) {
    console.error('[vault] trash failed:', err);
    return { ok: false };
  }
}

export async function duplicateEntry(path: string): Promise<{ ok: boolean; path?: string }> {
  try {
    const stat = await fs.stat(path);
    const dir = dirname(path);
    if (stat.isDirectory()) {
      const dest = await uniquePath(dir, basename(path), '');
      await fs.cp(path, dest, { recursive: true });
      return { ok: true, path: dest };
    }
    const ext = extname(path);
    const dest = await uniquePath(dir, basename(path, ext), ext);
    await fs.copyFile(path, dest);
    return { ok: true, path: dest };
  } catch (err) {
    console.error('[vault] duplicate failed:', err);
    return { ok: false };
  }
}

// Move a file/folder into a destination directory (drag onto a folder in the
// sidebar). Refuses to move a folder into itself or its own descendant.
export async function moveEntry(
  src: string,
  destDir: string
): Promise<{ ok: boolean; path?: string; reason?: string }> {
  if (destDir === src || destDir.startsWith(src + '/')) return { ok: false, reason: 'into-self' };
  if (dirname(src) === destDir) return { ok: true, path: src }; // already there
  const ext = extname(src);
  const base = basename(src, ext);
  const dest = await uniquePath(destDir, base, ext);
  try {
    await fs.rename(src, dest);
    return { ok: true, path: dest };
  } catch (err) {
    console.error('[vault] move failed:', err);
    return { ok: false, reason: String(err) };
  }
}

export function revealEntry(path: string): void {
  shell.showItemInFolder(path);
}

export async function readMarkdown(path: string): Promise<{ ok: boolean; content?: string }> {
  try {
    const content = await fs.readFile(path, 'utf-8');
    return { ok: true, content };
  } catch {
    return { ok: false };
  }
}

// Save an out-of-vault / untitled document into the vault. Opens a save dialog
// defaulted to the vault root so the user can confirm the name/location.
export async function moveToVault(
  win: BrowserWindow | null,
  markdown: string,
  suggestedName?: string
): Promise<{ ok: boolean; path?: string }> {
  const vault = getVault();
  const name = suggestedName ?? '未命名筆記.md';
  const defaultPath = vault ? join(vault, name) : name;
  const opts = {
    defaultPath,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return { ok: false };
  await fs.writeFile(r.filePath, markdown, 'utf-8');
  return { ok: true, path: r.filePath };
}
