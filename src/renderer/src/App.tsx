import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useActiveTab, MAX_PANES } from './store';
import { DocumentView, getDocumentView } from './DocumentView';
import { SheetView } from './sheet/SheetView';
import { TabBar } from './tabs/TabBar';
import {
  openDocumentPayload,
  createNewTab,
  createNewSheet,
  stageTabForPaneMove,
  closeTabWithChecks,
  convertLossyMarkdownTabs,
} from './fileActions';
import { PreferencesPanel } from './preferences/Panel';
import { TweaksPanel } from './preferences/TweaksPanel';
import { ImageLightbox } from './ImageLightbox';
import { YouTubePreviewHover } from './editor/youtubePreview';
import { reconcileMenuCommands } from './context-menu/commands';
import './preferences/panel.css';

// Matches `.workspace-shell.split .editor-pane { min-width }` in theme.css.
const MIN_PANE_WIDTH = 220;

// What dropping a dragged tab on a pane's content does. The left half of
// another pane swaps the two panes; the right half opens the tab in a new pane
// to the right of it, or swaps when all columns are in use. On the tab's own
// pane, either half splits the tab out to that side. `left`/`width` place the
// preview overlay in workspace coordinates.
interface PaneDrop {
  kind: 'swap' | 'split';
  sourceId: string;
  targetId: string;
  side: 'left' | 'right';
  left: number;
  width: number;
}

function paneDropForPoint(
  workspace: HTMLElement,
  target: EventTarget,
  clientX: number,
  tabId: string
): PaneDrop | null {
  if (!(target instanceof Element) || target.closest('.tab-bar')) return null;
  const paneEl = target.closest<HTMLElement>('.editor-pane');
  const targetId = paneEl?.dataset.paneId;
  if (!paneEl || !targetId || !workspace.contains(paneEl)) return null;
  const { panes } = useStore.getState();
  const source = panes.find((p) => p.tabIds.includes(tabId));
  if (!source) return null;
  const rect = paneEl.getBoundingClientRect();
  const x = rect.left - workspace.getBoundingClientRect().left;
  const side = clientX < rect.left + rect.width / 2 ? 'left' : 'right';
  const half = { left: side === 'left' ? x : x + rect.width / 2, width: rect.width / 2 };
  const full = { left: x, width: rect.width };
  const canSplit = panes.length < MAX_PANES;
  if (source.id === targetId) {
    if (!canSplit || source.tabIds.length <= 1) return null;
    return { kind: 'split', sourceId: source.id, targetId, side, ...half };
  }
  if (side === 'right' && canSplit) {
    return { kind: 'split', sourceId: source.id, targetId, side, ...half };
  }
  return { kind: 'swap', sourceId: source.id, targetId, side, ...full };
}

const samePaneDrop = (a: PaneDrop | null, b: PaneDrop | null) =>
  a === b ||
  (!!a && !!b && a.kind === b.kind && a.targetId === b.targetId && a.side === b.side &&
    a.left === b.left && a.width === b.width);

export function App(): JSX.Element {
  const tabs = useStore((s) => s.tabs);
  const panes = useStore((s) => s.panes);
  const activePaneId = useStore((s) => s.activePaneId);
  const activeTab = useActiveTab();
  const resizePanes = useStore((s) => s.resizePanes);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const splitTabBesidePane = useStore((s) => s.splitTabBesidePane);
  const swapPaneTabs = useStore((s) => s.swapPaneTabs);
  const mathMode = useStore((s) => s.mathMode);
  const toggleMathMode = useStore((s) => s.toggleMathMode);
  const preferences = useStore((s) => s.preferences);
  const setPreferences = useStore((s) => s.setPreferences);
  const setPrefsOpen = useStore((s) => s.setPrefsPanelOpen);
  const wordCountPopover = useStore((s) => s.wordCountPopover);
  const setWordCountPopover = useStore((s) => s.setWordCountPopover);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [activeDropPaneId, setActiveDropPaneId] = useState<string | null>(null);
  const [splitDrop, setSplitDrop] = useState<PaneDrop | null>(null);
  // One drop can reach the workspace twice (BlockNote re-dispatches a drop
  // that lands on the editor), and the second run would split the already-moved
  // layout again. Set when a tab drag starts and consumed by the first drop.
  const pendingSplitDragRef = useRef<string | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const startupInitialized = useRef(false);

  const tabById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);

  const handleWorkspaceDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const workspace = workspaceRef.current;
      const drop =
        draggedTabId && workspace
          ? paneDropForPoint(workspace, e.target, e.clientX, draggedTabId)
          : null;
      setSplitDrop((prev) => (samePaneDrop(prev, drop) ? prev : drop));
      if (drop) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    },
    [draggedTabId]
  );

  const handleWorkspaceDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const workspace = workspaceRef.current;
      if (!workspace || !draggedTabId || pendingSplitDragRef.current !== draggedTabId) return;
      const drop = paneDropForPoint(workspace, e.target, e.clientX, draggedTabId);
      if (!drop) return;
      e.preventDefault();
      e.stopPropagation();
      pendingSplitDragRef.current = null;
      if (drop.kind === 'swap') {
        swapPaneTabs(drop.sourceId, drop.targetId);
      } else {
        const tabId = draggedTabId;
        void (async () => {
          await stageTabForPaneMove(tabId);
          splitTabBesidePane(tabId, drop.targetId, drop.side);
        })();
      }
      setDraggedTabId(null);
      setActiveDropPaneId(null);
      setSplitDrop(null);
    },
    [draggedTabId, splitTabBesidePane, swapPaneTabs]
  );

  const handleWorkspaceDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (!next || !(next instanceof Node) || !e.currentTarget.contains(next)) {
      setSplitDrop(null);
    }
  }, []);

  // Dragging a divider trades width between the two panes it separates; the
  // other pane (in a three-column split) keeps its size.
  const handleSplitDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, leftId: string, rightId: string) => {
      if (e.button !== 0) return;
      const workspace = workspaceRef.current;
      const divider = e.currentTarget;
      const leftEl = divider.previousElementSibling;
      const rightEl = divider.nextElementSibling;
      if (!workspace || !leftEl || !rightEl) return;
      const panesNow = useStore.getState().panes;
      const leftPane = panesNow.find((p) => p.id === leftId);
      const rightPane = panesNow.find((p) => p.id === rightId);
      if (!leftPane || !rightPane) return;
      e.preventDefault();
      e.stopPropagation();
      const start = leftEl.getBoundingClientRect().left;
      const total = rightEl.getBoundingClientRect().right - start;
      const sizeSum = leftPane.size + rightPane.size;
      if (total <= MIN_PANE_WIDTH * 2) return;
      divider.setPointerCapture(e.pointerId);
      workspace.classList.add('resizing-split');
      document.body.style.cursor = 'col-resize';

      const onMove = (ev: PointerEvent): void => {
        const leftPx = Math.min(total - MIN_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, ev.clientX - start));
        const frac = leftPx / total;
        resizePanes(leftId, sizeSum * frac, rightId, sizeSum * (1 - frac));
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        workspace.classList.remove('resizing-split');
        document.body.style.cursor = '';
        try {
          divider.releasePointerCapture(e.pointerId);
        } catch {
          // ignore — capture may already be released
        }
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    },
    [resizePanes]
  );

  const activatePane = useCallback(
    (paneId: string) => {
      const pane = useStore.getState().panes.find((p) => p.id === paneId);
      if (pane) setActiveTab(pane.activeTabId);
    },
    [setActiveTab]
  );

  // Apply CSS variables from preferences.
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--page-width', `${preferences.pageWidth}px`);
    r.setProperty('--two-column-page-width', `${preferences.twoColumnPageWidth}px`);
    r.setProperty('--line-height', `${preferences.lineHeight}`);
    r.setProperty('--paragraph-spacing', `${preferences.paragraphSpacing}px`);
    r.setProperty('--top-padding', `${preferences.topPadding}px`);
    r.setProperty('--heading-1-size', `${preferences.heading1Scale}em`);
    r.setProperty('--heading-2-size', `${preferences.heading2Scale}em`);
    r.setProperty('--heading-3-size', `${preferences.heading3Scale}em`);
    r.setProperty('--side-menu-block-height', `${preferences.lineHeight}em`);
    r.setProperty('--side-menu-heading-1-height', `${preferences.heading1Scale * 1.25}em`);
    r.setProperty('--side-menu-heading-2-height', `${preferences.heading2Scale * 1.3}em`);
    r.setProperty('--side-menu-heading-3-height', `${preferences.heading3Scale * 1.35}em`);
    document.documentElement.setAttribute('data-code-wrap', preferences.codeWrap ? 'true' : 'false');
  }, [preferences]);

  // Preferences are restored before mount; normalize the command list, then
  // tell main this window is ready for any queued Finder opens. Without one the
  // window keeps its starter tab: a blank, unsaved note.
  useEffect(() => {
    // StrictMode remounts effects; initialization must only run once per window.
    if (startupInitialized.current) return;
    startupInitialized.current = true;
    (async () => {
      const stored = useStore.getState().preferences;
      const menuCommands = reconcileMenuCommands(stored.menuCommands);
      const menuCommandsChanged =
        JSON.stringify(menuCommands) !== JSON.stringify(stored.menuCommands ?? []);
      setPreferences({ ...stored, menuCommands });
      // Persist registry additions immediately so they become real rows in the
      // customizable preferences list, not temporary context-menu-only items.
      if (menuCommandsChanged) await window.api.prefs.set('menuCommands', menuCommands);
      await window.api.notifyReady();
    })();
  }, [setPreferences]);

  // Keep the OS window title / edited-dot in sync with the active tab.
  useEffect(() => {
    window.api.window.setDirty(activeTab.dirty);
    window.api.window.setTitle(activeTab.fileName);
  }, [activeTab.dirty, activeTab.fileName]);

  // Expose dirty/save for native close confirmation, across all tabs.
  useEffect(() => {
    // Runs before main's dirty check: offers to convert any Markdown note that
    // picked up formatting Markdown can't store.
    window.__simpleNote_beforeClose = async () => {
      await convertLossyMarkdownTabs();
      return true;
    };
    window.__simpleNote_isDirty = () =>
      useStore.getState().tabs.some(
        (t) => t.dirty && (getDocumentView(t.id)?.hasContent() ?? false)
      );
    window.__simpleNote_save = async () => {
      let allOk = true;
      for (const t of useStore.getState().tabs) {
        if (t.dirty && (getDocumentView(t.id)?.hasContent() ?? false)) {
          const ok = await getDocumentView(t.id)?.save();
          if (!ok) allOk = false;
        }
      }
      // file:save retitles the window after whichever tab it wrote; put the
      // active tab's title back.
      const s = useStore.getState();
      const active = s.tabs.find((t) => t.id === s.activeTabId);
      if (active) {
        window.api.window.setTitle(active.fileName);
        window.api.window.setDirty(active.dirty);
      }
      return allOk;
    };
    return () => {
      delete window.__simpleNote_beforeClose;
      delete window.__simpleNote_isDirty;
      delete window.__simpleNote_save;
    };
  });

  // Documents pushed in by main (Finder open / File → Open / a tab moved from
  // another window) open as tabs.
  useEffect(() => {
    return window.api.onOpenInTab((doc) => void openDocumentPayload(doc));
  }, []);

  // Wire menu commands.
  useEffect(() => {
    const off = window.api.onMenu((cmd) => {
      const s = useStore.getState();
      const id = s.activeTabId;
      switch (cmd) {
        case 'save':
          void getDocumentView(id)?.save();
          break;
        case 'new-tab':
          createNewTab();
          break;
        case 'new-sheet':
          createNewSheet();
          break;
        case 'close-tab-or-window':
          if (s.tabs.length > 1) void closeTabWithChecks(id);
          else window.api.window.close();
          break;
        case 'preferences':
          setPrefsOpen(true);
          break;
        case 'tweaks': {
          s.setTweaksPanelOpen(!s.tweaksPanelOpen);
          break;
        }
        case 'toggle-math':
          toggleMathMode();
          break;
        case 'push-article-left':
          s.shiftTabColumn(id, 'left');
          s.setTabDirty(id, true);
          break;
        case 'push-article-right':
          s.shiftTabColumn(id, 'right');
          s.setTabDirty(id, true);
          break;
        case 'find':
          getDocumentView(id)?.openFind(false);
          break;
        case 'find-replace':
          getDocumentView(id)?.openFind(true);
          break;
        case 'find-next':
          getDocumentView(id)?.findNext();
          break;
        case 'find-prev':
          getDocumentView(id)?.findPrev();
          break;
        case 'paste-plain':
          getDocumentView(id)?.pastePlainText();
          break;
        case 'remove-paragraph-breaks':
          getDocumentView(id)?.removeParagraphBreaks();
          break;
        case 's2t':
        case 'half2full':
        case 'clear-format':
        case 'word-count':
          window.dispatchEvent(new CustomEvent('simple-note:command', { detail: cmd }));
          break;
      }
    });
    return off;
  }, [setPrefsOpen, toggleMathMode]);

  return (
    <div className="window-root">
      <div className="main-area">
        <div
          className={`workspace-shell${panes.length > 1 ? ' split' : ''}`}
          ref={workspaceRef}
          onDragOverCapture={handleWorkspaceDragOver}
          onDropCapture={handleWorkspaceDrop}
          onDragLeave={handleWorkspaceDragLeave}
        >
          {panes.map((pane, index) => (
            <Fragment key={pane.id}>
              {index > 0 && (
                <div
                  className="split-divider"
                  role="separator"
                  aria-orientation="vertical"
                  onPointerDown={(e) =>
                    handleSplitDividerPointerDown(e, panes[index - 1].id, pane.id)
                  }
                />
              )}
              <section
                className={`editor-pane${pane.id === activePaneId ? ' active-pane' : ''}`}
                data-pane-id={pane.id}
                style={
                  panes.length > 1
                    ? { flexGrow: pane.size, flexBasis: 0 }
                    : undefined
                }
              >
                <TabBar
                  paneId={pane.id}
                  clearTrafficLights={index === 0}
                  draggingTabId={draggedTabId}
                  activeDropPaneId={activeDropPaneId}
                  onTabDragStart={(tabId) => {
                    pendingSplitDragRef.current = tabId;
                    setDraggedTabId(tabId);
                    setActiveDropPaneId(pane.id);
                  }}
                  onTabDragOverPane={setActiveDropPaneId}
                  onTabDragEnd={() => {
                    setDraggedTabId(null);
                    setActiveDropPaneId(null);
                    setSplitDrop(null);
                  }}
                />
                <div
                  className="tab-content"
                  onPointerDownCapture={() => activatePane(pane.id)}
                  onFocusCapture={() => activatePane(pane.id)}
                >
                  {pane.tabIds.map((tabId) => {
                    const t = tabById.get(tabId);
                    if (!t) return null;
                    return t.kind === 'sheet' ? (
                      <SheetView key={t.id} tabId={t.id} active={t.id === pane.activeTabId} />
                    ) : (
                      <DocumentView key={t.id} tabId={t.id} active={t.id === pane.activeTabId} />
                    );
                  })}
                </div>
              </section>
            </Fragment>
          ))}
          {splitDrop && (
            <div
              className="split-drop-overlay"
              style={{ left: splitDrop.left + 6, width: Math.max(0, splitDrop.width - 12) }}
            />
          )}
        </div>
      </div>

      <div className="status-bar">
        {mathMode && <div className="math-badge">數學模式</div>}
      </div>

      <PreferencesPanel />
      <TweaksPanel />
      <ImageLightbox />
      <YouTubePreviewHover />
      {wordCountPopover && (
        <div className="word-count-popover">
          <div className="word-count-row">
            <span>字元數</span>
            <span>{wordCountPopover.chars}</span>
          </div>
          <div className="word-count-row">
            <span>不含空白</span>
            <span>{wordCountPopover.charsNoSpace}</span>
          </div>
          <div className="word-count-row">
            <span>中文字</span>
            <span>{wordCountPopover.chinese}</span>
          </div>
          <div className="word-count-row">
            <span>英文字 (words)</span>
            <span>{wordCountPopover.count}</span>
          </div>
          <button className="word-count-close" onClick={() => setWordCountPopover(null)}>
            完成
          </button>
        </div>
      )}
    </div>
  );
}
