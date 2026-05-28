import { useCallback, useEffect, useRef } from 'react';
import { Editor, EditorHandle } from './editor/Editor';
import { useStore } from './store';
import { PreferencesPanel } from './preferences/Panel';
import './preferences/panel.css';

export function App(): JSX.Element {
  const dirty = useStore((s) => s.dirty);
  const setDirty = useStore((s) => s.setDirty);
  const filePath = useStore((s) => s.filePath);
  const setFile = useStore((s) => s.setFile);
  const fileName = useStore((s) => s.fileName);
  const mathMode = useStore((s) => s.mathMode);
  const toggleMathMode = useStore((s) => s.toggleMathMode);
  const preferences = useStore((s) => s.preferences);
  const setPreferences = useStore((s) => s.setPreferences);
  const setPrefsOpen = useStore((s) => s.setPrefsPanelOpen);
  const wordCountPopover = useStore((s) => s.wordCountPopover);
  const setWordCountPopover = useStore((s) => s.setWordCountPopover);

  const handleRef = useRef<EditorHandle | null>(null);

  // Apply CSS variables from preferences
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--page-width', `${preferences.pageWidth}px`);
    r.setProperty('--line-height', `${preferences.lineHeight}`);
    r.setProperty('--paragraph-spacing', `${preferences.paragraphSpacing}px`);
    r.setProperty('--top-padding', `${preferences.topPadding}px`);
  }, [preferences]);

  // Load preferences once on mount
  useEffect(() => {
    (async () => {
      const stored = (await window.api.prefs.get()) as Partial<typeof preferences>;
      setPreferences(stored);
    })();
  }, [setPreferences]);

  // Update window title with dirty indicator
  useEffect(() => {
    window.api.window.setDirty(dirty);
    window.api.window.setTitle(fileName);
  }, [dirty, fileName]);

  // Expose dirty/save for native close confirmation. Skip the prompt entirely
  // when the document has no real content — an empty Untitled buffer shouldn't
  // pester the user on quit.
  useEffect(() => {
    window.__simpleNote_isDirty = () => {
      if (!useStore.getState().dirty) return false;
      const handle = handleRef.current;
      if (!handle) return false;
      return docHasContent(handle.editor.document);
    };
    window.__simpleNote_save = async () => doSave();
    return () => {
      delete window.__simpleNote_isDirty;
      delete window.__simpleNote_save;
    };
  });

  const onEditorChange = useCallback(() => {
    if (!useStore.getState().dirty) setDirty(true);
  }, [setDirty]);

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!handleRef.current) return false;
    const json = handleRef.current.serialize();
    const snPayload = JSON.stringify({
      version: 1,
      doc: JSON.parse(json),
      updatedAt: new Date().toISOString(),
    });
    const mdPayload = await handleRef.current.asMarkdown();
    const isMd = filePath?.toLowerCase().endsWith('.md') ?? false;
    const suggested = `${fileName}${isMd ? '.md' : '.sn'}`;
    const r = await window.api.file.save({ sn: snPayload, md: mdPayload }, suggested);
    if (r.ok && r.path) {
      setFile(r.path);
      return true;
    }
    return false;
  }, [fileName, filePath, setFile]);

  const loadContentByPath = useCallback(async (path: string, content: string) => {
    if (!handleRef.current) return;
    if (path.toLowerCase().endsWith('.md')) {
      await handleRef.current.loadMarkdown(content);
    } else {
      try {
        const obj = JSON.parse(content);
        handleRef.current.load(JSON.stringify(obj.doc));
      } catch {
        // ignore malformed .sn files silently
      }
    }
    setFile(path);
  }, [setFile]);

  const doOpen = useCallback(async () => {
    if (useStore.getState().dirty) {
      const ok = await confirmDiscard();
      if (!ok) return;
    }
    const r = await window.api.file.open();
    if (r.ok && r.content && r.path) {
      await loadContentByPath(r.path, r.content);
    }
  }, [loadContentByPath]);

  const doNew = useCallback(async () => {
    if (useStore.getState().dirty) {
      const ok = await confirmDiscard();
      if (!ok) return;
    }
    handleRef.current?.load(JSON.stringify([{ type: 'paragraph', content: '' }]));
    setFile(null);
    await window.api.file.new();
  }, [setFile]);

  const doExportMarkdown = useCallback(async () => {
    if (!handleRef.current) return;
    const md = await handleRef.current.asMarkdown();
    await window.api.file.exportMarkdown(md, `${fileName}.md`);
  }, [fileName]);

  // TipTap's Code extension binds Mod-e to toggle inline code, which steals the
  // Cmd+E menu accelerator when the editor has focus. Intercept in the capture
  // phase so we win before ProseMirror's handleKeyDown sees the event.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.altKey || e.shiftKey) return;
      if (e.code !== 'KeyE') return;
      e.preventDefault();
      e.stopPropagation();
      void doExportMarkdown();
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [doExportMarkdown]);

  // Receive files opened from outside the app (Finder double-click, drag onto
  // Dock, "Open With…"). Main reads the file and pushes path + content here.
  useEffect(() => {
    const off = window.api.onExternalOpen(async ({ path, content }) => {
      if (useStore.getState().dirty) {
        const ok = await confirmDiscard();
        if (!ok) return;
      }
      await loadContentByPath(path, content);
    });
    // Signal main that we're mounted so any queued open-file paths can flush.
    window.api.notifyReady();
    return off;
  }, [loadContentByPath]);

  // Wire menu commands
  useEffect(() => {
    const off = window.api.onMenu((cmd) => {
      switch (cmd) {
        case 'new':
          doNew();
          break;
        case 'open':
          doOpen();
          break;
        case 'save':
          doSave();
          break;
        case 'export-md':
          doExportMarkdown();
          break;
        case 'preferences':
          setPrefsOpen(true);
          break;
        case 'toggle-math':
          toggleMathMode();
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
  }, [doNew, doOpen, doSave, doExportMarkdown, setPrefsOpen, toggleMathMode]);

  // Clicks anywhere outside the editor (the .app gutter, the .page padding,
  // or the centered margins around .page) should drop the caret into the last
  // block. We filter by target className so clicks inside .bn-container,
  // .prefs-overlay, .word-count-popover etc. are left alone.
  const onShellClick = useCallback((e: React.MouseEvent<HTMLDivElement>): void => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('app') || t.classList.contains('page')) {
      handleRef.current?.focusLastBlock();
    }
  }, []);

  return (
    <div className="app" onClick={onShellClick}>
      <div className="drag-bar" />
      {mathMode && <div className="math-badge">數學模式</div>}
      <div className="page">
        <Editor onChange={onEditorChange} handleRef={handleRef} />
      </div>
      <PreferencesPanel />
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

async function confirmDiscard(): Promise<boolean> {
  return window.confirm('目前有未儲存的變更，要捨棄嗎？');
}

// BlockNote always carries at least one paragraph block; "empty" means no
// meaningful inline text across any block.
function docHasContent(blocks: readonly unknown[]): boolean {
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
