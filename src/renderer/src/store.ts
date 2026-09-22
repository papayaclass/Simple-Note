import { create } from 'zustand';
import { DEFAULT_MENU_COMMANDS, MenuItemPref } from './context-menu/commands';
import { isSheetPath } from './sheet/sheetFormat';

// Mirrors VaultNode in src/preload/index.ts (kept local so the renderer's
// tsconfig project stays self-contained). window.api.vault.list() returns the
// structurally-identical preload type, which assigns to this freely.
export interface VaultNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  mtimeMs: number;
  birthtimeMs: number;
  children?: VaultNode[];
}

export type SortMode = 'manual' | 'name' | 'created' | 'modified';
export type StartupBehavior = 'newBlankInVault' | 'lastEdited';
export type BlankFirstLineFormat = 'heading1' | 'heading2' | 'heading3' | 'paragraph';
export type TranslationResultMode = 'insertBelow' | 'replaceSelection';

// Column layout as the article's position on a `[left] — center — [right]` track.
// `center` is single-column; the other two reveal an independent blank column on
// the opposite side (article-left reveals the right column, and vice versa).
export type ColumnLayout = 'center' | 'article-left' | 'article-right';

export type TabKind = 'editor' | 'image' | 'sheet';

export interface TabPane {
  id: string;
  tabIds: string[];
  activeTabId: string;
}

// One open document. The editor itself (and its undo history / scroll / caret)
// lives in the per-tab DocumentView that stays mounted for the tab's lifetime;
// this object holds only the lightweight, serialisable document state.
export interface Tab {
  id: string;
  filePath: string | null;
  fileName: string;
  dirty: boolean;
  columnLayout: ColumnLayout;
  columnSplit: number;
  // Markdown to load into the editor once on first mount (set when a tab is
  // opened from a file). Cleared by DocumentView after it loads.
  initialMarkdown?: string;
  // Whether the editor grabs focus when this tab first mounts. Blank/new tabs
  // focus immediately; sidebar-opened files leave focus in the sidebar so its
  // Enter/Delete shortcuts keep working.
  autoFocus: boolean;
  // True for freshly-created untitled files: the filename auto-follows the
  // document's first heading until the user manually renames it.
  autoName: boolean;
  blankFirstLineFormat: BlankFirstLineFormat;
  // Used when a tab is moved between split panes. React remounts the document
  // under its new pane, so the current editor Markdown is staged here once and
  // the previous dirty state is restored after that load.
  restoreDirtyAfterLoad?: boolean;
  // 'editor' (default) renders a DocumentView; 'image' renders a read-only
  // ImageView previewing the file at filePath; 'sheet' renders a SheetView
  // (.ssheet / .csv spreadsheets).
  kind: TabKind;
}

export interface Preferences {
  pageWidth: number;
  twoColumnPageWidth: number;
  lineHeight: number;
  paragraphSpacing: number;
  topPadding: number;
  heading1Scale: number;
  heading2Scale: number;
  heading3Scale: number;
  codeWrap: boolean;
  openRouterApiKey: string;
  openRouterModel: string;
  aiGlobalInstruction: string;
  menuCommands: MenuItemPref[];
  translationResultMode: TranslationResultMode;
  startupBehavior: StartupBehavior;
  blankNoteFirstLineFormat: BlankFirstLineFormat;
  lastEditedFilePath: string;
  // File-management prefs (mirrored in src/main/preferences.ts).
  vaultPath: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sortMode: SortMode;
  sortAsc: boolean;
  foldersOnTop: boolean;
  manualOrder: Record<string, string[]>;
}

export const DEFAULT_PREFS: Preferences = {
  pageWidth: 720,
  twoColumnPageWidth: 1080,
  lineHeight: 1.6,
  paragraphSpacing: 8,
  topPadding: 96,
  heading1Scale: 2,
  heading2Scale: 1.5,
  heading3Scale: 1.2,
  codeWrap: false,
  openRouterApiKey: '',
  openRouterModel: '',
  aiGlobalInstruction: '',
  menuCommands: DEFAULT_MENU_COMMANDS,
  translationResultMode: 'insertBelow',
  startupBehavior: 'newBlankInVault',
  blankNoteFirstLineFormat: 'paragraph',
  lastEditedFilePath: '',
  vaultPath: '',
  sidebarOpen: true,
  sidebarWidth: 250,
  sortMode: 'manual',
  sortAsc: true,
  foldersOnTop: true,
  manualOrder: {},
};

let tabCounter = 0;
function nextTabId(): string {
  tabCounter += 1;
  return `tab-${tabCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

let paneCounter = 0;
function nextPaneId(): string {
  paneCounter += 1;
  return `pane-${paneCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

function fileNameFromPath(path: string | null, kind: TabKind = 'editor'): string {
  if (!path) return kind === 'sheet' ? '未命名試算表' : '未命名筆記';
  return path.split('/').pop()!.replace(/\.(md|snote|ssheet)$/i, '');
}

export interface NewTabOptions {
  filePath?: string | null;
  initialMarkdown?: string;
  autoFocus?: boolean;
  autoName?: boolean;
  blankFirstLineFormat?: BlankFirstLineFormat;
  kind?: TabKind;
}

export function makeTab(opts: NewTabOptions = {}): Tab {
  const filePath = opts.filePath ?? null;
  const kind = opts.kind ?? (isSheetPath(filePath) ? 'sheet' : 'editor');
  return {
    id: nextTabId(),
    filePath,
    fileName: fileNameFromPath(filePath, kind),
    dirty: false,
    columnLayout: 'center',
    columnSplit: 0.5,
    initialMarkdown: opts.initialMarkdown,
    autoFocus: opts.autoFocus ?? true,
    autoName: opts.autoName ?? false,
    blankFirstLineFormat: opts.blankFirstLineFormat ?? DEFAULT_PREFS.blankNoteFirstLineFormat,
    kind,
  };
}

function makePane(tabId: string): TabPane {
  return {
    id: nextPaneId(),
    tabIds: [tabId],
    activeTabId: tabId,
  };
}

function clampInsertIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

function moveId(ids: string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  const target = to > from ? to - 1 : to;
  next.splice(clampInsertIndex(target, next.length), 0, moved);
  return next;
}

function paneWithActiveTab(pane: TabPane, fallbackTabId?: string): TabPane {
  if (pane.tabIds.includes(pane.activeTabId)) return pane;
  return {
    ...pane,
    activeTabId: pane.tabIds[0] ?? fallbackTabId ?? pane.activeTabId,
  };
}

function activePaneForTab(panes: TabPane[], tabId: string): TabPane | undefined {
  return panes.find((p) => p.tabIds.includes(tabId));
}

interface AppState {
  tabs: Tab[];
  activeTabId: string;
  panes: TabPane[];
  activePaneId: string;
  splitRatio: number;
  mathMode: boolean;
  preferences: Preferences;
  prefsPanelOpen: boolean;
  contextMenuOpen: boolean;
  wordCountPopover: { count: number; chars: number; charsNoSpace: number; chinese: number } | null;
  // Sidebar / vault UI state (persisted to preferences on change).
  vaultPath: string | null;
  sidebarOpen: boolean;
  sortMode: SortMode;
  sortAsc: boolean;
  fileTree: VaultNode[];
  selectedPath: string | null;

  // Tab actions
  addTab: (opts?: NewTabOptions, paneId?: string) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setActivePane: (id: string) => void;
  reorderTabs: (from: number, to: number) => void;
  reorderTabsInPane: (paneId: string, from: number, to: number) => void;
  moveTabToPane: (tabId: string, paneId: string, index: number) => void;
  splitTabToSide: (tabId: string, side: 'left' | 'right') => void;
  setSplitRatio: (ratio: number) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  // Follow a file/folder rename or move: any open tab whose path is (or is
  // under) oldPath is repointed to the new path + filename.
  retargetTabs: (oldPath: string, newPath: string) => void;
  // Stop auto-naming the tab(s) at this path (called on a manual rename).
  clearAutoName: (path: string) => void;
  setTabFile: (id: string, path: string | null) => void;
  setTabDirty: (id: string, dirty: boolean) => void;
  setTabColumnLayout: (id: string, layout: ColumnLayout) => void;
  shiftTabColumn: (id: string, dir: 'left' | 'right') => void;
  setTabColumnSplit: (id: string, split: number) => void;

  // Global view/state
  toggleMathMode: () => void;
  setMathMode: (on: boolean) => void;
  setPreferences: (p: Partial<Preferences>) => void;
  setPrefsPanelOpen: (open: boolean) => void;
  setWordCountPopover: (v: AppState['wordCountPopover']) => void;

  // Sidebar / vault actions
  setVaultPath: (path: string | null) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSortMode: (mode: SortMode) => void;
  setSortAsc: (asc: boolean) => void;
  setFileTree: (tree: VaultNode[]) => void;
  setSelectedPath: (path: string | null) => void;
}

const FIRST_TAB = makeTab();
const FIRST_PANE = makePane(FIRST_TAB.id);

export const useStore = create<AppState>((set) => ({
  tabs: [FIRST_TAB],
  activeTabId: FIRST_TAB.id,
  panes: [FIRST_PANE],
  activePaneId: FIRST_PANE.id,
  splitRatio: 0.5,
  mathMode: false,
  preferences: DEFAULT_PREFS,
  prefsPanelOpen: false,
  contextMenuOpen: false,
  wordCountPopover: null,
  vaultPath: null,
  sidebarOpen: true,
  sortMode: 'manual',
  sortAsc: true,
  fileTree: [],
  selectedPath: null,

  addTab: (opts, paneId) => {
    const tab = makeTab(opts);
    set((s) => {
      const targetPaneId = paneId ?? s.activePaneId;
      const existingPane = s.panes.find((p) => p.id === targetPaneId);
      if (!existingPane) {
        const pane = makePane(tab.id);
        return {
          tabs: [...s.tabs, tab],
          panes: [...s.panes, pane].slice(0, 2),
          activePaneId: pane.id,
          activeTabId: tab.id,
        };
      }
      return {
        tabs: [...s.tabs, tab],
        panes: s.panes.map((p) =>
          p.id === existingPane.id
            ? { ...p, tabIds: [...p.tabIds, tab.id], activeTabId: tab.id }
            : p
        ),
        activePaneId: existingPane.id,
        activeTabId: tab.id,
      };
    });
    return tab.id;
  },
  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      // Always keep at least one tab open.
      if (tabs.length === 0) {
        const fresh = makeTab({ blankFirstLineFormat: s.preferences.blankNoteFirstLineFormat });
        const pane = makePane(fresh.id);
        return { tabs: [fresh], panes: [pane], activePaneId: pane.id, activeTabId: fresh.id };
      }
      const closingPane = s.panes.find((p) => p.tabIds.includes(id));
      const closingIndex = closingPane?.tabIds.indexOf(id) ?? -1;
      let panes = s.panes
        .map((p) => {
          if (!p.tabIds.includes(id)) return paneWithActiveTab(p, tabs[0]?.id);
          const tabIds = p.tabIds.filter((tabId) => tabId !== id);
          if (tabIds.length === 0) return { ...p, tabIds, activeTabId: '' };
          const nextActive =
            p.activeTabId === id
              ? tabIds[Math.min(Math.max(closingIndex, 0), tabIds.length - 1)]
              : p.activeTabId;
          return { ...p, tabIds, activeTabId: nextActive };
        })
        .filter((p) => p.tabIds.length > 0);
      if (panes.length === 0) panes = [makePane(tabs[0].id)];

      let activeTabId = s.activeTabId;
      if (!tabs.some((t) => t.id === activeTabId)) {
        const fallbackPane =
          (closingPane && panes.find((p) => p.id === closingPane.id)) ?? panes[0];
        activeTabId = fallbackPane.activeTabId;
      }
      const activePane = activePaneForTab(panes, activeTabId) ?? panes[0];
      panes = panes.map((p) => (p.id === activePane.id ? { ...p, activeTabId } : p));
      return { tabs, panes, activePaneId: activePane.id, activeTabId };
    }),
  setActiveTab: (id) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return s;
      const pane = activePaneForTab(s.panes, id);
      if (!pane) return { activeTabId: id };
      return {
        panes: s.panes.map((p) => (p.id === pane.id ? { ...p, activeTabId: id } : p)),
        activePaneId: pane.id,
        activeTabId: id,
      };
    }),
  setActivePane: (id) =>
    set((s) => {
      const pane = s.panes.find((p) => p.id === id);
      if (!pane) return s;
      return { activePaneId: pane.id, activeTabId: pane.activeTabId };
    }),
  reorderTabs: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || from >= s.tabs.length) return s;
      const tabs = [...s.tabs];
      const [moved] = tabs.splice(from, 1);
      const target = to > from ? to - 1 : to;
      tabs.splice(Math.max(0, Math.min(target, tabs.length)), 0, moved);
      return { tabs };
    }),
  reorderTabsInPane: (paneId, from, to) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === paneId ? { ...p, tabIds: moveId(p.tabIds, from, to) } : p
      ),
    })),
  moveTabToPane: (tabId, paneId, index) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === tabId)) return s;
      const targetPane = s.panes.find((p) => p.id === paneId);
      if (!targetPane) return s;
      const sourcePane = s.panes.find((p) => p.tabIds.includes(tabId));
      if (sourcePane?.id === paneId) {
        const from = targetPane.tabIds.indexOf(tabId);
        return {
          panes: s.panes.map((p) =>
            p.id === paneId
              ? { ...p, tabIds: moveId(p.tabIds, from, index), activeTabId: tabId }
              : p
          ),
          activePaneId: paneId,
          activeTabId: tabId,
        };
      }
      let panes = s.panes.map((p) => {
        const withoutMoved = p.tabIds.filter((id) => id !== tabId);
        if (p.id !== paneId) {
          const activeTabId =
            p.activeTabId === tabId ? (withoutMoved[0] ?? '') : p.activeTabId;
          return { ...p, tabIds: withoutMoved, activeTabId };
        }
        const tabIds = [...withoutMoved];
        tabIds.splice(clampInsertIndex(index, tabIds.length), 0, tabId);
        return { ...p, tabIds, activeTabId: tabId };
      });
      panes = panes.filter((p) => p.tabIds.length > 0).map((p) => paneWithActiveTab(p));
      if (panes.length === 0) panes = [makePane(tabId)];
      const activePane = activePaneForTab(panes, tabId) ?? panes[0];
      return { panes, activePaneId: activePane.id, activeTabId: tabId };
    }),
  splitTabToSide: (tabId, side) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === tabId)) return s;
      if (s.panes.length === 1) {
        const source = s.panes[0];
        if (!source.tabIds.includes(tabId) || source.tabIds.length <= 1) return s;
        const movedPane = makePane(tabId);
        const remainingIds = source.tabIds.filter((id) => id !== tabId);
        const remainingPane = paneWithActiveTab(
          {
            ...source,
            tabIds: remainingIds,
            activeTabId: source.activeTabId === tabId ? remainingIds[0] : source.activeTabId,
          },
          remainingIds[0]
        );
        const panes = side === 'left' ? [movedPane, remainingPane] : [remainingPane, movedPane];
        return { panes, activePaneId: movedPane.id, activeTabId: tabId };
      }
      const targetPane = side === 'left' ? s.panes[0] : s.panes[s.panes.length - 1];
      if (!targetPane) return s;
      const sourcePane = s.panes.find((p) => p.tabIds.includes(tabId));
      if (sourcePane?.id === targetPane.id) {
        return {
          panes: s.panes.map((p) => (p.id === targetPane.id ? { ...p, activeTabId: tabId } : p)),
          activePaneId: targetPane.id,
          activeTabId: tabId,
        };
      }
      let panes = s.panes.map((p) => {
        const withoutMoved = p.tabIds.filter((id) => id !== tabId);
        if (p.id !== targetPane.id) {
          return {
            ...p,
            tabIds: withoutMoved,
            activeTabId: p.activeTabId === tabId ? (withoutMoved[0] ?? '') : p.activeTabId,
          };
        }
        return { ...p, tabIds: [...withoutMoved, tabId], activeTabId: tabId };
      });
      panes = panes.filter((p) => p.tabIds.length > 0).map((p) => paneWithActiveTab(p));
      const activePane = activePaneForTab(panes, tabId) ?? panes[0];
      return { panes, activePaneId: activePane.id, activeTabId: tabId };
    }),
  setSplitRatio: (ratio) =>
    set({ splitRatio: Math.min(0.8, Math.max(0.2, ratio)) }),
  updateTab: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  retargetTabs: (oldPath, newPath) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (!t.filePath) return t;
        if (t.filePath === oldPath) {
          return { ...t, filePath: newPath, fileName: fileNameFromPath(newPath) };
        }
        if (t.filePath.startsWith(oldPath + '/')) {
          const np = newPath + t.filePath.slice(oldPath.length);
          return { ...t, filePath: np, fileName: fileNameFromPath(np) };
        }
        return t;
      }),
    })),
  clearAutoName: (path) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.filePath === path ? { ...t, autoName: false } : t)),
    })),
  setTabFile: (id, path) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, filePath: path, fileName: fileNameFromPath(path, t.kind), dirty: false }
          : t
      ),
    })),
  setTabDirty: (id, dirty) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, dirty } : t)) })),
  setTabColumnLayout: (id, layout) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, columnLayout: layout } : t)) })),
  // Slide the article one step along [article-left, center, article-right].
  shiftTabColumn: (id, dir) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== id) return t;
        const order: ColumnLayout[] = ['article-left', 'center', 'article-right'];
        const i = order.indexOf(t.columnLayout);
        const next = dir === 'right' ? Math.min(i + 1, 2) : Math.max(i - 1, 0);
        return { ...t, columnLayout: order[next] };
      }),
    })),
  setTabColumnSplit: (id, split) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, columnSplit: split } : t)) })),

  toggleMathMode: () => set((s) => ({ mathMode: !s.mathMode })),
  setMathMode: (on) => set({ mathMode: on }),
  setPreferences: (p) => set((s) => ({ preferences: { ...s.preferences, ...p } })),
  setPrefsPanelOpen: (open) => set({ prefsPanelOpen: open }),
  setWordCountPopover: (v) => set({ wordCountPopover: v }),

  setVaultPath: (path) => set({ vaultPath: path }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSortMode: (mode) => set({ sortMode: mode }),
  setSortAsc: (asc) => set({ sortAsc: asc }),
  setFileTree: (tree) => set({ fileTree: tree }),
  setSelectedPath: (path) => set({ selectedPath: path }),
}));

// Convenience selector: the currently active tab (always defined — there's
// always at least one tab).
export function useActiveTab(): Tab {
  return useStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]);
}

export function getActiveTab(): Tab {
  const s = useStore.getState();
  return s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0];
}
