import { BlankFirstLineFormat, useStore } from './store';
import { getDocumentView } from './DocumentView';

interface OpenFileOptions {
  autoFocus?: boolean;
  autoName?: boolean;
  blankFirstLineFormat?: BlankFirstLineFormat;
  forceNew?: boolean;
}

function currentBlankFirstLineFormat(): BlankFirstLineFormat {
  return useStore.getState().preferences.blankNoteFirstLineFormat;
}

function fileNameFromPath(path: string): string {
  return path.split('/').pop()!.replace(/\.md$/i, '');
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function focusTabWhenReady(tabId: string): void {
  let tries = 0;
  const focus = (): void => {
    const view = getDocumentView(tabId);
    if (view) {
      view.focusLastBlock();
      return;
    }
    tries += 1;
    if (tries < 8) window.setTimeout(focus, 16);
  };
  window.requestAnimationFrame(focus);
}

export function rememberLastEditedFile(path: string): void {
  const s = useStore.getState();
  if (s.preferences.lastEditedFilePath === path) return;
  s.setPreferences({ lastEditedFilePath: path });
  void window.api.prefs.set('lastEditedFilePath', path);
}

export function retargetLastEditedFile(oldPath: string, newPath: string): void {
  const current = useStore.getState().preferences.lastEditedFilePath;
  if (!current) return;
  if (current !== oldPath && !current.startsWith(oldPath + '/')) return;
  rememberLastEditedFile(current === oldPath ? newPath : newPath + current.slice(oldPath.length));
}

export function forgetLastEditedFile(path: string): void {
  const current = useStore.getState().preferences.lastEditedFilePath;
  if (!current || (current !== path && !current.startsWith(path + '/'))) return;
  useStore.getState().setPreferences({ lastEditedFilePath: '' });
  void window.api.prefs.set('lastEditedFilePath', '');
}

export async function stageTabForPaneMove(tabId: string): Promise<void> {
  const s = useStore.getState();
  const tab = s.tabs.find((t) => t.id === tabId);
  if (!tab || tab.kind !== 'editor') return;
  const view = getDocumentView(tabId);
  if (!view) return;
  const markdown = await view.buildMarkdown();
  useStore.getState().updateTab(tabId, {
    initialMarkdown: markdown,
    restoreDirtyAfterLoad: tab.dirty,
  });
}

// Open a file path as a tab: if it's already open, just activate that tab;
// otherwise read its Markdown (unless already supplied) and add a new tab.
// `autoFocus` controls whether the new tab grabs editor focus (sidebar opens
// pass false so the sidebar keeps its keyboard shortcuts).
export async function openFileInTab(
  path: string,
  content?: string,
  opts: OpenFileOptions = {}
): Promise<string | null> {
  const s = useStore.getState();
  const existing = opts.forceNew ? undefined : s.tabs.find((t) => t.filePath === path);
  if (existing) {
    s.setActiveTab(existing.id);
    if (opts.autoFocus) focusTabWhenReady(existing.id);
    return existing.id;
  }
  let md = content;
  if (md == null) {
    const r = await window.api.vault.read(path);
    if (!r.ok) return null;
    md = r.content ?? '';
  }
  // If the active tab is a pristine, blank, untitled starter, replace it
  // instead of piling a new tab beside it (Obsidian behaviour).
  const prev = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId);
  const tabId = s.addTab({
    filePath: path,
    initialMarkdown: md,
    autoFocus: opts.autoFocus,
    autoName: opts.autoName,
    blankFirstLineFormat: opts.blankFirstLineFormat,
  });
  if (opts.autoFocus) focusTabWhenReady(tabId);
  if (prev && !prev.filePath && !prev.dirty) {
    const dv = getDocumentView(prev.id);
    if (!dv || !dv.hasContent()) useStore.getState().closeTab(prev.id);
  }
  return tabId;
}

export async function openFileInCurrentTab(
  path: string,
  content?: string,
  opts: OpenFileOptions = {}
): Promise<string | null> {
  const s = useStore.getState();
  const activeTab = s.tabs.find((t) => t.id === s.activeTabId);
  if (!activeTab) return openFileInTab(path, content, opts);

  if (activeTab.kind === 'editor' && activeTab.filePath === path) {
    if (opts.autoFocus) focusTabWhenReady(activeTab.id);
    return activeTab.id;
  }

  const activeView = activeTab.kind === 'editor' ? getDocumentView(activeTab.id) : undefined;
  if (activeView) {
    const shouldFlushVaultFile = !!activeTab.filePath && isPathInVault(activeTab.filePath);
    const shouldSaveDirtyFile = activeTab.dirty && activeView.hasContent();
    if (shouldFlushVaultFile || shouldSaveDirtyFile) {
      const saved = await activeView.save();
      if (!saved) return null;
    }
  }

  let md = content;
  if (md == null) {
    const r = await window.api.vault.read(path);
    if (!r.ok) return null;
    md = r.content ?? '';
  }

  const willReloadMountedEditor = activeTab.kind === 'editor' && !!activeView;
  useStore.getState().updateTab(activeTab.id, {
    filePath: path,
    fileName: fileNameFromPath(path),
    dirty: false,
    columnLayout: 'center',
    columnSplit: 0.5,
    initialMarkdown: willReloadMountedEditor ? undefined : md,
    autoFocus: opts.autoFocus ?? false,
    autoName: opts.autoName ?? false,
    blankFirstLineFormat: opts.blankFirstLineFormat ?? activeTab.blankFirstLineFormat,
    restoreDirtyAfterLoad: undefined,
    kind: 'editor',
  });
  useStore.getState().setActiveTab(activeTab.id);

  if (willReloadMountedEditor) {
    await nextAnimationFrame();
    await getDocumentView(activeTab.id)?.replaceWithMarkdown(md, { focus: opts.autoFocus });
  } else if (opts.autoFocus) {
    focusTabWhenReady(activeTab.id);
  }

  return activeTab.id;
}

// Refresh the vault file tree into the store.
export async function refreshVaultTree(): Promise<void> {
  const s = useStore.getState();
  if (!s.vaultPath) {
    s.setFileTree([]);
    return;
  }
  const tree = await window.api.vault.list();
  s.setFileTree(tree);
}

// Whether a path lives inside the configured vault.
export function isPathInVault(path: string | null): boolean {
  const vp = useStore.getState().vaultPath;
  return !!path && !!vp && (path === vp || path.startsWith(vp + '/'));
}

// "New tab": create a real file in the vault root when a vault is set (so it
// auto-saves and shows in the sidebar), otherwise fall back to an untitled
// in-memory tab. Used by Cmd+N and the tab bar's + button.
export async function createNewTab(): Promise<void> {
  const s = useStore.getState();
  const blankFirstLineFormat = currentBlankFirstLineFormat();
  if (s.vaultPath) {
    const r = await window.api.vault.createFile(null);
    if (r.ok && r.path) {
      await refreshVaultTree();
      await openFileInTab(r.path, '', {
        autoFocus: true,
        autoName: true,
        blankFirstLineFormat,
      });
      return;
    }
  }
  const tabId = s.addTab({ blankFirstLineFormat });
  focusTabWhenReady(tabId);
}

// Startup "在儲存庫內新增空白文件": physically create 未命名筆記.md in the vault
// root and open it (so it auto-saves and lists in the sidebar), unlike the
// in-memory `newBlank` starter. No-op when no vault is configured. Returns
// whether a file was actually created + opened.
export async function createBlankVaultNote(): Promise<boolean> {
  const s = useStore.getState();
  if (!s.vaultPath) return false;
  const r = await window.api.vault.createBlankNote();
  if (!r.ok || !r.path) return false;
  await refreshVaultTree();
  await openFileInTab(r.path, '', {
    autoFocus: true,
    autoName: true,
    blankFirstLineFormat: currentBlankFirstLineFormat(),
  });
  return true;
}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif'];

export function isImagePath(p: string): boolean {
  const i = p.lastIndexOf('.');
  return i >= 0 && IMAGE_EXTS.includes(p.slice(i).toLowerCase());
}

export function isTextNotePath(p: string): boolean {
  return /\.(md|txt)$/i.test(p);
}

// Open an image file in a read-only preview tab (sidebar single-click on an
// image). Re-activates an existing preview tab for the same image if present.
export async function openImageTab(
  path: string,
  opts: { forceNew?: boolean } = {}
): Promise<void> {
  const s = useStore.getState();
  const existing = opts.forceNew
    ? undefined
    : s.tabs.find((t) => t.filePath === path && t.kind === 'image');
  if (existing) {
    s.setActiveTab(existing.id);
    return;
  }
  s.addTab({ filePath: path, kind: 'image', autoFocus: false });
}
