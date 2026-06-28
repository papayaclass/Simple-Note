import { create } from 'zustand';
import { DEFAULT_MENU_COMMANDS, MenuItemPref } from './context-menu/commands';

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

export interface AISkill {
  id: string;
  name: string;
  prompt: string;
}

export type SortMode = 'manual' | 'name' | 'created' | 'modified';
export type StartupBehavior = 'newBlank' | 'newBlankInVault' | 'lastEdited';

// Column layout as the article's position on a `[left] — center — [right]` track.
// `center` is single-column; the other two reveal an independent blank column on
// the opposite side (article-left reveals the right column, and vice versa).
export type ColumnLayout = 'center' | 'article-left' | 'article-right';

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
  // 'editor' (default) renders a DocumentView; 'image' renders a read-only
  // ImageView previewing the file at filePath.
  kind: 'editor' | 'image';
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
  exchangeRateApiKey: string;
  codeWrap: boolean;
  openRouterApiKey: string;
  openRouterModel: string;
  geminiApiKey: string;
  geminiTtsModel: string;
  aiGlobalInstruction: string;
  aiSkills: AISkill[];
  menuCommands: MenuItemPref[];
  startupBehavior: StartupBehavior;
  lastEditedFilePath: string;
  // File-management prefs (mirrored in src/main/preferences.ts).
  vaultPath: string;
  sidebarOpen: boolean;
  sidebarWidth: number;
  sortMode: SortMode;
  sortAsc: boolean;
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
  exchangeRateApiKey: '',
  codeWrap: false,
  openRouterApiKey: '',
  openRouterModel: '',
  geminiApiKey: '',
  geminiTtsModel: 'gemini-3.1-flash-tts-preview',
  aiGlobalInstruction: '',
  aiSkills: [],
  menuCommands: DEFAULT_MENU_COMMANDS,
  startupBehavior: 'newBlank',
  lastEditedFilePath: '',
  vaultPath: '',
  sidebarOpen: true,
  sidebarWidth: 250,
  sortMode: 'manual',
  sortAsc: true,
  manualOrder: {},
};

let tabCounter = 0;
function nextTabId(): string {
  tabCounter += 1;
  return `tab-${tabCounter}-${Math.random().toString(36).slice(2, 7)}`;
}

function fileNameFromPath(path: string | null): string {
  return path ? path.split('/').pop()!.replace(/\.md$/i, '') : '未命名筆記';
}

export interface NewTabOptions {
  filePath?: string | null;
  initialMarkdown?: string;
  autoFocus?: boolean;
  autoName?: boolean;
  kind?: 'editor' | 'image';
}

export function makeTab(opts: NewTabOptions = {}): Tab {
  const filePath = opts.filePath ?? null;
  return {
    id: nextTabId(),
    filePath,
    fileName: fileNameFromPath(filePath),
    dirty: false,
    columnLayout: 'center',
    columnSplit: 0.5,
    initialMarkdown: opts.initialMarkdown,
    autoFocus: opts.autoFocus ?? true,
    autoName: opts.autoName ?? false,
    kind: opts.kind ?? 'editor',
  };
}

interface AppState {
  tabs: Tab[];
  activeTabId: string;
  mathMode: boolean;
  timer: { endsAt: number } | null;
  alarms: Array<{ id: string; at: number }>;
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
  addTab: (opts?: NewTabOptions) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  reorderTabs: (from: number, to: number) => void;
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
  setTimer: (t: { endsAt: number } | null) => void;
  addAlarm: (at: number) => void;
  removeAlarm: (id: string) => void;
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

export const useStore = create<AppState>((set, get) => ({
  tabs: [FIRST_TAB],
  activeTabId: FIRST_TAB.id,
  mathMode: false,
  timer: null,
  alarms: [],
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

  addTab: (opts) => {
    const tab = makeTab(opts);
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },
  closeTab: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const tabs = s.tabs.filter((t) => t.id !== id);
      // Always keep at least one tab open.
      if (tabs.length === 0) {
        const fresh = makeTab();
        return { tabs: [fresh], activeTabId: fresh.id };
      }
      let activeTabId = s.activeTabId;
      if (id === s.activeTabId) {
        const neighbor = tabs[Math.min(idx, tabs.length - 1)];
        activeTabId = neighbor.id;
      }
      return { tabs, activeTabId };
    }),
  setActiveTab: (id) => set({ activeTabId: id }),
  reorderTabs: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || from >= s.tabs.length) return s;
      const tabs = [...s.tabs];
      const [moved] = tabs.splice(from, 1);
      const target = to > from ? to - 1 : to;
      tabs.splice(Math.max(0, Math.min(target, tabs.length)), 0, moved);
      return { tabs };
    }),
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
          ? { ...t, filePath: path, fileName: fileNameFromPath(path), dirty: false }
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
  setTimer: (t) => set({ timer: t }),
  addAlarm: (at) =>
    set((s) => ({
      alarms: [...s.alarms, { id: `${at}-${Math.random().toString(36).slice(2, 8)}`, at }].sort(
        (a, b) => a.at - b.at
      ),
    })),
  removeAlarm: (id) => set((s) => ({ alarms: s.alarms.filter((a) => a.id !== id) })),
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
