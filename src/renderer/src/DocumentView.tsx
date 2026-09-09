import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Editor, EditorHandle } from './editor/Editor';
import { attachMarquee } from './editor/marquee';
import { useStore, ColumnLayout } from './store';
import { isPathInVault, refreshVaultTree, rememberLastEditedFile } from './fileActions';
import { lossyFeatures, parseSnote, serializeSnote, withSnoteExt } from './noteFormat';
import { FindBar, FindBarHandle } from './find/FindBar';
import { selectedText } from './find/findPlugin';
import './find/find.css';

// Imperative interface each DocumentView registers so the app shell (menu save,
// window-close dirty check, tab context menu) can act on a specific tab without
// reaching into its editors directly.
export interface DocumentViewHandle {
  save: () => Promise<boolean>;
  buildMarkdown: () => Promise<string>;
  buildSnote: () => Promise<string>;
  // Formatting in this document that a Markdown save would discard.
  lossyFeatures: () => string[];
  hasContent: () => boolean;
  cancelPendingAutoSave: () => void;
  replaceWithContent: (text: string, opts?: { focus?: boolean }) => Promise<void>;
  pastePlainText: () => void;
  removeParagraphBreaks: () => void;
  focusLastBlock: () => void;
  focus: () => void;
  // Find & replace bar (menu commands 尋找 / 尋找並取代 / 找下一個 / 找上一個).
  openFind: (withReplace: boolean) => void;
  findNext: () => void;
  findPrev: () => void;
}

const registry = new Map<string, DocumentViewHandle>();

export function getDocumentView(id: string): DocumentViewHandle | undefined {
  return registry.get(id);
}

export function allDocumentViews(): Array<[string, DocumentViewHandle]> {
  return [...registry.entries()];
}

interface Props {
  tabId: string;
  active: boolean;
}

// One open document: the persistent three-column "push" editor surface. Mounted
// once per tab and kept in the DOM (hidden when inactive) so each tab keeps its
// own undo history, caret and scroll position.
export function DocumentView({ tabId, active }: Props): JSX.Element {
  const columnLayout = useStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.columnLayout ?? 'center'
  );
  const columnSplit = useStore((s) => s.tabs.find((t) => t.id === tabId)?.columnSplit ?? 0.5);
  const filePath = useStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  const blankFirstLineFormat = useStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.blankFirstLineFormat ?? 'paragraph'
  );
  const setTabDirty = useStore((s) => s.setTabDirty);
  const setTabFile = useStore((s) => s.setTabFile);
  const setTabColumnSplit = useStore((s) => s.setTabColumnSplit);
  const shiftTabColumn = useStore((s) => s.shiftTabColumn);
  const setTabColumnLayout = useStore((s) => s.setTabColumnLayout);
  const updateTab = useStore((s) => s.updateTab);

  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const findApiRef = useRef<FindBarHandle | null>(null);

  const leftHandleRef = useRef<EditorHandle | null>(null);
  const midHandleRef = useRef<EditorHandle | null>(null);
  const rightHandleRef = useRef<EditorHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const leftColRef = useRef<HTMLDivElement | null>(null);
  const midColRef = useRef<HTMLDivElement | null>(null);
  const rightColRef = useRef<HTMLDivElement | null>(null);
  const prevLayoutRef = useRef<string | null>(null);
  const prevRectsRef = useRef<{ mid: DOMRect; left: DOMRect; right: DOMRect } | null>(null);
  // Suppresses onChange-driven dirty marking while the initial content loads.
  const loadingRef = useRef(false);
  // Latest save()/sync closures + the pending auto-save timer (in-vault tabs).
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const syncRef = useRef<() => void>(() => {});
  const autoSaveTimer = useRef<number | null>(null);
  // Initial editor focus is decided once at mount from the tab's autoFocus flag.
  const initialAutoFocus = useRef(
    active && (useStore.getState().tabs.find((t) => t.id === tabId)?.autoFocus ?? true)
  );
  // The "focus on activation" effect must skip its first (mount) run so it
  // doesn't override the autoFocus decision above.
  const firstActiveRun = useRef(true);

  const currentLayout = useCallback(
    (): ColumnLayout => useStore.getState().tabs.find((t) => t.id === tabId)?.columnLayout ?? 'center',
    [tabId]
  );

  // Rubber-band (marquee) block selection, scoped to this document's surface.
  // `resolve` routes the drag to the editor of the column under the pointer.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const resolve = (e: MouseEvent): any => {
      const article = midHandleRef.current?.editor ?? null;
      if (currentLayout() === 'center') return article;
      const col = (e.target as HTMLElement).closest('.column-left, .column-middle, .column-right');
      if (col?.classList.contains('column-left')) return leftHandleRef.current?.editor ?? article;
      if (col?.classList.contains('column-right')) return rightHandleRef.current?.editor ?? article;
      return article;
    };
    return attachMarquee(root, resolve);
  }, [currentLayout]);

  // Seed/restore the column split ratio onto the page element.
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    page.style.setProperty('--col-left-grow', String(columnSplit));
    page.style.setProperty('--col-right-grow', String(1 - columnSplit));
  }, [columnSplit, columnLayout]);

  // Drag the active divider to resize the two visible columns.
  const onDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (currentLayout() === 'center') return;
      const page = pageRef.current;
      if (!page) return;
      e.preventDefault();
      e.stopPropagation();
      const divider = e.currentTarget;
      divider.setPointerCapture(e.pointerId);
      page.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      const PAD = 32; // .page horizontal padding
      const MARGIN = 32; // divider's gutter margin on each side
      const GUTTER = MARGIN * 2 + 1; // both margins + the 1px line
      let frac = columnSplit;

      const onMove = (ev: PointerEvent): void => {
        const rect = page.getBoundingClientRect();
        const colsSpan = rect.width - PAD * 2 - GUTTER;
        if (colsSpan <= 0) return;
        frac = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left - PAD - MARGIN) / colsSpan));
        page.style.setProperty('--col-left-grow', String(frac));
        page.style.setProperty('--col-right-grow', String(1 - frac));
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        page.classList.remove('resizing');
        document.body.style.cursor = '';
        try {
          divider.releasePointerCapture(e.pointerId);
        } catch {
          // ignore — capture may already be released
        }
        setTabColumnSplit(tabId, frac);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    },
    [columnSplit, currentLayout, setTabColumnSplit, tabId]
  );

  // Shift+Cmd+Left/Right slides the article between columns. Only the active
  // tab listens (macOS swallows the menu accelerator while a contenteditable is
  // focused, so we handle it here in the capture phase).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
      const editing =
        leftHandleRef.current?.hasFocus() ||
        midHandleRef.current?.hasFocus() ||
        rightHandleRef.current?.hasFocus();
      if (!editing) return;
      e.preventDefault();
      e.stopPropagation();
      shiftTabColumn(tabId, e.code === 'ArrowRight' ? 'right' : 'left');
      setTabDirty(tabId, true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, shiftTabColumn, setTabDirty, tabId]);

  // Animate column reveal/collapse with a FLIP slide (see App.tsx history).
  useLayoutEffect(() => {
    const page = pageRef.current;
    const leftEl = leftColRef.current;
    const midEl = midColRef.current;
    const rightEl = rightColRef.current;
    if (!page || !leftEl || !midEl || !rightEl) return;

    const prev = prevLayoutRef.current;
    const cur = columnLayout;

    for (const el of [leftEl, midEl, rightEl]) {
      el.getAnimations().forEach((a) => a.cancel());
      resetSlideStyles(el);
    }
    page.classList.remove('sliding');

    const newRects = {
      mid: midEl.getBoundingClientRect(),
      left: leftEl.getBoundingClientRect(),
      right: rightEl.getBoundingClientRect(),
    };
    const prevRects = prevRectsRef.current;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Skip the slide while hidden (rects are zero) — just snap.
    const visible = newRects.mid.width > 0;
    if (prev !== null && prev !== cur && !reduceMotion && prevRects && visible) {
      const DUR = 300;
      const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
      const release = (): void => page.classList.remove('sliding');

      const dx = prevRects.mid.left - newRects.mid.left;
      if (Math.abs(dx) > 0.5) {
        midEl.animate(
          [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }],
          { duration: DUR, easing: EASE }
        );
      }

      const enter =
        prev === 'center' && cur === 'article-right'
          ? { el: leftEl, from: '-100%' }
          : prev === 'center' && cur === 'article-left'
            ? { el: rightEl, from: '100%' }
            : null;
      if (enter) {
        page.classList.add('sliding');
        const a = enter.el.animate(
          [
            { transform: `translateX(${enter.from})`, opacity: 0 },
            { transform: 'translateX(0)', opacity: 1 },
          ],
          { duration: DUR, easing: EASE }
        );
        a.onfinish = release;
      }

      const leave =
        prev === 'article-right' && cur === 'center'
          ? { el: leftEl, rect: prevRects.left, to: '-100%' }
          : prev === 'article-left' && cur === 'center'
            ? { el: rightEl, rect: prevRects.right, to: '100%' }
            : null;
      if (leave) {
        floatAt(leave.el, leave.rect, page.getBoundingClientRect());
        page.classList.add('sliding');
        const a = leave.el.animate(
          [
            { transform: 'translateX(0)', opacity: 1 },
            { transform: `translateX(${leave.to})`, opacity: 0 },
          ],
          { duration: DUR, easing: EASE }
        );
        a.onfinish = () => {
          resetSlideStyles(leave.el);
          release();
        };
      }
    }

    if (visible) prevRectsRef.current = newRects;
    prevLayoutRef.current = cur;
  }, [columnLayout, active]);

  // On edit: in-vault files auto-save (debounced) and never show a dirty dot;
  // files stored elsewhere (and untitled buffers) mark dirty for manual save.
  const onEditorChange = useCallback(() => {
    if (loadingRef.current) return;
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    if (isPathInVault(tab.filePath)) {
      if (autoSaveTimer.current) window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = window.setTimeout(() => {
        autoSaveTimer.current = null;
        syncRef.current();
      }, 600);
    } else if (!tab.dirty) {
      setTabDirty(tabId, true);
    }
  }, [setTabDirty, tabId]);

  const flushAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
      syncRef.current();
    }
  }, []);

  const cancelPendingAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
  }, []);

  // Merge the visible columns into one Markdown string (top-to-bottom by the
  // on-screen left→right order). Empty scratch columns are dropped.
  const buildMarkdown = useCallback(async (): Promise<string> => {
    const article = midHandleRef.current;
    if (!article) return '';
    const layout = currentLayout();
    const articleMd = await article.asMarkdown();
    if (layout === 'center') return articleMd;
    const scratchMd = async (h: EditorHandle | null): Promise<string> =>
      h && docHasContent(h.editor.document) ? await h.asMarkdown() : '';
    const parts =
      layout === 'article-left'
        ? [articleMd, await scratchMd(rightHandleRef.current)]
        : [await scratchMd(leftHandleRef.current), articleMd];
    return parts.filter((p) => p.trim().length > 0).join('\n\n');
  }, [currentLayout]);

  // The `.snote` payload: every column's raw block tree plus the layout, so a
  // reopened note is byte-for-byte the document the user left behind.
  const buildSnote = useCallback(async (): Promise<string> => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    return serializeSnote({
      format: 'simple-note',
      version: 1,
      columnLayout: currentLayout(),
      columnSplit: tab?.columnSplit ?? 0.5,
      columns: {
        left: leftHandleRef.current?.asBlocks() ?? [],
        middle: midHandleRef.current?.asBlocks() ?? [],
        right: rightHandleRef.current?.asBlocks() ?? [],
      },
    });
  }, [currentLayout, tabId]);

  // Which Markdown-incompatible features this document currently uses. A
  // two-column layout counts too — Markdown has no way to express it.
  const documentLossyFeatures = useCallback((): string[] => {
    const layout = currentLayout();
    const found = new Set<string>(lossyFeatures(midHandleRef.current?.editor.document ?? []));
    if (layout !== 'center') {
      found.add('雙欄版面');
      const scratch = layout === 'article-left' ? rightHandleRef.current : leftHandleRef.current;
      for (const f of lossyFeatures(scratch?.editor.document ?? [])) found.add(f);
    }
    return [...found];
  }, [currentLayout]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!midHandleRef.current) return false;
    try {
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      const contents = { markdown: await buildMarkdown(), snote: await buildSnote() };
      const r = await window.api.file.save(contents, {
        path: tab?.filePath ?? null,
        // Untitled notes default to the app's own format so nothing is lost.
        suggestedName: withSnoteExt(tab?.fileName ?? '未命名筆記'),
      });
      if (r.ok && r.path) {
        const cur = useStore.getState().tabs.find((t) => t.id === tabId);
        if (cur?.filePath !== r.path) setTabFile(tabId, r.path);
        else if (cur?.dirty) setTabDirty(tabId, false);
        rememberLastEditedFile(r.path);
        return true;
      }
      return false;
    } catch {
      // Editor may be mid-teardown (flush on unmount); ignore.
      return false;
    }
  }, [buildMarkdown, buildSnote, setTabFile, setTabDirty, tabId]);
  saveRef.current = save;

  // In-vault debounced action: auto-name an untitled file from its first
  // heading (keeping in sync until manually renamed), otherwise just save.
  const syncInVault = useCallback(async () => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || !isPathInVault(tab.filePath) || !tab.filePath) return;
    if (tab.autoName) {
      const heading = sanitizeFileName(
        firstHeadingText(midHandleRef.current?.editor.document ?? [])
      );
      const nextName = heading || '未命名筆記';
      if (nextName !== tab.fileName) {
        await save(); // flush current content before moving the file
        const path = await renameAutoNamedFile(tab.filePath, tab.fileName, nextName);
        if (path && path !== tab.filePath) {
          useStore.getState().retargetTabs(tab.filePath, path);
          rememberLastEditedFile(path);
          await refreshVaultTree();
        }
        return;
      }
    }
    await save();
  }, [save, tabId]);
  syncRef.current = () => void syncInVault();

  // Flush any pending in-vault auto-save when the tab is switched away or torn
  // down, so the last edits aren't stranded in the debounce window.
  useEffect(() => {
    if (!active) flushAutoSave();
  }, [active, flushAutoSave]);
  useEffect(() => () => flushAutoSave(), [flushAutoSave]);

  const focusedHandle = useCallback((): EditorHandle | null => {
    if (leftHandleRef.current?.hasFocus()) return leftHandleRef.current;
    if (rightHandleRef.current?.hasFocus()) return rightHandleRef.current;
    if (midHandleRef.current?.hasFocus()) return midHandleRef.current;
    return midHandleRef.current;
  }, []);

  // The editors the find bar searches, in on-screen left-to-right order. Only
  // the columns actually visible in the current layout take part.
  const getFindEditors = useCallback((): unknown[] => {
    const layout = currentLayout();
    const list: unknown[] = [];
    if (layout === 'article-right' && leftHandleRef.current) {
      list.push(leftHandleRef.current.editor);
    }
    if (midHandleRef.current) list.push(midHandleRef.current.editor);
    if (layout === 'article-left' && rightHandleRef.current) {
      list.push(rightHandleRef.current.editor);
    }
    return list;
  }, [currentLayout]);

  // Cmd+F / Opt+Cmd+F. Like macOS apps, a one-line selection seeds the field;
  // when the bar is already open we just re-focus and select it.
  const openFind = useCallback(
    (withReplace: boolean) => {
      const seed = selectedText(focusedHandle()?.editor).trim();
      const usable = seed && !seed.includes('\n') ? seed : '';
      if (withReplace) setFindShowReplace(true);
      setFindOpen(true);
      requestAnimationFrame(() => {
        if (usable) findApiRef.current?.seed(usable);
        findApiRef.current?.focusQuery();
      });
    },
    [focusedHandle]
  );

  const closeFind = useCallback(() => {
    setFindOpen(false);
    requestAnimationFrame(() => midHandleRef.current?.focus());
  }, []);

  const hasContent = useCallback((): boolean => {
    const mid = midHandleRef.current;
    if (mid && docHasContent(mid.editor.document)) return true;
    if (currentLayout() !== 'center') {
      const left = leftHandleRef.current;
      const right = rightHandleRef.current;
      if (left && docHasContent(left.editor.document)) return true;
      if (right && docHasContent(right.editor.document)) return true;
    }
    return false;
  }, [currentLayout]);

  // Load a file's text into the columns. `.snote` JSON restores every column
  // and the layout; anything else is parsed as Markdown into the article column.
  const loadContent = useCallback(
    async (text: string, opts: { focus?: boolean } = {}): Promise<void> => {
      const snote = parseSnote(text);
      if (snote) {
        leftHandleRef.current?.loadBlocks(snote.columns.left);
        rightHandleRef.current?.loadBlocks(snote.columns.right);
        midHandleRef.current?.loadBlocks(snote.columns.middle);
        setTabColumnLayout(tabId, snote.columnLayout);
        setTabColumnSplit(tabId, snote.columnSplit);
      } else {
        await Promise.all([
          leftHandleRef.current?.loadMarkdown(''),
          rightHandleRef.current?.loadMarkdown(''),
        ]);
        setTabColumnLayout(tabId, 'center');
        await midHandleRef.current?.loadMarkdown(text);
      }
      if (opts.focus) requestAnimationFrame(() => midHandleRef.current?.focusLastBlock());
    },
    [setTabColumnLayout, setTabColumnSplit, tabId]
  );

  const replaceWithContent = useCallback(
    async (text: string, opts: { focus?: boolean } = {}): Promise<void> => {
      cancelPendingAutoSave();
      loadingRef.current = true;
      try {
        await loadContent(text, opts);
        setTabDirty(tabId, false);
      } finally {
        window.setTimeout(() => {
          loadingRef.current = false;
        }, 0);
      }
    },
    [cancelPendingAutoSave, loadContent, setTabDirty, tabId]
  );

  // Register this view's imperative API (stable object, mutated each render).
  const viewApiRef = useRef<DocumentViewHandle>({
    save: async () => false,
    buildMarkdown: async () => '',
    buildSnote: async () => '',
    lossyFeatures: () => [],
    hasContent: () => false,
    cancelPendingAutoSave: () => {},
    replaceWithContent: async () => {},
    pastePlainText: () => {},
    removeParagraphBreaks: () => {},
    focusLastBlock: () => {},
    focus: () => {},
    openFind: () => {},
    findNext: () => {},
    findPrev: () => {},
  });
  viewApiRef.current.save = save;
  viewApiRef.current.buildMarkdown = buildMarkdown;
  viewApiRef.current.buildSnote = buildSnote;
  viewApiRef.current.lossyFeatures = documentLossyFeatures;
  viewApiRef.current.hasContent = hasContent;
  viewApiRef.current.cancelPendingAutoSave = cancelPendingAutoSave;
  viewApiRef.current.replaceWithContent = replaceWithContent;
  viewApiRef.current.pastePlainText = () => focusedHandle()?.pastePlainText();
  viewApiRef.current.removeParagraphBreaks = () => focusedHandle()?.removeParagraphBreaks();
  viewApiRef.current.focusLastBlock = () => midHandleRef.current?.focusLastBlock();
  viewApiRef.current.focus = () => midHandleRef.current?.focus();
  viewApiRef.current.openFind = openFind;
  viewApiRef.current.findNext = () => findApiRef.current?.next();
  viewApiRef.current.findPrev = () => findApiRef.current?.prev();
  useEffect(() => {
    registry.set(tabId, viewApiRef.current);
    return () => {
      registry.delete(tabId);
    };
  }, [tabId]);

  useEffect(() => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || tab.filePath || tab.initialMarkdown != null) return;
    const editor = midHandleRef.current;
    if (!editor) return;
    if (active) requestAnimationFrame(() => midHandleRef.current?.focusLastBlock());
  }, [active, blankFirstLineFormat, tabId]);

  // Load the tab's initial content once on mount.
  useEffect(() => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const finish = (): void => {
      const loadedTab = useStore.getState().tabs.find((t) => t.id === tabId);
      const restoreDirty = loadedTab?.restoreDirtyAfterLoad;
      setTabDirty(tabId, restoreDirty ?? false);
      if (restoreDirty !== undefined) {
        updateTab(tabId, { restoreDirtyAfterLoad: undefined });
      }
      if (initialAutoFocus.current) {
        requestAnimationFrame(() => midHandleRef.current?.focusLastBlock());
      }
      setTimeout(() => {
        loadingRef.current = false;
      }, 0);
    };
    if (tab.initialMarkdown != null) {
      loadingRef.current = true;
      const text = tab.initialMarkdown;
      updateTab(tabId, { initialMarkdown: undefined });
      void loadContent(text).then(finish);
    } else if (tab.filePath) {
      loadingRef.current = true;
      void window.api.vault.read(tab.filePath).then((r) => {
        if (r.ok && r.content != null) {
          void loadContent(r.content).then(finish);
        } else {
          loadingRef.current = false;
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Focus the editor when this tab becomes active via a tab switch (preserving
  // its caret). Skips the initial mount run — that's handled by autoFocus.
  useEffect(() => {
    if (firstActiveRun.current) {
      firstActiveRun.current = false;
      return;
    }
    if (active) midHandleRef.current?.focus();
  }, [active]);

  // Clicks on the page padding / gutter drop the caret into the last block.
  const onPageClick = useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('document-view') || t.classList.contains('page')) {
      midHandleRef.current?.focusLastBlock();
    }
  }, []);

  const pageLayoutClass =
    columnLayout === 'article-left'
      ? ' reveal-right'
      : columnLayout === 'article-right'
        ? ' reveal-left'
        : '';

  return (
    <div
      className="document-view"
      ref={rootRef}
      hidden={!active}
      onClick={onPageClick}
      data-tab-id={tabId}
    >
      {findOpen && (
        <FindBar
          getEditors={getFindEditors}
          scopeKey={columnLayout}
          showReplace={findShowReplace}
          onToggleReplace={setFindShowReplace}
          onClose={closeFind}
          handleRef={findApiRef}
        />
      )}
      <div className={`page${pageLayoutClass}`} ref={pageRef}>
        <div className="column column-left" ref={leftColRef}>
          <Editor
            onChange={onEditorChange}
            handleRef={leftHandleRef}
            autoFocus={false}
            interactive={columnLayout === 'article-right'}
            notePath={filePath}
          />
        </div>
        <div className="column-divider divider-left" onPointerDown={onDividerPointerDown} />
        <div className="column column-middle" ref={midColRef}>
          <Editor
            key={blankFirstLineFormat}
            onChange={onEditorChange}
            handleRef={midHandleRef}
            autoFocus={initialAutoFocus.current}
            notePath={filePath}
            blankFirstLineFormat={blankFirstLineFormat}
          />
        </div>
        <div className="column-divider divider-right" onPointerDown={onDividerPointerDown} />
        <div className="column column-right" ref={rightColRef}>
          <Editor
            onChange={onEditorChange}
            handleRef={rightHandleRef}
            autoFocus={false}
            interactive={columnLayout === 'article-left'}
            notePath={filePath}
          />
        </div>
      </div>
    </div>
  );
}

// Pin an element on top of the page at its (now-collapsed) spot so a leaving
// column can animate out without disturbing the flex layout.
function floatAt(el: HTMLElement, rect: DOMRect, origin: DOMRect): void {
  el.style.position = 'absolute';
  el.style.left = `${rect.left - origin.left}px`;
  el.style.top = `${rect.top - origin.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.zIndex = '1';
}

function resetSlideStyles(el: HTMLElement): void {
  el.style.position = '';
  el.style.left = '';
  el.style.top = '';
  el.style.width = '';
  el.style.height = '';
  el.style.zIndex = '';
}

// Concatenate the inline text of a block's content array.
function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ text?: string }>)
      .map((s) => (s && typeof s.text === 'string' ? s.text : ''))
      .join('');
  }
  return '';
}

// First heading (H1/H2/H3) text in document order, descending into children.
function firstHeadingText(blocks: readonly unknown[]): string {
  for (const b of blocks as Array<{ type?: string; content?: unknown; children?: unknown[] }>) {
    if (b.type === 'heading') {
      const t = inlineText(b.content).trim();
      if (t) return t;
    }
    if (Array.isArray(b.children) && b.children.length) {
      const t = firstHeadingText(b.children);
      if (t) return t;
    }
  }
  return '';
}

// Make a heading usable as a filename: strip path-illegal characters, collapse
// whitespace, cap length. Returns '' when nothing usable remains.
function sanitizeFileName(s: string): string {
  return s
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

async function renameAutoNamedFile(
  path: string,
  currentName: string,
  baseName: string
): Promise<string | null> {
  for (let i = 0; i < 100; i += 1) {
    const name = i === 0 ? baseName : `${baseName} ${i}`;
    if (name === currentName) return path;
    const r = await window.api.vault.rename(path, name);
    if (r.ok && r.path) return r.path;
    if (r.reason !== 'exists') return null;
  }
  return null;
}

// BlockNote always carries at least one paragraph; "empty" means no meaningful
// inline text across any block.
export function docHasContent(blocks: readonly unknown[]): boolean {
  for (const b of blocks as Array<{ content?: unknown }>) {
    const c = b.content;
    if (typeof c === 'string') {
      if (c.length > 0) return true;
      continue;
    }
    if (Array.isArray(c)) {
      for (const span of c as Array<{ text?: string }>) {
        if (span && typeof span.text === 'string' && span.text.length > 0) return true;
      }
    }
  }
  return false;
}
