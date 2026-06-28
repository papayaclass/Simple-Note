import { BrowserWindow, dialog, shell } from 'electron';
import { promises as fs, watch, FSWatcher } from 'node:fs';
import { join, dirname, basename, extname, isAbsolute, relative, resolve } from 'node:path';
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

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const IMPORT_EXTS = new Set(['.md', '.txt', ...IMAGE_EXTS]);

export function isInVault(p: string): boolean {
  const v = getVault();
  return !!v && (p === v || p.startsWith(v + '/'));
}

function mimeFromExt(p: string): string {
  switch (extname(p).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.bmp':
      return 'image/bmp';
    case '.avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

function imageMimeToExtName(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/svg+xml':
      return 'svg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/avif':
      return 'avif';
    default:
      return mime.split('/')[1] ?? 'png';
  }
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
    } else if (ent.isFile()) {
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

// Startup "在儲存庫內新增空白文件": open the canonical 未命名筆記.md in the vault
// root, reusing it when it already exists and is still empty so repeated
// launches don't pile up 未命名筆記 1.md, 2.md… Only create a fresh,
// uniquely-named file when the canonical one is missing or already has content
// (i.e. it became a real note).
export async function createBlankNote(): Promise<{ ok: boolean; path?: string }> {
  const vault = getVault();
  if (!vault) return { ok: false };
  const canonical = join(vault, '未命名筆記.md');
  if (await exists(canonical)) {
    const content = await fs.readFile(canonical, 'utf-8').catch(() => null);
    if (content !== null && content.trim() === '') return { ok: true, path: canonical };
  }
  const path = await uniquePath(vault, '未命名筆記', '.md');
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
  // Preserve the original file extension when the new name omits one. The
  // sidebar now lists txt/images/etc., so without this, renaming "photo.png"
  // to "photo" would silently drop the file's type (and an image with no
  // extension stops being previewable). Typing a new extension still wins.
  if (stat.isFile()) {
    const origExt = extname(path);
    if (origExt && !extname(finalName)) {
      finalName += origExt;
    }
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

// Move external items into the vault (drag from Finder onto the sidebar).
// Folders are moved whole (every file type, recursively); loose files are only
// accepted when md/txt/image. Cross-device renames fall back to copy + remove
// so the result is always a move, not a copy. Name collisions resolve with
// uniquePath.
export async function importExternal(
  paths: string[],
  destDir: string | null
): Promise<{ ok: boolean; moved: string[] }> {
  const vault = getVault();
  if (!vault) return { ok: false, moved: [] };
  const dir =
    destDir && (destDir === vault || destDir.startsWith(vault + '/')) ? destDir : vault;
  const moved: string[] = [];
  for (const src of paths) {
    const stat = await fs.stat(src).catch(() => null);
    if (!stat) continue;

    if (stat.isDirectory()) {
      // Refuse to move the vault into itself, an ancestor of the vault into the
      // vault, or a folder into its own subtree — any of which would recurse.
      if (
        src === vault ||
        vault.startsWith(src + '/') ||
        dir === src ||
        dir.startsWith(src + '/')
      ) {
        continue;
      }
      const dest = await uniquePath(dir, basename(src), '');
      try {
        await fs.rename(src, dest);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
          // Cross-device: copy the whole tree, then delete the original.
          try {
            await fs.cp(src, dest, { recursive: true });
            await fs.rm(src, { recursive: true, force: true });
          } catch (copyErr) {
            console.error('[vault] import folder failed:', src, copyErr);
            continue;
          }
        } else {
          console.error('[vault] import folder failed:', src, err);
          continue;
        }
      }
      moved.push(dest);
      continue;
    }

    const ext = extname(src).toLowerCase();
    if (!IMPORT_EXTS.has(ext)) continue;
    const dest = await uniquePath(dir, basename(src, ext), ext);
    try {
      await fs.rename(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
        try {
          await fs.copyFile(src, dest);
          await fs.unlink(src);
        } catch (copyErr) {
          console.error('[vault] import failed:', src, copyErr);
          continue;
        }
      } else {
        console.error('[vault] import failed:', src, err);
        continue;
      }
    }
    moved.push(dest);
  }
  return { ok: moved.length > 0, moved };
}

// Decide how an inserted image should be persisted/referenced (feature 4).
export async function saveImageForNote(args: {
  notePath: string | null;
  sourcePath?: string;
  dataUrl?: string;
}): Promise<{ ok: boolean; persistSrc?: string; absPath?: string; memoryOnly?: boolean }> {
  const { notePath, sourcePath, dataUrl } = args;
  const vault = getVault();
  const noteInVault = !!notePath && isInVault(notePath);
  const noteDir = notePath ? dirname(notePath) : null;

  if (sourcePath) {
    // A real file on disk (dragged from Finder).
    if (noteInVault && vault && noteDir) {
      let assetAbs = sourcePath;
      if (!isInVault(sourcePath)) {
        const assetsDir = join(vault, 'Assets');
        await fs.mkdir(assetsDir, { recursive: true });
        const ext = extname(sourcePath);
        assetAbs = await uniquePath(assetsDir, basename(sourcePath, ext), ext);
        await fs.copyFile(sourcePath, assetAbs);
      }
      return { ok: true, persistSrc: relative(noteDir, assetAbs), absPath: assetAbs };
    }
    // Note lives outside the vault (or is untitled): reference the original path.
    return { ok: true, persistSrc: sourcePath, absPath: sourcePath };
  }

  if (dataUrl) {
    // No source file (pasted screenshot / clipboard image).
    if (noteInVault && vault && noteDir) {
      const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) return { ok: false };
      const ext = '.' + imageMimeToExtName(m[1]!);
      const assetsDir = join(vault, 'assets');
      await fs.mkdir(assetsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const assetAbs = await uniquePath(assetsDir, `Pasted image ${stamp}`, ext);
      await fs.writeFile(assetAbs, Buffer.from(m[2]!, 'base64'));
      return { ok: true, persistSrc: relative(noteDir, assetAbs), absPath: assetAbs };
    }
    return { ok: true, memoryOnly: true };
  }
  return { ok: false };
}

// Read an image file (path may be relative to the note dir) as a data URL, used
// to display file-path image blocks and image-preview tabs.
export async function readImageAsDataUrl(
  noteDir: string | null,
  src: string
): Promise<{ ok: boolean; dataUrl?: string }> {
  try {
    if (!isAbsolute(src) && !noteDir) return { ok: false };
    const abs = isAbsolute(src) ? src : resolve(noteDir!, src);
    const buf = await fs.readFile(abs);
    return { ok: true, dataUrl: `data:${mimeFromExt(abs)};base64,${buf.toString('base64')}` };
  } catch {
    return { ok: false };
  }
}

// Open the vault folder itself in Finder (sidebar empty-area "顯示於 Finder").
export function openSelf(): void {
  const v = getVault();
  if (v) void shell.openPath(v);
}
