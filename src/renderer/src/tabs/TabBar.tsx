import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, Tab } from '../store';
import { getDocumentView } from '../DocumentView';
import {
  refreshVaultTree,
  createNewTab,
  rememberLastEditedFile,
  forgetLastEditedFile,
  stageTabForPaneMove,
  isProtectedUnnamedNote,
  ensureVaultHasNote,
  closeTabWithChecks,
} from '../fileActions';
import { isSnotePath, withMarkdownExt, withSnoteExt } from '../noteFormat';
import { isSsheetPath, withCsvExt, withSsheetExt } from '../sheet/sheetFormat';
import { PopMenu, PopMenuState } from '../ui/PopMenu';
import './tabs.css';

interface TabBarProps {
  paneId: string;
  onToggleSidebar: () => void;
  showSidebarToggle?: boolean;
  draggingTabId?: string | null;
  activeDropPaneId?: string | null;
  onTabDragStart?: (tabId: string) => void;
  onTabDragOverPane?: (paneId: string) => void;
  onTabDragEnd?: () => void;
}

export const TAB_DRAG_TYPE = 'application/x-simple-note-tab';

// The app's own lossless file name for a tab (.snote note / .ssheet sheet).
function nativeFileName(tab: Tab): string {
  return tab.kind === 'sheet' ? withSsheetExt(tab.fileName) : withSnoteExt(tab.fileName);
}

export function TabBar({
  paneId,
  onToggleSidebar,
  showSidebarToggle = true,
  draggingTabId,
  activeDropPaneId,
  onTabDragStart,
  onTabDragOverPane,
  onTabDragEnd,
}: TabBarProps): JSX.Element {
  const tabs = useStore((s) => {
    const pane = s.panes.find((p) => p.id === paneId);
    if (!pane) return [];
    return pane.tabIds
      .map((id) => s.tabs.find((t) => t.id === id))
      .filter((t): t is Tab => !!t);
  });
  const activeTabId = useStore(
    (s) => s.panes.find((p) => p.id === paneId)?.activeTabId ?? s.activeTabId
  );
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActivePane = useStore((s) => s.setActivePane);
  const addTab = useStore((s) => s.addTab);
  const moveTabToPane = useStore((s) => s.moveTabToPane);
  const setTabFile = useStore((s) => s.setTabFile);
  const vaultPath = useStore((s) => s.vaultPath);

  const [menu, setMenu] = useState<PopMenuState | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const dragIndex = useRef<number | null>(null);

  useEffect(() => {
    if (draggingTabId) return;
    setDropGap(null);
    dragIndex.current = null;
  }, [draggingTabId]);

  const isInVault = useCallback(
    (path: string | null): boolean =>
      !!path && !!vaultPath && (path === vaultPath || path.startsWith(vaultPath + '/')),
    [vaultPath]
  );

  const duplicateTab = useCallback(async (tab: Tab) => {
    if (tab.filePath) {
      const r = await window.api.vault.duplicate(tab.filePath);
      if (r.ok && r.path) {
        await refreshVaultTree();
        const md = (await window.api.vault.read(r.path)).content ?? '';
        addTab({ filePath: r.path, initialMarkdown: md }, paneId);
      }
    } else {
      const content = (await getDocumentView(tab.id)?.buildSnote()) ?? '';
      addTab({ initialMarkdown: content, kind: tab.kind }, paneId);
    }
  }, [addTab, paneId]);

  const deleteDocument = useCallback(
    async (tab: Tab) => {
      if (!tab.filePath || !isInVault(tab.filePath)) return;
      if (isProtectedUnnamedNote(tab.filePath)) return;
      const path = tab.filePath;
      getDocumentView(tab.id)?.cancelPendingAutoSave();
      const r = await window.api.vault.delete(path);
      if (!r.ok) {
        void getDocumentView(tab.id)?.save();
        return;
      }

      const s = useStore.getState();
      forgetLastEditedFile(path);
      if (s.selectedPath === path) s.setSelectedPath(null);
      const tabsToClose = s.tabs.filter((t) => t.filePath === path).map((t) => t.id);
      for (const id of tabsToClose) {
        useStore.getState().closeTab(id);
      }
      await refreshVaultTree();
      await ensureVaultHasNote();
    },
    [isInVault]
  );

  // Both serializations of a tab's document; the chosen file extension decides
  // which one is written. For a sheet, `markdown` carries the CSV text.
  const contentsOf = useCallback(async (tab: Tab) => {
    const view = getDocumentView(tab.id);
    return {
      markdown: (await view?.buildMarkdown()) ?? '',
      snote: (await view?.buildSnote()) ?? '',
    };
  }, []);

  // "另存新檔": export a copy (defaults to the Downloads folder, in the app's own
  // format). The tab keeps pointing at its original file, so later Cmd+S still
  // saves to the vault.
  const saveAsCopy = useCallback(
    async (tab: Tab) => {
      await window.api.file.saveAs(await contentsOf(tab), nativeFileName(tab));
    },
    [contentsOf]
  );

  // "匯出成 MD 文件": a Markdown copy in the Downloads folder. Warns first when
  // the note uses formatting Markdown can't carry.
  const exportMarkdown = useCallback(async (tab: Tab) => {
    const view = getDocumentView(tab.id);
    if (!view) return;
    const features = view.lossyFeatures();
    if (features.length > 0) {
      const ok = await window.api.file.confirmLossy('export', tab.fileName, features);
      if (!ok) return;
    }
    await window.api.file.exportMarkdown(await view.buildMarkdown(), withMarkdownExt(tab.fileName));
  }, []);

  // "匯出成 CSV 文件": values only (formula results, no colours/styles).
  const exportCsv = useCallback(async (tab: Tab) => {
    const view = getDocumentView(tab.id);
    if (!view) return;
    await window.api.file.exportMarkdown(await view.buildMarkdown(), withCsvExt(tab.fileName));
  }, []);

  const saveToVault = useCallback(
    async (tab: Tab) => {
      const r = await window.api.vault.moveToVault(
        await contentsOf(tab),
        nativeFileName(tab)
      );
      if (r.ok && r.path) {
        setTabFile(tab.id, r.path);
        rememberLastEditedFile(r.path);
        await refreshVaultTree();
      }
    },
    [contentsOf, setTabFile]
  );

  const openContext = useCallback(
    (e: React.MouseEvent, tab: Tab) => {
      e.preventDefault();
      const outsideVault = !isInVault(tab.filePath);
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: '複製分頁', onClick: () => void duplicateTab(tab) },
          { label: '關閉分頁', onClick: () => void closeTabWithChecks(tab.id) },
          {
            label: '開啟在新視窗',
            disabled: !tab.filePath,
            onClick: () => tab.filePath && window.api.window.openInNewWindow(tab.filePath),
          },
          { label: '另存新檔…', onClick: () => void saveAsCopy(tab) },
          {
            label: '另存到儲存庫',
            disabled: !outsideVault,
            onClick: () => void saveToVault(tab),
          },
          tab.kind === 'sheet'
            ? {
                label: '匯出成 CSV 文件…',
                disabled: !!tab.filePath && !isSsheetPath(tab.filePath),
                onClick: () => void exportCsv(tab),
              }
            : {
                label: '匯出成 MD 文件…',
                disabled: !isSnotePath(tab.filePath),
                onClick: () => void exportMarkdown(tab),
              },
          { divider: true },
          {
            label: '刪除文件',
            danger: true,
            disabled: outsideVault || isProtectedUnnamedNote(tab.filePath),
            onClick: () => void deleteDocument(tab),
          },
        ],
      });
    },
    [isInVault, duplicateTab, saveAsCopy, exportMarkdown, exportCsv, saveToVault, deleteDocument]
  );

  const onDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE) && dragIndex.current === null) return;
    e.preventDefault();
    e.stopPropagation();
    onTabDragOverPane?.(paneId);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const gap = e.clientX < rect.left + rect.width / 2 ? index : index + 1;
    setDropGap(gap);
  }, [onTabDragOverPane, paneId]);

  const onStripDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE) && dragIndex.current === null) return;
    e.preventDefault();
    e.stopPropagation();
    onTabDragOverPane?.(paneId);
    setDropGap(tabs.length);
  }, [onTabDragOverPane, paneId, tabs.length]);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const tabId = e.dataTransfer.getData(TAB_DRAG_TYPE);
    setDropGap(null);
    dragIndex.current = null;
    onTabDragEnd?.();
    if (tabId) {
      void (async () => {
        await stageTabForPaneMove(tabId);
        moveTabToPane(tabId, paneId, dropGap ?? tabs.length);
      })();
    }
  }, [dropGap, moveTabToPane, onTabDragEnd, paneId, tabs.length]);

  const showDropLine = draggingTabId && activeDropPaneId === paneId;

  return (
    <div className={`tab-bar${showSidebarToggle ? ' with-sidebar-control' : ''}`}>
      {showSidebarToggle && (
        <button className="sidebar-toggle" title="切換側邊欄 (⇧⌘F)" onClick={onToggleSidebar}>
          <PanelLeftIcon />
        </button>
      )}
      <div className="tab-strip" onDragOver={onStripDragOver} onDrop={onDrop}>
        {tabs.map((tab, i) => (
          <div className="tab-slot" key={tab.id}>
            {showDropLine && dropGap === i && <div className="tab-drop-line" />}
            <div
              className={`tab${tab.id === activeTabId ? ' active' : ''}`}
              draggable
              onClick={() => setActiveTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) void closeTabWithChecks(tab.id);
              }}
              onContextMenu={(e) => openContext(e, tab)}
              onDragStart={(e) => {
                dragIndex.current = i;
                setActiveTab(tab.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
                onTabDragStart?.(tab.id);
              }}
              onDragOver={(e) => onDragOver(e, i)}
              onDrop={onDrop}
              onDragEnd={() => {
                setDropGap(null);
                dragIndex.current = null;
                onTabDragEnd?.();
              }}
              title={tab.filePath ?? tab.fileName}
            >
              <span className="tab-name">{tab.fileName}</span>
              {tab.dirty && <span className="dirty-dot" aria-hidden="true" />}
              <button
                className="tab-close"
                title="關閉分頁"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTabWithChecks(tab.id);
                }}
              >
                <CloseIcon />
              </button>
            </div>
            {showDropLine && dropGap === tabs.length && i === tabs.length - 1 && (
              <div className="tab-drop-line" />
            )}
          </div>
        ))}
        <button
          className="tab-new"
          title="新分頁"
          onClick={() => {
            setActivePane(paneId);
            void createNewTab();
          }}
        >
          <PlusIcon />
        </button>
      </div>
      {menu && <PopMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
function PlusIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
function PanelLeftIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </svg>
  );
}
