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

  // Expose dirty/save for native close confirmation
  useEffect(() => {
    window.__simpleNote_isDirty = () => useStore.getState().dirty;
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
    const payload = JSON.stringify({
      version: 1,
      doc: JSON.parse(json),
      updatedAt: new Date().toISOString(),
    });
    const r = await window.api.file.save(payload, `${fileName}.sn`);
    if (r.ok && r.path) {
      setFile(r.path);
      return true;
    }
    return false;
  }, [fileName, setFile]);

  const doOpen = useCallback(async () => {
    if (useStore.getState().dirty) {
      const ok = await confirmDiscard();
      if (!ok) return;
    }
    const r = await window.api.file.open();
    if (r.ok && r.content && handleRef.current && r.path) {
      try {
        const obj = JSON.parse(r.content);
        handleRef.current.load(JSON.stringify(obj.doc));
      } catch {
        // ignore
      }
      setFile(r.path);
    }
  }, [setFile]);

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

  return (
    <div className="app">
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
