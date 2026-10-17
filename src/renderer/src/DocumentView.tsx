import { useCallback, useEffect, useRef, useState } from 'react';
import { Editor, EditorHandle } from './editor/Editor';
import { attachMarquee } from './editor/marquee';
import { useStore } from './store';
import {
  lossyFeatures,
  parseSnote,
  serializeSnote,
  splitFrontMatter,
  withSnoteExt,
} from './noteFormat';
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
  getFrontMatter?: () => string;
  isReady?: () => boolean;
  // Formatting in this document that a Markdown save would discard.
  lossyFeatures: () => string[];
  hasContent: () => boolean;
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

// Tab surfaces other than DocumentView (the spreadsheet view) register the same
// handle so save / close / pane-move flows treat every tab alike. The returned
// cleanup only unregisters its own handle: when a tab switches between a note
// and a sheet, the new view may register before the old one unmounts.
export function registerDocumentView(id: string, handle: DocumentViewHandle): () => void {
  registry.set(id, handle);
  return () => {
    if (registry.get(id) === handle) registry.delete(id);
  };
}

interface Props {
  tabId: string;
  active: boolean;
}

// One open document: a single BlockNote editor. Mounted once per tab and kept
// in the DOM (hidden when inactive) so each tab keeps its own undo history,
// caret and scroll position.
export function DocumentView({ tabId, active }: Props): JSX.Element {
  const filePath = useStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  const blankFirstLineFormat = useStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.blankFirstLineFormat ?? 'paragraph'
  );
  const setTabDirty = useStore((s) => s.setTabDirty);
  const setTabFile = useStore((s) => s.setTabFile);
  const updateTab = useStore((s) => s.updateTab);

  const [findOpen, setFindOpen] = useState(false);
  const [findShowReplace, setFindShowReplace] = useState(false);
  const findApiRef = useRef<FindBarHandle | null>(null);

  const handleRef = useRef<EditorHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Suppresses onChange-driven dirty marking while the initial content loads.
  const loadingRef = useRef(false);
  // Raw YAML front matter of the loaded Markdown file, re-attached on save.
  const frontMatterRef = useRef('');
  // Initial editor focus is decided once at mount from the tab's autoFocus flag.
  const initialAutoFocus = useRef(
    active && (useStore.getState().tabs.find((t) => t.id === tabId)?.autoFocus ?? true)
  );
  // The "focus on activation" effect must skip its first (mount) run so it
  // doesn't override the autoFocus decision above.
  const firstActiveRun = useRef(true);

  // Rubber-band (marquee) block selection, scoped to this document's surface.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return attachMarquee(root, () => (handleRef.current?.editor ?? null) as any);
  }, []);

  // Any edit marks the tab dirty until it is saved.
  const onEditorChange = useCallback(() => {
    if (loadingRef.current) return;
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (tab && !tab.dirty) setTabDirty(tabId, true);
  }, [setTabDirty, tabId]);

  const buildMarkdown = useCallback(async (): Promise<string> => {
    const h = handleRef.current;
    if (!h) return '';
    return frontMatterRef.current + (await h.asMarkdown());
  }, []);

  // The `.snote` payload: the raw block tree, so a reopened note is exactly the
  // document the user left behind.
  const buildSnote = useCallback(async (): Promise<string> => {
    return serializeSnote({
      format: 'simple-note',
      version: 2,
      blocks: handleRef.current?.asBlocks() ?? [],
    });
  }, []);

  // Which Markdown-incompatible features this document currently uses.
  const documentLossyFeatures = useCallback(
    (): string[] => lossyFeatures(handleRef.current?.editor.document ?? []),
    []
  );

  const save = useCallback(async (): Promise<boolean> => {
    if (!handleRef.current) return false;
    try {
      const tab = useStore.getState().tabs.find((t) => t.id === tabId);
      const contents = { markdown: await buildMarkdown(), snote: await buildSnote() };
      const r = await window.api.file.save(contents, {
        path: tab?.filePath ?? null,
        // Untitled notes are suggested under the name given via 重新命名, else
        // their first heading, in the app's own format so nothing is lost.
        suggestedName: withSnoteExt(
          (tab && tab.fileName !== '未命名筆記' ? tab.fileName : '') ||
            sanitizeFileName(firstHeadingText(handleRef.current.editor.document)) ||
            '未命名筆記'
        ),
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
  }, [buildMarkdown, buildSnote, setTabFile, setTabDirty, tabId]);

  const getFindEditors = useCallback(
    (): unknown[] => (handleRef.current ? [handleRef.current.editor] : []),
    []
  );

  // Cmd+F / Opt+Cmd+F. Like macOS apps, a one-line selection seeds the field;
  // when the bar is already open we just re-focus and select it.
  const openFind = useCallback((withReplace: boolean) => {
    const seed = selectedText(handleRef.current?.editor).trim();
    const usable = seed && !seed.includes('\n') ? seed : '';
    if (withReplace) setFindShowReplace(true);
    setFindOpen(true);
    requestAnimationFrame(() => {
      if (usable) findApiRef.current?.seed(usable);
      findApiRef.current?.focusQuery();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    requestAnimationFrame(() => handleRef.current?.focus());
  }, []);

  const hasContent = useCallback((): boolean => {
    const h = handleRef.current;
    return !!h && docHasContent(h.editor.document);
  }, []);

  // Load a file's text into the editor: `.snote` JSON restores the block tree;
  // anything else is parsed as Markdown.
  const loadContent = useCallback(
    async (text: string, opts: { focus?: boolean } = {}): Promise<void> => {
      const snote = parseSnote(text);
      frontMatterRef.current = '';
      if (snote) {
        handleRef.current?.loadBlocks(snote.blocks);
      } else {
        const { frontMatter, body } = splitFrontMatter(text);
        frontMatterRef.current = frontMatter;
        await handleRef.current?.loadMarkdown(body);
      }
      if (opts.focus) requestAnimationFrame(() => handleRef.current?.focusLastBlock());
    },
    []
  );

  // Register this view's imperative API (stable object, mutated each render).
  const viewApiRef = useRef<DocumentViewHandle>({
    save: async () => false,
    buildMarkdown: async () => '',
    buildSnote: async () => '',
    lossyFeatures: () => [],
    hasContent: () => false,
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
  viewApiRef.current.getFrontMatter = () => frontMatterRef.current;
  viewApiRef.current.isReady = () => !loadingRef.current;
  viewApiRef.current.lossyFeatures = documentLossyFeatures;
  viewApiRef.current.hasContent = hasContent;
  viewApiRef.current.pastePlainText = () => handleRef.current?.pastePlainText();
  viewApiRef.current.removeParagraphBreaks = () => handleRef.current?.removeParagraphBreaks();
  viewApiRef.current.focusLastBlock = () => handleRef.current?.focusLastBlock();
  viewApiRef.current.focus = () => handleRef.current?.focus();
  viewApiRef.current.openFind = openFind;
  viewApiRef.current.findNext = () => findApiRef.current?.next();
  viewApiRef.current.findPrev = () => findApiRef.current?.prev();
  useEffect(() => registerDocumentView(tabId, viewApiRef.current), [tabId]);

  useEffect(() => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab || tab.filePath || tab.initialMarkdown != null) return;
    const editor = handleRef.current;
    if (!editor) return;
    if (active) requestAnimationFrame(() => handleRef.current?.focusLastBlock());
  }, [active, blankFirstLineFormat, tabId]);

  // Load the tab's initial content once on mount.
  useEffect(() => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const finish = (): void => {
      if (tab.initialFrontMatter !== undefined) {
        frontMatterRef.current = tab.initialFrontMatter;
        updateTab(tabId, { initialFrontMatter: undefined });
      }
      const loadedTab = useStore.getState().tabs.find((t) => t.id === tabId);
      const restoreDirty = loadedTab?.restoreDirtyAfterLoad;
      setTabDirty(tabId, restoreDirty ?? false);
      if (restoreDirty !== undefined) {
        updateTab(tabId, { restoreDirtyAfterLoad: undefined });
      }
      if (initialAutoFocus.current) {
        requestAnimationFrame(() => handleRef.current?.focusLastBlock());
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
      void window.api.file.read(tab.filePath).then((r) => {
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
    if (active) handleRef.current?.focus();
  }, [active]);

  // Clicks on the page padding / gutter drop the caret into the last block.
  const onPageClick = useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('document-view') || t.classList.contains('page')) {
      handleRef.current?.focusLastBlock();
    }
  }, []);


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
          showReplace={findShowReplace}
          onToggleReplace={setFindShowReplace}
          onClose={closeFind}
          handleRef={findApiRef}
        />
      )}
      <div className="page">
        <Editor
          key={blankFirstLineFormat}
          onChange={onEditorChange}
          handleRef={handleRef}
          autoFocus={initialAutoFocus.current}
          notePath={filePath}
          blankFirstLineFormat={blankFirstLineFormat}
        />
      </div>
    </div>
  );
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
