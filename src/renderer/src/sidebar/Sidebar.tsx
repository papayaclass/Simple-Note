import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, VaultNode, SortMode } from '../store';
import {
  openFileInTab,
  openImageTab,
  isImagePath,
  isTextNotePath,
  refreshVaultTree,
  retargetLastEditedFile,
  forgetLastEditedFile,
} from '../fileActions';
import { getDocumentView } from '../DocumentView';
import { PopMenu, PopMenuItem, PopMenuState } from '../ui/PopMenu';
import './sidebar.css';

const SIDEBAR_PATH_MIME = 'application/x-simple-note-path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function parentDir(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

function replacePathPrefix(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  return path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
}

function isDescendantPath(path: string, ancestor: string): boolean {
  return path.startsWith(ancestor + '/');
}

function withoutDescendantSelections(paths: string[]): string[] {
  const sorted = [...new Set(paths)].sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const path of sorted) {
    if (!roots.some((root) => path !== root && isDescendantPath(path, root))) {
      roots.push(path);
    }
  }
  return roots;
}

function displayName(node: VaultNode): string {
  return node.type === 'file' ? node.name.replace(/\.md$/i, '') : node.name;
}

function filePathFor(file: File): string {
  try {
    return window.api.file.getPathForFile(file);
  } catch {
    return '';
  }
}

function sortChildren(
  nodes: VaultNode[],
  parentPath: string,
  sortMode: SortMode,
  manualOrder: Record<string, string[]>,
  asc = true,
  foldersOnTop = true
): VaultNode[] {
  const arr = [...nodes];
  // When enabled, folders form an implicit group above files; the active sort
  // (manual order or a key) then only orders items within each group, so files
  // never cross into the folder group and vice versa. Returns null when the two
  // nodes are in the same group and the normal comparator should decide.
  const group = (a: VaultNode, b: VaultNode): number | null =>
    foldersOnTop && a.type !== b.type ? (a.type === 'folder' ? -1 : 1) : null;
  if (sortMode === 'manual') {
    const order = manualOrder[parentPath] ?? [];
    const idx = (p: string): number => {
      const i = order.indexOf(p);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    arr.sort(
      (a, b) =>
        group(a, b) ?? (idx(a.path) - idx(b.path) || a.name.localeCompare(b.name, 'zh-Hant'))
    );
    return arr;
  }
  arr.sort((a, b) => {
    const g = group(a, b);
    if (g !== null) return g;
    let c: number;
    if (sortMode === 'name') c = a.name.localeCompare(b.name, 'zh-Hant');
    else if (sortMode === 'created') c = a.birthtimeMs - b.birthtimeMs;
    else c = a.mtimeMs - b.mtimeMs; // modified
    return asc ? c : -c;
  });
  return arr;
}

function findSiblings(tree: VaultNode[], parentPath: string, vaultPath: string): VaultNode[] {
  if (parentPath === vaultPath) return tree;
  const stack = [...tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === 'folder') {
      if (n.path === parentPath) return n.children ?? [];
      stack.push(...(n.children ?? []));
    }
  }
  return [];
}

function flattenVisibleNodes(
  nodes: VaultNode[],
  expanded: Set<string>,
  sortMode: SortMode,
  manualOrder: Record<string, string[]>,
  sortAsc: boolean,
  foldersOnTop: boolean
): VaultNode[] {
  const out: VaultNode[] = [];
  const visit = (items: VaultNode[], parentPath: string): void => {
    for (const node of sortChildren(items, parentPath, sortMode, manualOrder, sortAsc, foldersOnTop)) {
      out.push(node);
      if (node.type === 'folder' && expanded.has(node.path)) {
        visit(node.children ?? [], node.path);
      }
    }
  };
  for (const node of nodes) {
    out.push(node);
    if (node.type === 'folder' && expanded.has(node.path)) {
      visit(node.children ?? [], node.path);
    }
  }
  return out;
}

async function persistPref(key: string, value: unknown): Promise<void> {
  await window.api.prefs.set(key, value);
}

type MenuItem = PopMenuItem;
type MenuState = PopMenuState;
type DropLine = { path: string; pos: 'before' | 'after' };
type RootDrop = 'top' | 'bottom';
type DropIntent =
  | { type: 'folder'; path: string }
  | { type: 'reorder'; path: string; pos: 'before' | 'after' }
  | { type: 'root'; pos: RootDrop };
type ManualPlacement =
  | { type: 'edge'; pos: RootDrop }
  | { type: 'target'; targetPath: string; pos: 'before' | 'after' };

// ---------------------------------------------------------------------------
// Shared per-render context passed down the tree
// ---------------------------------------------------------------------------
interface TreeCtx {
  selectedPath: string | null;
  selectedPaths: Set<string>;
  renamingPath: string | null;
  sortMode: SortMode;
  sortAsc: boolean;
  foldersOnTop: boolean;
  manualOrder: Record<string, string[]>;
  expanded: Set<string>;
  // A file row being hovered for reorder (blue before/after line).
  dragOver: DropLine | null;
  // A folder being hovered as a drop target (blue overlay).
  dropFolder: string | null;
  onSelect: (node: VaultNode, event: React.MouseEvent) => void;
  onOpen: (node: VaultNode, event: React.MouseEvent) => void;
  onToggleFolder: (path: string) => void;
  onContext: (e: React.MouseEvent, node: VaultNode) => void;
  onRenameCommit: (node: VaultNode, name: string) => void;
  onRenameCancel: () => void;
  onDragStart: (e: React.DragEvent, node: VaultNode) => void;
  onDragOver: (e: React.DragEvent, node: VaultNode) => void;
  onDrop: (e: React.DragEvent, node: VaultNode) => void;
  onDragEnd: () => void;
}

function TreeItem({
  node,
  depth,
  ctx,
}: {
  node: VaultNode;
  depth: number;
  ctx: TreeCtx;
}): JSX.Element {
  const selected = ctx.selectedPaths.has(node.path) || ctx.selectedPath === node.path;
  const renaming = ctx.renamingPath === node.path;
  const isFolder = node.type === 'folder';
  const open = ctx.expanded.has(node.path);
  const draggable = !renaming;
  const dragLine =
    ctx.dragOver && ctx.dragOver.path === node.path ? ctx.dragOver.pos : null;
  const folderDrop = isFolder && ctx.dropFolder === node.path;

  const children =
    isFolder && open
      ? sortChildren(
          node.children ?? [],
          node.path,
          ctx.sortMode,
          ctx.manualOrder,
          ctx.sortAsc,
          ctx.foldersOnTop
        )
      : [];

  return (
    <div className="tree-item">
      {dragLine === 'before' && <div className="drop-line" style={{ marginLeft: depth * 14 }} />}
      <div
        className={`tree-row${selected ? ' selected' : ''}${folderDrop ? ' drop-target' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-path={node.path}
        data-type={node.type}
        draggable={draggable}
        onClick={(e) => {
          if (isFolder) {
            ctx.onSelect(node, e);
            if (!e.metaKey && !e.shiftKey) ctx.onToggleFolder(node.path);
          } else {
            ctx.onOpen(node, e);
          }
        }}
        onContextMenu={(e) => ctx.onContext(e, node)}
        onDragStart={(e) => ctx.onDragStart(e, node)}
        onDragOver={(e) => ctx.onDragOver(e, node)}
        onDrop={(e) => ctx.onDrop(e, node)}
        onDragEnd={ctx.onDragEnd}
      >
        {isFolder ? (
          <span className={`twisty${open ? ' open' : ''}`} aria-hidden="true">
            <ChevronIcon />
          </span>
        ) : (
          <span className="twisty-spacer" aria-hidden="true" />
        )}
        {renaming ? (
          <RenameInput
            initial={displayName(node)}
            onCommit={(name) => ctx.onRenameCommit(node, name)}
            onCancel={ctx.onRenameCancel}
          />
        ) : (
          <span className="tree-label">{displayName(node)}</span>
        )}
      </div>
      {dragLine === 'after' && <div className="drop-line" style={{ marginLeft: depth * 14 }} />}
      {children.map((c) => (
        <TreeItem key={c.path} node={c} depth={depth + 1} ctx={ctx} />
      ))}
    </div>
  );
}

function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);
  return (
    <input
      ref={ref}
      className="rename-input"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
export function Sidebar(): JSX.Element {
  const vaultPath = useStore((s) => s.vaultPath);
  const setVaultPath = useStore((s) => s.setVaultPath);
  const fileTree = useStore((s) => s.fileTree);
  const sortMode = useStore((s) => s.sortMode);
  const setSortMode = useStore((s) => s.setSortMode);
  const sortAsc = useStore((s) => s.sortAsc);
  const setSortAsc = useStore((s) => s.setSortAsc);
  const selectedPath = useStore((s) => s.selectedPath);
  const setSelectedPath = useStore((s) => s.setSelectedPath);
  const manualOrder = useStore((s) => s.preferences.manualOrder);
  const foldersOnTop = useStore((s) => s.preferences.foldersOnTop);
  const setPreferences = useStore((s) => s.setPreferences);
  const retargetTabs = useStore((s) => s.retargetTabs);
  const clearAutoName = useStore((s) => s.clearAutoName);

  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dragOver, setDragOver] = useState<DropLine | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  // Top/bottom drop zone for moving a file out of its folder to the vault root.
  const [rootDrop, setRootDrop] = useState<RootDrop | null>(null);
  const draggingPath = useRef<string | null>(null);
  const draggingType = useRef<'file' | 'folder' | null>(null);
  const dropIntent = useRef<DropIntent | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const externalDestDir = useRef<string | null>(null);
  const [externalDrop, setExternalDrop] = useState(false);
  const lastSelectedPath = useRef<string | null>(null);

  const hasExternalFiles = (e: React.DragEvent): boolean =>
    draggingPath.current === null && Array.from(e.dataTransfer.types).includes('Files');

  useEffect(() => {
    if (!selectedPath) {
      setSelectedPaths(new Set());
      lastSelectedPath.current = null;
      return;
    }
    setSelectedPaths((prev) => {
      if (prev.has(selectedPath)) return prev;
      return new Set([selectedPath]);
    });
    lastSelectedPath.current = selectedPath;
  }, [selectedPath]);

  const importExternalFiles = useCallback(
    async (files: FileList, destDir: string | null) => {
      const paths = Array.from(files)
        .map((f) => filePathFor(f))
        .filter(Boolean);
      if (paths.length === 0) return;
      const r = await window.api.vault.importExternal(paths, destDir);
      if (!r.ok) return;
      await refreshVaultTree();
      // Reveal what just landed: select the first item and expand any imported
      // folders (plus the drop destination) so the structure shows immediately.
      if (r.moved.length > 0) {
        setSelectedPath(r.moved[0]);
        setExpanded((prev) => {
          const next = new Set(prev);
          if (destDir) next.add(destDir);
          for (const p of r.moved) next.add(p);
          return next;
        });
      }
    },
    [setSelectedPath]
  );

  // Reveal the selected file by expanding its ancestor folders (e.g. when a tab
  // switch selects a file that lives inside a collapsed folder).
  useEffect(() => {
    if (!selectedPath || !vaultPath) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      let p = parentDir(selectedPath);
      while (p && p !== vaultPath && p.startsWith(vaultPath)) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
        p = parentDir(p);
      }
      return changed ? next : prev;
    });
  }, [selectedPath, vaultPath]);

  const chooseVault = useCallback(async () => {
    const path = await window.api.vault.pick();
    if (path) {
      setVaultPath(path);
      setPreferences({ vaultPath: path });
      await refreshVaultTree();
    }
  }, [setVaultPath, setPreferences]);

  // Target directory for new file/folder: selected folder, the folder a
  // selected file lives in, or the vault root.
  const targetDir = useCallback((): string | null => {
    if (!vaultPath) return null;
    if (!selectedPath) return vaultPath;
    const node = findNode(fileTree, selectedPath);
    if (node?.type === 'folder') return node.path;
    return parentDir(selectedPath) || vaultPath;
  }, [vaultPath, selectedPath, fileTree]);

  const newFile = useCallback(async () => {
    const dir = targetDir();
    const r = await window.api.vault.createFile(dir);
    if (r.ok && r.path) {
      await refreshVaultTree();
      setSelectedPath(r.path);
      // Focus the editor so typing a heading auto-names the file.
      void openFileInTab(r.path, '', {
        autoFocus: true,
        autoName: true,
        blankFirstLineFormat: useStore.getState().preferences.blankNoteFirstLineFormat,
      });
    }
  }, [targetDir, setSelectedPath]);

  const newFolder = useCallback(async () => {
    const dir = targetDir();
    const r = await window.api.vault.createFolder(dir);
    if (r.ok && r.path) {
      await refreshVaultTree();
      setSelectedPath(r.path);
      setRenamingPath(r.path);
    }
  }, [targetDir, setSelectedPath]);

  const changeSort = useCallback(
    (mode: SortMode) => {
      setSortMode(mode);
      void persistPref('sortMode', mode);
    },
    [setSortMode]
  );

  const changeAsc = useCallback(
    (asc: boolean) => {
      setSortAsc(asc);
      void persistPref('sortAsc', asc);
    },
    [setSortAsc]
  );

  const changeFoldersOnTop = useCallback(
    (next: boolean) => {
      setPreferences({ foldersOnTop: next });
      void persistPref('foldersOnTop', next);
    },
    [setPreferences]
  );

  const openSortMenu = useCallback(
    (x: number, y: number) => {
      const opt = (label: string, mode: SortMode): MenuItem => ({
        label,
        checked: sortMode === mode,
        onClick: () => changeSort(mode),
      });
      // Direction only applies to the keyed sort modes; greyed out for manual.
      const manual = sortMode === 'manual';
      setMenu({
        x,
        y,
        items: [
          opt('無（手動排序）', 'manual'),
          opt('依名稱', 'name'),
          opt('依建立時間', 'created'),
          opt('依修改時間', 'modified'),
          { divider: true },
          {
            label: '遞增排序',
            checked: manual ? undefined : sortAsc,
            disabled: manual,
            onClick: () => changeAsc(true),
          },
          {
            label: '遞減排序',
            checked: manual ? undefined : !sortAsc,
            disabled: manual,
            onClick: () => changeAsc(false),
          },
          { divider: true },
          {
            label: '資料夾置頂',
            checked: foldersOnTop,
            onClick: () => changeFoldersOnTop(!foldersOnTop),
          },
        ],
      });
    },
    [sortMode, sortAsc, foldersOnTop, changeSort, changeAsc, changeFoldersOnTop]
  );

  const doRename = useCallback(
    async (node: VaultNode, rawName: string) => {
      setRenamingPath(null);
      const name = rawName.trim();
      if (!name || name === displayName(node)) return;
      const r = await window.api.vault.rename(node.path, name);
      if (r.ok && r.path) {
        const newPath = r.path;
        // Repoint any open tab(s) so the tab name follows and re-selecting the
        // file activates the existing tab instead of orphaning it. A manual
        // rename also stops first-heading auto-naming.
        retargetTabs(node.path, newPath);
        retargetLastEditedFile(node.path, newPath);
        clearAutoName(newPath);
        const nextOrder: Record<string, string[]> = {};
        for (const [parent, paths] of Object.entries(useStore.getState().preferences.manualOrder)) {
          const nextParent = replacePathPrefix(parent, node.path, newPath);
          nextOrder[nextParent] = paths.map((path) => replacePathPrefix(path, node.path, newPath));
        }
        setPreferences({ manualOrder: nextOrder });
        void persistPref('manualOrder', nextOrder);
        setSelectedPath(newPath);
        await refreshVaultTree();
      }
    },
    [setSelectedPath, retargetTabs, clearAutoName, setPreferences]
  );

  const manualOrderWithPlacement = useCallback(
    (
      baseOrder: Record<string, string[]>,
      path: string,
      parentPath: string,
      placement: ManualPlacement
    ): Record<string, string[]> => {
      if (!vaultPath) return baseOrder;
      const ordered = sortChildren(
        findSiblings(fileTree, parentPath, vaultPath),
        parentPath,
        'manual',
        baseOrder,
        true,
        foldersOnTop
      )
        .map((n) => n.path)
        .filter((p) => p !== path);
      let insertAt = ordered.length;
      if (placement.type === 'edge') {
        insertAt = placement.pos === 'top' ? 0 : ordered.length;
      } else {
        const targetIndex = ordered.indexOf(placement.targetPath);
        if (targetIndex !== -1) {
          insertAt = placement.pos === 'before' ? targetIndex : targetIndex + 1;
        }
      }
      const nextPaths = [...ordered];
      nextPaths.splice(insertAt, 0, path);
      return { ...baseOrder, [parentPath]: nextPaths };
    },
    [fileTree, vaultPath, foldersOnTop]
  );

  const commitManualOrder = useCallback(
    (next: Record<string, string[]>): void => {
      setPreferences({ manualOrder: next });
      void persistPref('manualOrder', next);
    },
    [setPreferences]
  );

  // Move a node into another directory, optionally placing it in manual order.
  const doMove = useCallback(
    async (srcPath: string, destDir: string, placement?: ManualPlacement) => {
      const r = await window.api.vault.move(srcPath, destDir);
      if (r.ok && r.path) {
        const newPath = r.path;
        if (sortMode === 'manual') {
          const currentOrder = useStore.getState().preferences.manualOrder;
          const removedFromOldParent: Record<string, string[]> = {};
          for (const [parent, paths] of Object.entries(currentOrder)) {
            removedFromOldParent[parent] = paths.filter((path) => path !== srcPath);
          }
          const retargeted: Record<string, string[]> = {};
          for (const [parent, paths] of Object.entries(removedFromOldParent)) {
            const nextParent = replacePathPrefix(parent, srcPath, newPath);
            retargeted[nextParent] = paths.map((path) => replacePathPrefix(path, srcPath, newPath));
          }
          const nextOrder = placement
            ? manualOrderWithPlacement(retargeted, newPath, destDir, placement)
            : manualOrderWithPlacement(retargeted, newPath, destDir, {
                type: 'edge',
                pos: 'bottom',
              });
          commitManualOrder(nextOrder);
        }
        retargetTabs(srcPath, newPath);
        retargetLastEditedFile(srcPath, newPath);
        setSelectedPath(newPath);
        await refreshVaultTree();
      }
    },
    [sortMode, manualOrderWithPlacement, commitManualOrder, setSelectedPath, retargetTabs]
  );

  const doDeleteMany = useCallback(
    async (paths: string[]) => {
      const roots = withoutDescendantSelections(paths);
      const deletedRoots: string[] = [];
      const closeIds = new Set<string>();

      for (const path of roots) {
        const tabsForPath = useStore
          .getState()
          .tabs.filter((t) => t.filePath === path || t.filePath?.startsWith(path + '/'))
          .map((t) => t.id);

        for (const id of tabsForPath) {
          getDocumentView(id)?.cancelPendingAutoSave();
        }

        const r = await window.api.vault.delete(path);
        if (!r.ok) {
          for (const id of tabsForPath) {
            void getDocumentView(id)?.save();
          }
          continue;
        }

        deletedRoots.push(path);
        for (const id of tabsForPath) closeIds.add(id);
        forgetLastEditedFile(path);
      }

      if (deletedRoots.length === 0) return;

      const wasDeleted = (path: string): boolean =>
        deletedRoots.some((root) => path === root || isDescendantPath(path, root));

      const s = useStore.getState();
      for (const id of closeIds) {
        s.closeTab(id);
      }
      setSelectedPaths((prev) => new Set([...prev].filter((path) => !wasDeleted(path))));
      if (selectedPath && wasDeleted(selectedPath)) setSelectedPath(null);
      await refreshVaultTree();
    },
    [selectedPath, setSelectedPath]
  );

  const doDelete = useCallback(
    async (path: string) => {
      await doDeleteMany([path]);
    },
    [doDeleteMany]
  );

  const doDuplicateMany = useCallback(
    async (paths: string[]) => {
      const roots = withoutDescendantSelections(paths);
      const duplicated: string[] = [];
      for (const path of roots) {
        const r = await window.api.vault.duplicate(path);
        if (r.ok && r.path) duplicated.push(r.path);
      }
      await refreshVaultTree();
      if (duplicated.length > 0) {
        setSelectedPath(duplicated[0]);
        setSelectedPaths(new Set(duplicated));
        lastSelectedPath.current = duplicated[0];
      }
    },
    [setSelectedPath]
  );

  const doDuplicate = useCallback(
    async (path: string) => {
      await doDuplicateMany([path]);
    },
    [doDuplicateMany]
  );

  // Manual-order reordering on drop. Same-parent drops only rewrite order;
  // cross-parent before/after drops move the file to the target's parent first.
  const handlePlacementDrop = useCallback(
    (draggedPath: string, targetPath: string, pos: 'before' | 'after') => {
      if (!vaultPath || sortMode !== 'manual' || draggedPath === targetPath) return;
      const dParent = parentDir(draggedPath);
      const tParent = parentDir(targetPath);
      if (targetPath.startsWith(draggedPath + '/')) return;
      if (dParent !== tParent) {
        void doMove(draggedPath, tParent, { type: 'target', targetPath, pos });
        return;
      }
      const next = manualOrderWithPlacement(manualOrder, draggedPath, dParent, {
        type: 'target',
        targetPath,
        pos,
      });
      commitManualOrder(next);
    },
    [vaultPath, sortMode, manualOrder, manualOrderWithPlacement, commitManualOrder, doMove]
  );

  const handleRootDrop = useCallback(
    (draggedPath: string, pos: RootDrop) => {
      if (!vaultPath) return;
      if (parentDir(draggedPath) === vaultPath) {
        if (sortMode !== 'manual') return;
        const next = manualOrderWithPlacement(manualOrder, draggedPath, vaultPath, {
          type: 'edge',
          pos,
        });
        commitManualOrder(next);
      } else {
        void doMove(draggedPath, vaultPath, { type: 'edge', pos });
      }
    },
    [vaultPath, sortMode, manualOrder, manualOrderWithPlacement, commitManualOrder, doMove]
  );

  const sortedRoots = useMemo(
    () =>
      vaultPath
        ? sortChildren(fileTree, vaultPath, sortMode, manualOrder, sortAsc, foldersOnTop)
        : [],
    [fileTree, vaultPath, sortMode, manualOrder, sortAsc, foldersOnTop]
  );

  const visibleNodes = useMemo(
    () =>
      flattenVisibleNodes(
        sortedRoots,
        expanded,
        sortMode,
        manualOrder,
        sortAsc,
        foldersOnTop
      ),
    [sortedRoots, expanded, sortMode, manualOrder, sortAsc, foldersOnTop]
  );

  const visiblePaths = useMemo(() => visibleNodes.map((node) => node.path), [visibleNodes]);

  const focusSidebarSoon = useCallback(() => {
    const focus = (): void => containerRef.current?.focus();
    focus();
    requestAnimationFrame(focus);
    window.setTimeout(focus, 32);
  }, []);

  const selectSingle = useCallback(
    (path: string) => {
      setSelectedPaths(new Set([path]));
      setSelectedPath(path);
      lastSelectedPath.current = path;
      focusSidebarSoon();
    },
    [focusSidebarSoon, setSelectedPath]
  );

  const selectRange = useCallback(
    (path: string) => {
      const anchor = lastSelectedPath.current ?? selectedPath ?? path;
      const from = visiblePaths.indexOf(anchor);
      const to = visiblePaths.indexOf(path);
      if (from === -1 || to === -1) {
        selectSingle(path);
        return;
      }
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelectedPaths(new Set(visiblePaths.slice(start, end + 1)));
      setSelectedPath(path);
      focusSidebarSoon();
    },
    [focusSidebarSoon, selectSingle, selectedPath, setSelectedPath, visiblePaths]
  );

  const toggleSelection = useCallback(
    (path: string) => {
      const next = new Set(selectedPaths);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      const fallback = next.has(path) ? path : next.values().next().value ?? null;
      setSelectedPaths(next);
      setSelectedPath(fallback);
      lastSelectedPath.current = path;
      focusSidebarSoon();
    },
    [focusSidebarSoon, selectedPaths, setSelectedPath]
  );

  const selectFromClick = useCallback(
    (node: VaultNode, event: React.MouseEvent): 'single' | 'range' | 'toggle' => {
      if (event.shiftKey) {
        selectRange(node.path);
        return 'range';
      }
      if (event.metaKey) {
        toggleSelection(node.path);
        return 'toggle';
      }
      selectSingle(node.path);
      return 'single';
    },
    [selectRange, selectSingle, toggleSelection]
  );

  const openContext = useCallback(
    (e: React.MouseEvent, node: VaultNode) => {
      e.preventDefault();
      e.stopPropagation();
      const paths = selectedPaths.has(node.path) ? [...selectedPaths] : [node.path];
      const roots = withoutDescendantSelections(paths);
      const multiple = roots.length > 1;
      if (!selectedPaths.has(node.path)) {
        setSelectedPaths(new Set([node.path]));
        lastSelectedPath.current = node.path;
      }
      setSelectedPath(node.path);

      if (multiple) {
        setMenu({
          x: e.clientX,
          y: e.clientY,
          items: [
            { label: `複製 ${roots.length} 個項目`, onClick: () => void doDuplicateMany(roots) },
            {
              label: `刪除 ${roots.length} 個項目`,
              danger: true,
              onClick: () => void doDeleteMany(roots),
            },
          ],
        });
        return;
      }

      const items: MenuItem[] = [
        {
          label: '在新分頁開啟',
          onClick: () =>
            isImagePath(node.path)
              ? void openImageTab(node.path)
              : isTextNotePath(node.path)
                ? void openFileInTab(node.path)
                : undefined,
        },
        { label: '重新命名', onClick: () => setRenamingPath(node.path) },
        { label: '複製', onClick: () => void doDuplicate(node.path) },
        { label: '顯示在 Finder', onClick: () => void window.api.vault.reveal(node.path) },
        { label: '刪除', danger: true, onClick: () => void doDelete(node.path) },
      ];
      // Folders can't be opened in a tab, and neither can non-image/non-text files.
      if (node.type === 'folder' || (!isImagePath(node.path) && !isTextNotePath(node.path))) {
        items.shift();
      }
      setMenu({ x: e.clientX, y: e.clientY, items });
    },
    [selectedPaths, setSelectedPath, doDuplicate, doDuplicateMany, doDelete, doDeleteMany]
  );

  const openEmptyContext = useCallback(
    (e: React.MouseEvent) => {
      // Only when clicking the empty area, not a row.
      if ((e.target as HTMLElement).closest('.tree-row')) return;
      e.preventDefault();
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: '新增文件', onClick: () => void newFile() },
          { label: '新增資料夾', onClick: () => void newFolder() },
          // Deferred so it opens *after* PopMenu auto-closes this menu.
          { label: '排序…', onClick: () => setTimeout(() => openSortMenu(e.clientX, e.clientY), 0) },
          {
            label: '顯示於 Finder',
            disabled: !vaultPath,
            onClick: () => void window.api.vault.openSelf(),
          },
        ],
      });
    },
    [newFile, newFolder, openSortMenu]
  );

  // Enter = rename selected; Delete = trash selected.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (renamingPath) return;
      const paths = selectedPaths.size > 0 ? [...selectedPaths] : selectedPath ? [selectedPath] : [];
      if (paths.length === 0) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyD') {
        e.preventDefault();
        void doDuplicateMany(paths);
      } else if (e.key === 'Enter') {
        if (paths.length !== 1 || !selectedPath) return;
        e.preventDefault();
        setRenamingPath(selectedPath);
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        void doDeleteMany(paths);
      }
    },
    [renamingPath, selectedPath, selectedPaths, doDeleteMany, doDuplicateMany]
  );

  const ctx: TreeCtx = {
    selectedPath,
    selectedPaths,
    renamingPath,
    sortMode,
    sortAsc,
    foldersOnTop,
    manualOrder,
    expanded,
    dragOver,
    dropFolder,
    onSelect: (node, event) => {
      selectFromClick(node, event);
    },
    onOpen: (node, event) => {
      const mode = selectFromClick(node, event);
      if (mode !== 'single') return;
      if (isImagePath(node.path)) {
        void openImageTab(node.path).finally(focusSidebarSoon);
      } else if (isTextNotePath(node.path)) {
        void openFileInTab(node.path, undefined, { autoFocus: false }).finally(focusSidebarSoon);
      }
      // Other file types: select only, no open.
    },
    onToggleFolder: (path) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
    onContext: openContext,
    onRenameCommit: doRename,
    onRenameCancel: () => setRenamingPath(null),
    onDragStart: (e, node) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.path);
      e.dataTransfer.setData(SIDEBAR_PATH_MIME, node.path);
      draggingPath.current = node.path;
      draggingType.current = node.type === 'folder' ? 'folder' : 'file';
      dropIntent.current = null;
      requestAnimationFrame(() => {
        setSelectedPaths(new Set([node.path]));
        setSelectedPath(node.path);
        lastSelectedPath.current = node.path;
        containerRef.current?.focus();
      });
    },
    onDragOver: (e, node) => {
      const dragged = draggingPath.current;
      if (!dragged) return;
      if (node.type === 'folder') {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const edgeZone = rect.height * 0.28;
        const canReorderAroundFolder =
          sortMode === 'manual' &&
          dragged !== node.path &&
          !node.path.startsWith(dragged + '/') &&
          // With folders grouped on top, only a folder may reorder among
          // folders — a file dropped here would land into the folder instead.
          (!foldersOnTop || draggingType.current === 'folder');
        if (canReorderAroundFolder && e.clientY <= rect.top + edgeZone) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          dropIntent.current = { type: 'reorder', path: node.path, pos: 'before' };
          setDragOver({ path: node.path, pos: 'before' });
          setDropFolder(null);
          setRootDrop(null);
          return;
        }
        if (canReorderAroundFolder && e.clientY >= rect.bottom - edgeZone) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          dropIntent.current = { type: 'reorder', path: node.path, pos: 'after' };
          setDragOver({ path: node.path, pos: 'after' });
          setDropFolder(null);
          setRootDrop(null);
          return;
        }
        // Dropping into a folder — highlight it (skip its own subtree).
        if (dragged === node.path || node.path.startsWith(dragged + '/')) {
          dropIntent.current = null;
          setDragOver(null);
          setDropFolder(null);
          setRootDrop(null);
          return;
        }
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        dropIntent.current = { type: 'folder', path: node.path };
        setDropFolder(node.path);
        setDragOver(null);
        setRootDrop(null);
      } else if (sortMode === 'manual') {
        // With folders grouped on top, a folder can't reorder among files.
        if (dragged === node.path || (foldersOnTop && draggingType.current === 'folder')) {
          dropIntent.current = null;
          setDragOver(null);
          setDropFolder(null);
          setRootDrop(null);
          return;
        }
        // Reordering among files — show a before/after line.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const pos = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        dropIntent.current = { type: 'reorder', path: node.path, pos };
        setDragOver({ path: node.path, pos });
        setDropFolder(null);
        setRootDrop(null);
      }
    },
    onDrop: (e, _node) => {
      e.preventDefault();
      e.stopPropagation();
      const dragged = draggingPath.current;
      const intent = dropIntent.current;
      if (dragged && intent) {
        if (intent.type === 'folder') void doMove(dragged, intent.path);
        else if (intent.type === 'reorder') handlePlacementDrop(dragged, intent.path, intent.pos);
        else handleRootDrop(dragged, intent.pos);
      }
      setDragOver(null);
      setDropFolder(null);
      setRootDrop(null);
      draggingPath.current = null;
      draggingType.current = null;
      dropIntent.current = null;
    },
    onDragEnd: () => {
      setDragOver(null);
      setDropFolder(null);
      setRootDrop(null);
      draggingPath.current = null;
      draggingType.current = null;
      dropIntent.current = null;
    },
  };

  // Top/bottom edge of the tree = "move out to vault root" zone. Handled in the
  // capture phase so it wins over row-level reorder/folder handlers.
  const onTreeDragOverCapture = (e: React.DragEvent): void => {
    if (hasExternalFiles(e)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
      const destFolder = row?.dataset.type === 'folder' ? row.dataset.path ?? null : null;
      externalDestDir.current = destFolder;
      setDropFolder(destFolder);
      setExternalDrop(!destFolder);
      return;
    }
    const dragged = draggingPath.current;
    if (!dragged || !vaultPath) return;
    const canDropToRoot = parentDir(dragged) !== vaultPath || sortMode === 'manual';
    if (!canDropToRoot) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const rows = Array.from(
      (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.tree-row')
    );
    const firstRow = rows[0]?.getBoundingClientRect();
    const lastRow = rows[rows.length - 1]?.getBoundingClientRect();
    if (e.clientY <= (firstRow?.top ?? rect.top) - 4 || e.clientY <= rect.top + 16) {
      e.preventDefault();
      e.stopPropagation();
      dropIntent.current = { type: 'root', pos: 'top' };
      setRootDrop('top');
      setDragOver(null);
      setDropFolder(null);
    } else if (e.clientY >= (lastRow?.bottom ?? rect.top) + 4 || e.clientY >= rect.bottom - 16) {
      e.preventDefault();
      e.stopPropagation();
      dropIntent.current = { type: 'root', pos: 'bottom' };
      setRootDrop('bottom');
      setDragOver(null);
      setDropFolder(null);
    } else if (rootDrop) {
      dropIntent.current = null;
      setRootDrop(null);
    }
  };
  const onTreeDropCapture = (e: React.DragEvent): void => {
    if (hasExternalFiles(e)) {
      e.preventDefault();
      e.stopPropagation();
      void importExternalFiles(e.dataTransfer.files, externalDestDir.current);
      externalDestDir.current = null;
      setDropFolder(null);
      setExternalDrop(false);
      return;
    }
    const dragged = draggingPath.current;
    const intent = dropIntent.current;
    if (dragged && intent?.type === 'root') {
      e.preventDefault();
      e.stopPropagation();
      handleRootDrop(dragged, intent.pos);
      setRootDrop(null);
      setDragOver(null);
      setDropFolder(null);
      draggingPath.current = null;
      dropIntent.current = null;
    }
  };

  // Drag the right edge to resize. The sidebar sits flush to the window's left
  // edge, so the pointer's clientX is the new width (clamped). Written straight
  // to the CSS var for instant tracking, committed to prefs on release.
  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const root = document.querySelector('.window-root');
      root?.classList.add('resizing-sidebar');
      document.body.style.cursor = 'ew-resize';
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      let width = useStore.getState().preferences.sidebarWidth;
      const onMove = (ev: PointerEvent): void => {
        width = Math.min(480, Math.max(180, ev.clientX));
        document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        root?.classList.remove('resizing-sidebar');
        document.body.style.cursor = '';
        try {
          handle.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        setPreferences({ sidebarWidth: width });
        void persistPref('sidebarWidth', width);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    },
    [setPreferences]
  );

  return (
    <div className="sidebar">
      <div className="sidebar-drag" />
      <div className="sidebar-header">
        <button className="sidebar-icon-btn" title="新增文件" onClick={() => void newFile()}>
          <NewFileIcon />
        </button>
        <button className="sidebar-icon-btn" title="新增資料夾" onClick={() => void newFolder()}>
          <NewFolderIcon />
        </button>
        <button
          className="sidebar-icon-btn"
          title="排序"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openSortMenu(r.left, r.bottom + 4);
          }}
        >
          <SortIcon />
        </button>
      </div>
      <div
        className={`sidebar-tree${rootDrop ? ` root-drop-${rootDrop}` : ''}${
          externalDrop ? ' external-drop' : ''
        }`}
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={openEmptyContext}
        onDragOverCapture={onTreeDragOverCapture}
        onDropCapture={onTreeDropCapture}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            externalDestDir.current = null;
            setExternalDrop(false);
            setDropFolder(null);
          }
        }}
        onMouseDown={(e) => {
          // Click on empty area clears selection.
          if (!(e.target as HTMLElement).closest('.tree-row')) {
            setSelectedPath(null);
            setSelectedPaths(new Set());
            lastSelectedPath.current = null;
          }
        }}
      >
        {!vaultPath ? (
          <div className="sidebar-empty">
            <p>尚未設定儲存庫</p>
            <button className="sidebar-empty-btn" onClick={() => void chooseVault()}>
              選擇儲存庫資料夾
            </button>
          </div>
        ) : (
          <>
            {rootDrop === 'top' && <div className="drop-line root-drop-line" />}
            {sortedRoots.map((n) => <TreeItem key={n.path} node={n} depth={0} ctx={ctx} />)}
            {rootDrop === 'bottom' && <div className="drop-line root-drop-line" />}
          </>
        )}
      </div>
      <div className="sidebar-resizer" onPointerDown={onResizeStart} />
      {menu && <PopMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function findNode(tree: VaultNode[], path: string): VaultNode | null {
  const stack = [...tree];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.path === path) return n;
    if (n.children) stack.push(...n.children);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
function NewFileIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2Z" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}
function NewFolderIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}
// Obsidian-style folder toggle chevron (rotates 90° via `.twisty.open`).
function ChevronIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
function SortIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4v16M7 4l-3 3M7 4l3 3" />
      <path d="M13 7h7M13 12h5M13 17h3" />
    </svg>
  );
}
