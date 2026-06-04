import { useCallback, useEffect, useRef, useState } from 'react';
import { Editor, EditorHandle } from './editor/Editor';
import { attachMarquee } from './editor/marquee';
import { useStore } from './store';
import { PreferencesPanel } from './preferences/Panel';
import { formatRemaining, formatAlarmLabel } from './timer/parse';
import { playAlarm, stopAlarm } from './timer/sound';
import './preferences/panel.css';

export function App(): JSX.Element {
  const dirty = useStore((s) => s.dirty);
  const setDirty = useStore((s) => s.setDirty);
  const filePath = useStore((s) => s.filePath);
  const setFile = useStore((s) => s.setFile);
  const fileName = useStore((s) => s.fileName);
  const mathMode = useStore((s) => s.mathMode);
  const toggleMathMode = useStore((s) => s.toggleMathMode);
  const twoColumn = useStore((s) => s.twoColumn);
  const setTwoColumn = useStore((s) => s.setTwoColumn);
  const preferences = useStore((s) => s.preferences);
  const setPreferences = useStore((s) => s.setPreferences);
  const setPrefsOpen = useStore((s) => s.setPrefsPanelOpen);
  const wordCountPopover = useStore((s) => s.wordCountPopover);
  const setWordCountPopover = useStore((s) => s.setWordCountPopover);
  const timer = useStore((s) => s.timer);
  const setTimer = useStore((s) => s.setTimer);
  const alarms = useStore((s) => s.alarms);
  const removeAlarm = useStore((s) => s.removeAlarm);

  const handleRef = useRef<EditorHandle | null>(null);
  const rightHandleRef = useRef<EditorHandle | null>(null);
  const appRef = useRef<HTMLDivElement | null>(null);

  // True while the alarm sound is ringing; shows a dismiss chip in the status
  // bar. Set when a timer/alarm fires, cleared on dismiss or after the sound
  // auto-stops (10 loops).
  const [ringing, setRinging] = useState(false);

  // A 1-second tick that drives the countdown display and fires timer/alarm
  // notifications. Only runs while a timer or alarm is active.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timer && alarms.length === 0) return;
    // Sync immediately so the countdown chip shows the correct value the moment
    // a timer starts, instead of displaying a stale `now` until the first tick.
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
      // Loop the alarm sound up to 10 times, auto-stopping if not dismissed.
      playAlarm(10, () => setRinging(false));
      setRinging(true);
    }
  }, [now, timer, alarms, setTimer, removeAlarm]);

  const stopRinging = useCallback(() => {
    stopAlarm();
    setRinging(false);
  }, []);

  // Rubber-band (marquee) block selection. Attached once at the app root in the
  // capture phase so it covers the whole page (gutters + padding) and sees the
  // mousedown before ProseMirror. `resolve` routes the drag to the column under
  // the pointer so two-column mode selects within the right editor.
  useEffect(() => {
    const root = appRef.current;
    if (!root) return;
    const resolve = (e: MouseEvent): any => {
      const left = handleRef.current?.editor ?? null;
      if (!useStore.getState().twoColumn || !rightHandleRef.current) return left;
      const right = rightHandleRef.current.editor;
      const col = (e.target as HTMLElement).closest('.column-right, .column-left');
      if (col?.classList.contains('column-right')) return right;
      if (col?.classList.contains('column-left')) return left;
      const page = root.querySelector('.page');
      if (page) {
        const r = page.getBoundingClientRect();
        if (e.clientX > r.left + r.width / 2) return right;
      }
      return left;
    };
    return attachMarquee(root, resolve);
  }, []);

  // Apply CSS variables from preferences
  useEffect(() => {
    const r = document.documentElement.style;
    r.setProperty('--page-width', `${preferences.pageWidth}px`);
    r.setProperty('--two-column-page-width', `${preferences.twoColumnPageWidth}px`);
    r.setProperty('--line-height', `${preferences.lineHeight}`);
    r.setProperty('--paragraph-spacing', `${preferences.paragraphSpacing}px`);
    r.setProperty('--top-padding', `${preferences.topPadding}px`);
    document.documentElement.setAttribute(
      'data-code-wrap',
      preferences.codeWrap ? 'true' : 'false'
    );
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
      if (docHasContent(handle.editor.document)) return true;
      if (useStore.getState().twoColumn && rightHandleRef.current) {
        return docHasContent(rightHandleRef.current.editor.document);
      }
      return false;
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

  // Combine both columns into one Markdown string: the right column's text is
  // appended below the left column's (requirement 4). The right column only
  // contributes when two-column mode is active and it actually has content.
  const buildMarkdown = useCallback(async (): Promise<string> => {
    if (!handleRef.current) return '';
    const left = await handleRef.current.asMarkdown();
    if (!useStore.getState().twoColumn || !rightHandleRef.current) return left;
    if (!docHasContent(rightHandleRef.current.editor.document)) return left;
    const right = await rightHandleRef.current.asMarkdown();
    return `${left}\n\n${right}`;
  }, []);

  const doSave = useCallback(async (): Promise<boolean> => {
    if (!handleRef.current) return false;
    const markdown = await buildMarkdown();
    const r = await window.api.file.save(markdown, {
      path: filePath,
      suggestedName: `${fileName}.md`,
    });
    if (r.ok && r.path) {
      setFile(r.path);
      return true;
    }
    return false;
  }, [fileName, filePath, setFile, buildMarkdown]);

  const loadContentByPath = useCallback(async (path: string, content: string) => {
    if (!handleRef.current) return;
    // Files are plain Markdown: parse into the left column, clear the right, and
    // drop back to single-column (Markdown can't carry the two-column layout).
    await handleRef.current.loadMarkdown(content);
    rightHandleRef.current?.load(JSON.stringify(EMPTY_DOC));
    setTwoColumn(false);
    setFile(path);
  }, [setFile, setTwoColumn]);

  // Receive a file pushed into this window by main. This covers files opened
  // from outside the app (Finder double-click, drag onto Dock, "Open With…")
  // and File → Open…, which now spawns a fresh window and has main load the
  // chosen file into it. (File → New just opens a blank window — no file.)
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
        case 'save':
          doSave();
          break;
        case 'preferences':
          setPrefsOpen(true);
          break;
        case 'toggle-math':
          toggleMathMode();
          break;
        case 'toggle-column':
          setTwoColumn(!useStore.getState().twoColumn);
          setDirty(true);
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
  }, [doSave, setPrefsOpen, toggleMathMode, setTwoColumn, setDirty]);

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
    <div className="app" ref={appRef} onClick={onShellClick}>
      <div className="drag-bar" />
      <div className="status-bar">
        {mathMode && <div className="math-badge">數學模式</div>}
        {timer && (
          <div className="status-chip timer-chip">
            {/* Read the clock at render time so the value is correct on the very
                first frame; `now` (updated each second) is what re-triggers it. */}
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
      <div className={`page${twoColumn ? ' two-column' : ''}`}>
        <div className="column column-left">
          <Editor onChange={onEditorChange} handleRef={handleRef} />
        </div>
        <div className="column-divider" />
        <div className="column column-right">
          <Editor onChange={onEditorChange} handleRef={rightHandleRef} autoFocus={false} />
        </div>
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

// A fresh, empty BlockNote document (single empty paragraph).
const EMPTY_DOC = [{ type: 'paragraph', content: '' }];

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
