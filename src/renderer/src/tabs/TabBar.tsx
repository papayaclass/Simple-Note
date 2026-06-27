import { useCallback, useRef, useState } from 'react';
import { useStore, Tab } from '../store';
import { getDocumentView } from '../DocumentView';
import { refreshVaultTree, createNewTab } from '../fileActions';
import { PopMenu, PopMenuState } from '../ui/PopMenu';
import './tabs.css';

export function TabBar({ onToggleSidebar }: { onToggleSidebar: () => void }): JSX.Element {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const setActiveTab = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const addTab = useStore((s) => s.addTab);
  const reorderTabs = useStore((s) => s.reorderTabs);
  const setTabFile = useStore((s) => s.setTabFile);
  const vaultPath = useStore((s) => s.vaultPath);

  const [menu, setMenu] = useState<PopMenuState | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const dragIndex = useRef<number | null>(null);

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
        addTab({ filePath: r.path, initialMarkdown: md });
      }
    } else {
      const md = (await getDocumentView(tab.id)?.buildMarkdown()) ?? '';
      addTab({ initialMarkdown: md });
    }
  }, [addTab]);

  const saveToVault = useCallback(
    async (tab: Tab) => {
      const md = (await getDocumentView(tab.id)?.buildMarkdown()) ?? '';
      const r = await window.api.vault.moveToVault(md, `${tab.fileName}.md`);
      if (r.ok && r.path) {
        setTabFile(tab.id, r.path);
        await refreshVaultTree();
      }
    },
    [setTabFile]
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
          { label: '關閉分頁', onClick: () => closeTab(tab.id) },
          {
            label: '開啟在新視窗',
            disabled: !tab.filePath,
            onClick: () => tab.filePath && window.api.window.openInNewWindow(tab.filePath),
          },
          {
            label: '另存到儲存庫',
            disabled: !outsideVault,
            onClick: () => void saveToVault(tab),
          },
        ],
      });
    },
    [isInVault, duplicateTab, closeTab, saveToVault]
  );

  const onDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (dragIndex.current === null) return;
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const gap = e.clientX < rect.left + rect.width / 2 ? index : index + 1;
    setDropGap(gap);
  }, []);

  const onDrop = useCallback(() => {
    const from = dragIndex.current;
    if (from !== null && dropGap !== null) reorderTabs(from, dropGap);
    setDropGap(null);
    dragIndex.current = null;
  }, [dropGap, reorderTabs]);

  return (
    <div className="tab-bar">
      <button className="sidebar-toggle" title="切換側邊欄 (⇧⌘F)" onClick={onToggleSidebar}>
        <PanelLeftIcon />
      </button>
      <div className="tab-strip">
        {tabs.map((tab, i) => (
          <div className="tab-slot" key={tab.id}>
            {dropGap === i && <div className="tab-drop-line" />}
            <div
              className={`tab${tab.id === activeTabId ? ' active' : ''}`}
              draggable
              onClick={() => setActiveTab(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(tab.id);
              }}
              onContextMenu={(e) => openContext(e, tab)}
              onDragStart={() => {
                dragIndex.current = i;
              }}
              onDragOver={(e) => onDragOver(e, i)}
              onDrop={onDrop}
              onDragEnd={() => {
                setDropGap(null);
                dragIndex.current = null;
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
                  closeTab(tab.id);
                }}
              >
                <CloseIcon />
              </button>
            </div>
            {dropGap === tabs.length && i === tabs.length - 1 && (
              <div className="tab-drop-line" />
            )}
          </div>
        ))}
        <button className="tab-new" title="新分頁" onClick={() => void createNewTab()}>
          <PlusIcon />
        </button>
      </div>
      {menu && <PopMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
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
