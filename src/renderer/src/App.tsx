import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, useActiveTab } from './store';
import { DocumentView, getDocumentView } from './DocumentView';
import { ImageView } from './ImageView';
import { Sidebar } from './sidebar/Sidebar';
import { TabBar } from './tabs/TabBar';
import {
  openFileInTab,
  refreshVaultTree,
  createNewTab,
  createBlankVaultNote,
  isPathInVault,
  forgetLastEditedFile,
  stageTabForPaneMove,
} from './fileActions';
import { PreferencesPanel } from './preferences/Panel';
import { ImageLightbox } from './ImageLightbox';
import { YouTubePreviewHover } from './editor/youtubePreview';
import { formatRemaining, formatAlarmLabel } from './timer/parse';
import { playAlarm, stopAlarm } from './timer/sound';
import { installSpeechShortcut } from './context-menu/speech';
import './preferences/panel.css';

export function App(): JSX.Element {
  const tabs = useStore((s) => s.tabs);
  const panes = useStore((s) => s.panes);
  const activeTabId = useStore((s) => s.activeTabId);
  const activePaneId = useStore((s) => s.activePaneId);
  const activeTab = useActiveTab();
  const splitRatio = useStore((s) => s.splitRatio);
  const setSplitRatio = useStore((s) => s.setSplitRatio);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const splitTabToSide = useStore((s) => s.splitTabToSide);
  const mathMode = useStore((s) => s.mathMode);
  const toggleMathMode = useStore((s) => s.toggleMathMode);
  const preferences = useStore((s) => s.preferences);
  const setPreferences = useStore((s) => s.setPreferences);
  const setPrefsOpen = useStore((s) => s.setPrefsPanelOpen);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const vaultPath = useStore((s) => s.vaultPath);
  const wordCountPopover = useStore((s) => s.wordCountPopover);
  const setWordCountPopover = useStore((s) => s.setWordCountPopover);
  const timer = useStore((s) => s.timer);
  const setTimer = useStore((s) => s.setTimer);
  const alarms = useStore((s) => s.alarms);
  const removeAlarm = useStore((s) => s.removeAlarm);

  // True while the alarm sound is ringing; shows a dismiss chip.
  const [ringing, setRinging] = useState(false);
  // A 1-second tick that drives the countdown display and fires notifications.
  const [now, setNow] = useState(() => Date.now());
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [activeDropPaneId, setActiveDropPaneId] = useState<string | null>(null);
  const [splitDropSide, setSplitDropSide] = useState<'left' | 'right' | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);

  const tabById = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);

  // Register the Shift+Cmd+P pronunciation-replay shortcut once for the app.
  useEffect(() => {
    installSpeechShortcut();
  }, []);

  useEffect(() => {
    if (!timer && alarms.length === 0) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timer, alarms.length]);

  useEffect(() => {
    const t = Date.now();
    let fired = false;
    if (timer && t >= timer.endsAt) {
      window.api.notify.show('計時器', '時間到');
      setTimer(null);
      fired = true;
    }
    for (const a of alarms) {
      if (t >= a.at) {
        window.api.notify.show('鬧鐘', formatAlarmLabel(a.at));
        removeAlarm(a.id);
        fired = true;
      }
    }
    if (fired) {
      playAlarm(10, () => setRinging(false));
      setRinging(true);
    }
  }, [now, timer, alarms, setTimer, removeAlarm]);

  const stopRinging = useCallback(() => {
    stopAlarm();
    setRinging(false);
  }, []);

  const canDropTabToSide = useCallback((tabId: string, side: 'left' | 'right'): boolean => {
    const s = useStore.getState();
    if (s.panes.length === 1) {
      const pane = s.panes[0];
      return pane.tabIds.includes(tabId) && pane.tabIds.length > 1;
    }
    const targetPane = side === 'left' ? s.panes[0] : s.panes[s.panes.length - 1];
    const sourcePane = s.panes.find((p) => p.tabIds.includes(tabId));
    return !!targetPane && !!sourcePane && targetPane.id !== sourcePane.id;
  }, []);

  const splitSideForPoint = useCallback(
    (clientX: number, tabId: string | null): 'left' | 'right' | null => {
      const workspace = workspaceRef.current;
      if (!workspace || !tabId) return null;
      const rect = workspace.getBoundingClientRect();
      const edgeWidth = Math.min(240, Math.max(120, rect.width * 0.24));
      const side =
        clientX <= rect.left + edgeWidth
          ? 'left'
          : clientX >= rect.right - edgeWidth
            ? 'right'
            : null;
      return side && canDropTabToSide(tabId, side) ? side : null;
    },
    [canDropTabToSide]
  );

  const handleWorkspaceDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!draggedTabId) {
        setSplitDropSide(null);
        return;
      }
      const side = splitSideForPoint(e.clientX, draggedTabId);
      setSplitDropSide(side);
      if (side) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      }
    },
    [draggedTabId, splitSideForPoint]
  );

  const handleWorkspaceDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!draggedTabId) return;
      const side = splitDropSide ?? splitSideForPoint(e.clientX, draggedTabId);
      if (!side) return;
      e.preventDefault();
      e.stopPropagation();
      void (async () => {
        await stageTabForPaneMove(draggedTabId);
        splitTabToSide(draggedTabId, side);
      })();
      setDraggedTabId(null);
      setActiveDropPaneId(null);
      setSplitDropSide(null);
    },
    [draggedTabId, splitDropSide, splitSideForPoint, splitTabToSide]
  );

  const handleWorkspaceDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (!next || !(next instanceof Node) || !e.currentTarget.contains(next)) {
      setSplitDropSide(null);
    }
  }, []);

  const handleSplitDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const workspace = workspaceRef.current;
      if (!workspace) return;
      e.preventDefault();
      e.stopPropagation();
      const divider = e.currentTarget;
      divider.setPointerCapture(e.pointerId);
      workspace.classList.add('resizing-split');
      document.body.style.cursor = 'col-resize';

      const onMove = (ev: PointerEvent): void => {
        const rect = workspace.getBoundingClientRect();
        if (rect.width <= 0) return;
        setSplitRatio((ev.clientX - rect.left) / rect.width);
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
    [setSplitRatio]
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
    r.setProperty('--sidebar-width', `${preferences.sidebarWidth}px`);
    document.documentElement.setAttribute('data-code-wrap', preferences.codeWrap ? 'true' : 'false');
  }, [preferences]);

  // Load preferences + vault state once on mount.
  useEffect(() => {
    (async () => {
      const stored = (await window.api.prefs.get()) as Partial<typeof preferences>;
      setPreferences(stored);
      useStore.getState().setSidebarOpen(stored.sidebarOpen ?? true);
      useStore.getState().setSortMode(stored.sortMode ?? 'manual');
      useStore.getState().setSortAsc(stored.sortAsc ?? true);
      if (stored.blankNoteFirstLineFormat) {
        const s = useStore.getState();
        const stillBlank =
          s.tabs.length === 1 && !s.tabs[0]?.filePath && !s.tabs[0]?.dirty;
        if (stillBlank) {
          s.updateTab(s.tabs[0].id, {
            blankFirstLineFormat: stored.blankNoteFirstLineFormat,
          });
        }
      }
      const vp = await window.api.vault.get();
      useStore.getState().setVaultPath(vp);
      if (vp) await refreshVaultTree();
      if (stored.startupBehavior === 'lastEdited' && stored.lastEditedFilePath) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        const s = useStore.getState();
        const stillBlank =
          s.tabs.length === 1 && !s.tabs[0]?.filePath && !s.tabs[0]?.dirty;
        if (stillBlank) {
          const opened = await openFileInTab(stored.lastEditedFilePath, undefined, {
            autoFocus: true,
          });
          if (!opened) forgetLastEditedFile(stored.lastEditedFilePath);
        }
      } else if (stored.startupBehavior === 'newBlankInVault') {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        const s = useStore.getState();
        const stillBlank =
          s.tabs.length === 1 && !s.tabs[0]?.filePath && !s.tabs[0]?.dirty;
        if (stillBlank) await createBlankVaultNote();
      }
    })();
  }, [setPreferences]);

  // Keep the OS window title / edited-dot in sync with the active tab.
  useEffect(() => {
    window.api.window.setDirty(activeTab.dirty);
    window.api.window.setTitle(activeTab.fileName);
  }, [activeTab.dirty, activeTab.fileName]);

  // Switching to a tab whose file lives in the vault also selects that file in
  // the sidebar (which reveals + highlights it).
  useEffect(() => {
    if (activeTab.filePath && isPathInVault(activeTab.filePath)) {
      useStore.getState().setSelectedPath(activeTab.filePath);
    }
  }, [activeTabId, activeTab.filePath, vaultPath]);

  // Expose dirty/save for native close confirmation, across all tabs.
  useEffect(() => {
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
      return allOk;
    };
    return () => {
      delete window.__simpleNote_isDirty;
      delete window.__simpleNote_save;
    };
  });

  const handleToggleSidebar = useCallback(() => {
    const next = !useStore.getState().sidebarOpen;
    useStore.getState().setSidebarOpen(next);
    void window.api.prefs.set('sidebarOpen', next);
  }, []);

  // Files pushed in by main (Finder open / File → Open / new window) open as tabs.
  useEffect(() => {
    const offExternal = window.api.onExternalOpen(({ path, content }) => {
      void openFileInTab(path, content);
    });
    const offInTab = window.api.onOpenInTab(({ path, content }) => {
      void openFileInTab(path, content);
    });
    window.api.notifyReady();
    return () => {
      offExternal();
      offInTab();
    };
  }, []);

  // Refresh the file tree when the vault changes on disk.
  useEffect(() => window.api.onVaultChanged(() => void refreshVaultTree()), []);

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
          void createNewTab();
          break;
        case 'close-tab-or-window':
          if (s.tabs.length > 1) s.closeTab(id);
          else window.api.window.close();
          break;
        case 'toggle-sidebar':
          handleToggleSidebar();
          break;
        case 'preferences':
          setPrefsOpen(true);
          break;
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
        case 'paste-plain':
          getDocumentView(id)?.pastePlainText();
          break;
        case 's2t':
        case 'half2full':
        case 'clear-format':
        case 'lorem':
        case 'word-count':
          window.dispatchEvent(new CustomEvent('simple-note:command', { detail: cmd }));
          break;
      }
    });
    return off;
  }, [setPrefsOpen, toggleMathMode, handleToggleSidebar]);

  return (
    <div className={`window-root${sidebarOpen ? '' : ' sidebar-collapsed'}`}>
      <div className={`sidebar-shell${sidebarOpen ? ' open' : ''}`}>
        <Sidebar />
      </div>
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
                  onPointerDown={handleSplitDividerPointerDown}
                />
              )}
              <section
                className={`editor-pane${pane.id === activePaneId ? ' active-pane' : ''}`}
                style={
                  panes.length > 1
                    ? { flexGrow: index === 0 ? splitRatio : 1 - splitRatio, flexBasis: 0 }
                    : undefined
                }
              >
                <TabBar
                  paneId={pane.id}
                  onToggleSidebar={handleToggleSidebar}
                  showSidebarToggle={index === 0}
                  draggingTabId={draggedTabId}
                  activeDropPaneId={activeDropPaneId}
                  onTabDragStart={(tabId) => {
                    setDraggedTabId(tabId);
                    setActiveDropPaneId(pane.id);
                  }}
                  onTabDragOverPane={setActiveDropPaneId}
                  onTabDragEnd={() => {
                    setDraggedTabId(null);
                    setActiveDropPaneId(null);
                    setSplitDropSide(null);
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
                    return t.kind === 'image' ? (
                      <ImageView key={t.id} tabId={t.id} active={t.id === pane.activeTabId} />
                    ) : (
                      <DocumentView key={t.id} tabId={t.id} active={t.id === pane.activeTabId} />
                    );
                  })}
                </div>
              </section>
            </Fragment>
          ))}
          {splitDropSide && <div className={`split-drop-overlay ${splitDropSide}`} />}
        </div>
      </div>

      <div className="status-bar">
        {mathMode && <div className="math-badge">數學模式</div>}
        {timer && (
          <div className="status-chip timer-chip">
            {formatRemaining((timer.endsAt - Math.max(now, Date.now())) / 1000)}
          </div>
        )}
        {alarms.map((a) => (
          <button
            key={a.id}
            className="status-chip alarm-chip"
            title="點擊刪除鬧鐘"
            onClick={() => removeAlarm(a.id)}
          >
            {formatAlarmLabel(a.at)}
          </button>
        ))}
        {ringing && (
          <button className="status-chip ringing-chip" title="點擊停止鈴聲" onClick={stopRinging}>
            響鈴中・點擊停止
          </button>
        )}
      </div>

      <PreferencesPanel />
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
