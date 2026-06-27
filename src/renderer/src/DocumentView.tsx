import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Editor, EditorHandle } from './editor/Editor';
import { attachMarquee } from './editor/marquee';
import { useStore, ColumnLayout } from './store';
import { isPathInVault, refreshVaultTree } from './fileActions';

// Imperative interface each DocumentView registers so the app shell (menu save,
// window-close dirty check, tab context menu) can act on a specific tab without
// reaching into its editors directly.
export interface DocumentViewHandle {
  save: () => Promise<boolean>;
  buildMarkdown: () => Promise<string>;
  hasContent: () => boolean;
  pastePlainText: () => void;
  focus: () => void;
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
  const setTabDirty = useStore((s) => s.setTabDirty);
  const setTabFile = useStore((s) => s.setTabFile);
  const setTabColumnSplit = useStore((s) => s.setTabColumnSplit);
  const shiftTabColumn = useStore((s) => s.shiftTabColumn);
  const setTabColumnLayout = useStore((s) => s.setTabColumnLayout);
  const updateTab = useStore((s) => s.updateTab);

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

  const save = useCallback(async (): Promise<boolean> => {
    if (!midHandleRef.current) return false;
    try {
      const markdown = await buildMarkdown();
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      const r = await window.api.file.save(markdown, {
        path: tab?.filePath ?? null,
        suggestedName: `${tab?.fileName ?? '未命名筆記'}.md`,
      });
      if (r.ok && r.path) {
        const cur = useStore.getState().tabs.find((t) => t.id === tabId);
        if (cur?.filePath !== r.path) setTabFile(tabId, r.path);
        else if (cur?.dirty) setTabDirty(tabId, false);
        return true;
      }
      return false;
    } catch {
      // Editor may be mid-teardown (flush on unmount); ignore.
      return false;
    }
  }, [buildMarkdown, setTabFile, setTabDirty, tabId]);
  saveRef.current = save;

  // In-vault debounced action: auto-name an untitled file from its first
  // heading (keeping in sync until manually renamed), otherwise just save.
  const syncInVault = useCallback(async () => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || !isPathInVault(tab.filePath) || !tab.filePath) return;
    if (tab.autoName) {
      const heading = sanitizeFileName(firstHeadingText(midHandleRef.current?.editor.document ?? []));
      if (heading && heading !== tab.fileName) {
        await save(); // flush current content before moving the file
        const r = await window.api.vault.rename(tab.filePath, heading);
        if (r.ok && r.path) {
          useStore.getState().retargetTabs(tab.filePath, r.path);
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

  // Register this view's imperative API (stable object, mutated each render).
  const viewApiRef = useRef<DocumentViewHandle>({
    save: async () => false,
    buildMarkdown: async () => '',
    hasContent: () => false,
    pastePlainText: () => {},
    focus: () => {},
  });
  viewApiRef.current.save = save;
  viewApiRef.current.buildMarkdown = buildMarkdown;
  viewApiRef.current.hasContent = hasContent;
  viewApiRef.current.pastePlainText = () => focusedHandle()?.pastePlainText();
  viewApiRef.current.focus = () => midHandleRef.current?.focus();
  useEffect(() => {
    registry.set(tabId, viewApiRef.current);
    return () => {
      registry.delete(tabId);
    };
  }, [tabId]);

  // Load the tab's initial content once on mount.
  useEffect(() => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const finish = (): void => {
      setTabDirty(tabId, false);
      if (initialAutoFocus.current) {
        requestAnimationFrame(() => midHandleRef.current?.focusLastBlock());
      }
      setTimeout(() => {
        loadingRef.current = false;
      }, 0);
    };
    if (tab.initialMarkdown != null) {
      loadingRef.current = true;
      const md = tab.initialMarkdown;
      updateTab(tabId, { initialMarkdown: undefined });
      void midHandleRef.current?.loadMarkdown(md).then(finish);
    } else if (tab.filePath) {
      loadingRef.current = true;
      void window.api.vault.read(tab.filePath).then((r) => {
        if (r.ok && r.content != null) {
          void midHandleRef.current?.loadMarkdown(r.content).then(finish);
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
      <div className={`page${pageLayoutClass}`} ref={pageRef}>
        <div className="column column-left" ref={leftColRef}>
          <Editor onChange={onEditorChange} handleRef={leftHandleRef} autoFocus={false} />
        </div>
        <div className="column-divider divider-left" onPointerDown={onDividerPointerDown} />
        <div className="column column-middle" ref={midColRef}>
          <Editor onChange={onEditorChange} handleRef={midHandleRef} autoFocus={initialAutoFocus.current} />
        </div>
        <div className="column-divider divider-right" onPointerDown={onDividerPointerDown} />
        <div className="column column-right" ref={rightColRef}>
          <Editor onChange={onEditorChange} handleRef={rightHandleRef} autoFocus={false} />
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
