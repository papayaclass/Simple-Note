import { useStore } from './store';
import { getDocumentView } from './DocumentView';

// Open a file path as a tab: if it's already open, just activate that tab;
// otherwise read its Markdown (unless already supplied) and add a new tab.
// `autoFocus` controls whether the new tab grabs editor focus (sidebar opens
// pass false so the sidebar keeps its keyboard shortcuts).
export async function openFileInTab(
  path: string,
  content?: string,
  opts: { autoFocus?: boolean; autoName?: boolean } = {}
): Promise<void> {
  const s = useStore.getState();
  const existing = s.tabs.find((t) => t.filePath === path);
  if (existing) {
    s.setActiveTab(existing.id);
    return;
  }
  let md = content;
  if (md == null) {
    const r = await window.api.vault.read(path);
    if (!r.ok) return;
    md = r.content ?? '';
  }
  // If the active tab is a pristine, blank, untitled starter, replace it
  // instead of piling a new tab beside it (Obsidian behaviour).
  const prev = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId);
  s.addTab({
    filePath: path,
    initialMarkdown: md,
    autoFocus: opts.autoFocus,
    autoName: opts.autoName,
  });
  if (prev && !prev.filePath && !prev.dirty) {
    const dv = getDocumentView(prev.id);
    if (!dv || !dv.hasContent()) useStore.getState().closeTab(prev.id);
  }
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
  if (s.vaultPath) {
    const r = await window.api.vault.createFile(null);
    if (r.ok && r.path) {
      await refreshVaultTree();
      await openFileInTab(r.path, '', { autoFocus: true, autoName: true });
      return;
    }
  }
  s.addTab();
}
