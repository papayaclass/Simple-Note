import { create } from 'zustand';
import { DEFAULT_MENU_COMMANDS, MenuItemPref } from './context-menu/commands';
import { isSheetPath } from './sheet/sheetFormat';

export type BlankFirstLineFormat = 'heading1' | 'heading2' | 'heading3' | 'paragraph';

// Column layout as the article's position on a `[left] — center — [right]` track.
// `center` is single-column; the other two reveal an independent blank column on
// the opposite side (article-left reveals the right column, and vice versa).
export type ColumnLayout = 'center' | 'article-left' | 'article-right';

export type TabKind = 'editor' | 'sheet';

export const MAX_PANES = 3;

export interface TabPane {
  id: string;
  tabIds: string[];
  activeTabId: string;
  // Relative width (flex-grow). Panes are reset to equal sizes when a split
  // adds one; dragging a divider trades size between its two neighbours.
  size: number;
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
  // Whether the editor grabs focus when this tab first mounts.
  autoFocus: boolean;
  blankFirstLineFormat: BlankFirstLineFormat;
  // Used when a tab is moved between split panes or windows. The document is
  // remounted, so the current content is staged here once and the previous
  // dirty state is restored after that load.
  restoreDirtyAfterLoad?: boolean;
  // 'editor' (default) renders a DocumentView; 'sheet' renders a SheetView
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
    blankFirstLineFormat: opts.blankFirstLineFormat ?? 'paragraph',
    kind,
  };
}

function makePane(tabId: string): TabPane {
  return {
    id: nextPaneId(),
    tabIds: [tabId],
    activeTabId: tabId,
    size: 1,
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
  mathMode: boolean;
  preferences: Preferences;
  prefsPanelOpen: boolean;
  tweaksPanelOpen: boolean;
  contextMenuOpen: boolean;
  wordCountPopover: { count: number; chars: number; charsNoSpace: number; chinese: number } | null;

  // Tab actions
  addTab: (opts?: NewTabOptions, paneId?: string) => string;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  setActivePane: (id: string) => void;
  reorderTabs: (from: number, to: number) => void;
  reorderTabsInPane: (paneId: string, from: number, to: number) => void;
  moveTabToPane: (tabId: string, paneId: string, index: number) => void;
  splitTabToSide: (tabId: string, side: 'left' | 'right') => void;
  swapPaneTabs: (paneA: string, paneB: string) => void;
  resizePanes: (leftId: string, leftSize: number, rightId: string, rightSize: number) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  // Repoint every open tab at oldPath to newPath (after a .md → .snote convert).
  retargetTabs: (oldPath: string, newPath: string) => void;
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
  setTweaksPanelOpen: (open: boolean) => void;
  setWordCountPopover: (v: AppState['wordCountPopover']) => void;

}

const FIRST_TAB = makeTab();
const FIRST_PANE = makePane(FIRST_TAB.id);

export const useStore = create<AppState>((set) => ({
  tabs: [FIRST_TAB],
  activeTabId: FIRST_TAB.id,
  panes: [FIRST_PANE],
  activePaneId: FIRST_PANE.id,
  mathMode: false,
  preferences: DEFAULT_PREFS,
  prefsPanelOpen: false,
  tweaksPanelOpen: false,
  contextMenuOpen: false,
  wordCountPopover: null,

  addTab: (opts, paneId) => {
    const tab = makeTab(opts);
    set((s) => {
      const targetPaneId = paneId ?? s.activePaneId;
      const existingPane = s.panes.find((p) => p.id === targetPaneId);
      if (!existingPane) {
        const pane = makePane(tab.id);
        return {
          tabs: [...s.tabs, tab],
          panes: [...s.panes, pane].slice(0, MAX_PANES),
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
        const fresh = makeTab();
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
      const sourcePane = s.panes.find((p) => p.tabIds.includes(tabId));
      if (!sourcePane) return s;
      const edgePane = side === 'left' ? s.panes[0] : s.panes[s.panes.length - 1];
      let panes: TabPane[];
      let activePaneId: string;
      if (s.panes.length < MAX_PANES) {
        // Room for another column: the tab opens a new pane on that side and
        // every pane goes back to an equal width.
        if (sourcePane.id === edgePane.id && sourcePane.tabIds.length <= 1) return s;
        const movedPane = makePane(tabId);
        const rest = s.panes
          .map((p) => {
            if (p.id !== sourcePane.id) return p;
            const remaining = p.tabIds.filter((id) => id !== tabId);
            return paneWithActiveTab({
              ...p,
              tabIds: remaining,
              activeTabId: p.activeTabId === tabId ? (remaining[0] ?? '') : p.activeTabId,
            });
          })
          .filter((p) => p.tabIds.length > 0);
        panes = (side === 'left' ? [movedPane, ...rest] : [...rest, movedPane]).map((p) => ({
          ...p,
          size: 1,
        }));
        activePaneId = movedPane.id;
      } else {
        // All columns in use: the tab joins the outermost pane on that side.
        if (sourcePane.id === edgePane.id) {
          return {
            panes: s.panes.map((p) => (p.id === edgePane.id ? { ...p, activeTabId: tabId } : p)),
            activePaneId: edgePane.id,
            activeTabId: tabId,
          };
        }
        panes = s.panes.map((p) => {
          const withoutMoved = p.tabIds.filter((id) => id !== tabId);
          if (p.id !== edgePane.id) {
            return {
              ...p,
              tabIds: withoutMoved,
              activeTabId: p.activeTabId === tabId ? (withoutMoved[0] ?? '') : p.activeTabId,
            };
          }
          return { ...p, tabIds: [...withoutMoved, tabId], activeTabId: tabId };
        });
        panes = panes.filter((p) => p.tabIds.length > 0).map((p) => paneWithActiveTab(p));
        activePaneId = (activePaneForTab(panes, tabId) ?? panes[0]).id;
      }
      return { panes, activePaneId, activeTabId: tabId };
    }),
  // Cmd-drag a tab onto another pane: the two panes trade places, so each
  // pane's tabs show up where the other's were. Widths stay with the position.
  // Reordering keyed panes moves their views instead of remounting them, so no
  // content staging is needed.
  swapPaneTabs: (paneA, paneB) =>
    set((s) => {
      const a = s.panes.findIndex((p) => p.id === paneA);
      const b = s.panes.findIndex((p) => p.id === paneB);
      if (a === -1 || b === -1 || a === b) return s;
      const panes = s.panes.slice();
      panes[a] = { ...s.panes[b], size: s.panes[a].size };
      panes[b] = { ...s.panes[a], size: s.panes[b].size };
      return { panes };
    }),
  resizePanes: (leftId, leftSize, rightId, rightSize) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === leftId ? { ...p, size: leftSize } : p.id === rightId ? { ...p, size: rightSize } : p
      ),
    })),
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
  setTweaksPanelOpen: (open) => set({ tweaksPanelOpen: open }),
  setWordCountPopover: (v) => set({ wordCountPopover: v }),

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
