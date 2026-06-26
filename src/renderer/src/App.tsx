import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Editor, EditorHandle } from './editor/Editor';
import { attachMarquee } from './editor/marquee';
import { YouTubePreviewHover } from './editor/youtubePreview';
import { useStore } from './store';
import { PreferencesPanel } from './preferences/Panel';
import { ImageLightbox } from './ImageLightbox';
import { formatRemaining, formatAlarmLabel } from './timer/parse';
import { playAlarm, stopAlarm } from './timer/sound';
import { installSpeechShortcut } from './context-menu/speech';
import './preferences/panel.css';

export function App(): JSX.Element {
  const dirty = useStore((s) => s.dirty);
  const setDirty = useStore((s) => s.setDirty);
  const filePath = useStore((s) => s.filePath);
  const setFile = useStore((s) => s.setFile);
  const fileName = useStore((s) => s.fileName);
  const mathMode = useStore((s) => s.mathMode);
  const toggleMathMode = useStore((s) => s.toggleMathMode);
  const columnLayout = useStore((s) => s.columnLayout);
  const setColumnLayout = useStore((s) => s.setColumnLayout);
  const shiftColumn = useStore((s) => s.shiftColumn);
  const columnSplit = useStore((s) => s.columnSplit);
  const setColumnSplit = useStore((s) => s.setColumnSplit);
  const preferences = useStore((s) => s.preferences);
  const setPreferences = useStore((s) => s.setPreferences);
  const setPrefsOpen = useStore((s) => s.setPrefsPanelOpen);
  const wordCountPopover = useStore((s) => s.wordCountPopover);
  const setWordCountPopover = useStore((s) => s.setWordCountPopover);
  const timer = useStore((s) => s.timer);
  const setTimer = useStore((s) => s.setTimer);
  const alarms = useStore((s) => s.alarms);
  const removeAlarm = useStore((s) => s.removeAlarm);

  const leftHandleRef = useRef<EditorHandle | null>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const rightHandleRef = useRef<EditorHandle | null>(null);
  const appRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  // Column DOM nodes + the previous layout/positions, used to FLIP-animate the
  // reveal/collapse slide (see the layout effect below).
  const leftColRef = useRef<HTMLDivElement | null>(null);
  const midColRef = useRef<HTMLDivElement | null>(null);
  const rightColRef = useRef<HTMLDivElement | null>(null);
  const prevLayoutRef = useRef<string | null>(null);
  const prevRectsRef = useRef<{ mid: DOMRect; left: DOMRect; right: DOMRect } | null>(null);

  // True while the alarm sound is ringing; shows a dismiss chip in the status
  // bar. Set when a timer/alarm fires, cleared on dismiss or after the sound
  // auto-stops (10 loops).
  const [ringing, setRinging] = useState(false);

  // A 1-second tick that drives the countdown display and fires timer/alarm
  // notifications. Only runs while a timer or alarm is active.
  const [now, setNow] = useState(() => Date.now());
  // Register the Shift+Cmd+P pronunciation-replay shortcut once for the whole
  // app (the singleton guards against duplicates), so the multiple editors
  // don't each fire it and play the audio twice.
  useEffect(() => {
    installSpeechShortcut();
  }, []);

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
  // mousedown before ProseMirror. `resolve` routes the drag to the editor of the
  // column under the pointer so multi-column layouts select within that column.
  useEffect(() => {
    const root = appRef.current;
    if (!root) return;
    const resolve = (e: MouseEvent): any => {
      const article = handleRef.current?.editor ?? null;
      if (useStore.getState().columnLayout === 'center') return article;
      const col = (e.target as HTMLElement).closest(
        '.column-left, .column-middle, .column-right'
      );
      if (col?.classList.contains('column-left')) return leftHandleRef.current?.editor ?? article;
      if (col?.classList.contains('column-right')) return rightHandleRef.current?.editor ?? article;
      return article;
    };
    return attachMarquee(root, resolve);
  }, []);

  // Seed/restore the column split ratio onto the page element. Kept in an effect
  // (not a JSX inline style) keyed only on [columnSplit, columnLayout] so the
  // divider drag — which writes these vars imperatively without touching the
  // store — isn't clobbered by unrelated re-renders (e.g. the 1s timer tick).
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    page.style.setProperty('--col-left-grow', String(columnSplit));
    page.style.setProperty('--col-right-grow', String(1 - columnSplit));
  }, [columnSplit, columnLayout]);

  // Drag the active divider to resize the two visible columns. The grow ratio is
  // written straight to CSS vars for instant tracking, then committed to the
  // store on release. `resizing` disables the column transitions during the drag.
  const onDividerPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if (useStore.getState().columnLayout === 'center') return;
      const page = pageRef.current;
      if (!page) return;
      e.preventDefault();
      e.stopPropagation();
      const divider = e.currentTarget;
      divider.setPointerCapture(e.pointerId);
      page.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
      const PAD = 32; // .page horizontal padding
      const MARGIN = 32; // divider's gutter margin on each side (CSS: margin 0 32px)
      const GUTTER = MARGIN * 2 + 1; // both margins + the 1px line
      let frac = useStore.getState().columnSplit;

      const onMove = (ev: PointerEvent): void => {
        const rect = page.getBoundingClientRect();
        // Width shared by the two flex columns (page content box minus the gutter
        // the divider occupies). The divider line sits MARGIN past the left
        // column, so offset the cursor by PAD + MARGIN to keep it under the pointer.
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
        setColumnSplit(frac);
      };
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
    },
    [setColumnSplit]
  );

  // Shift+Cmd+Left/Right slides the article between columns. macOS swallows
  // Cmd+Shift+Arrow as a text-selection key while a contenteditable editor is
  // focused, so the native menu accelerator never fires there — handle it here in
  // the capture phase (and preventDefault to drop the would-be text selection).
  // When no editor is focused the menu accelerator fires it instead, so skip to
  // avoid shifting twice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return;
      if (e.code !== 'ArrowLeft' && e.code !== 'ArrowRight') return;
      const editing =
        leftHandleRef.current?.hasFocus() ||
        handleRef.current?.hasFocus() ||
        rightHandleRef.current?.hasFocus();
      if (!editing) return;
      e.preventDefault();
      e.stopPropagation();
      shiftColumn(e.code === 'ArrowRight' ? 'right' : 'left');
      setDirty(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shiftColumn, setDirty]);

  // Animate column reveal/collapse with a FLIP slide so the whole layout moves
  // cohesively in one direction (slide-in), instead of unfolding at the divider.
  // The layout snaps instantly (CSS has no width transitions); here we measure
  // the before/after positions and play transforms: the article (middle) FLIPs
  // from its old spot to the new one, an entering scratch column slides in from
  // the outer page edge, and a leaving one floats on top and slides back out.
  useLayoutEffect(() => {
    const page = pageRef.current;
    const leftEl = leftColRef.current;
    const midEl = midColRef.current;
    const rightEl = rightColRef.current;
    if (!page || !leftEl || !midEl || !rightEl) return;

    const prev = prevLayoutRef.current;
    const cur = columnLayout;

    // Cancel any in-flight slide and clear leftover state synchronously so we
    // measure natural positions and don't let an interrupted animation's async
    // onfinish clobber the new one (WAAPI events fire on a later tick).
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

    if (prev !== null && prev !== cur && !reduceMotion && prevRects) {
      const DUR = 300;
      const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)';
      const release = () => page.classList.remove('sliding');

      // Article (middle): FLIP from its previous position to the new one.
      const dx = prevRects.mid.left - newRects.mid.left;
      if (Math.abs(dx) > 0.5) {
        midEl.animate(
          [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0)' }],
          { duration: DUR, easing: EASE }
        );
      }

      // Entering scratch column: slide in from the outer page edge + fade.
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
        // Cleanup only on natural finish; an interrupting run clears state itself.
        a.onfinish = release;
      }

      // Leaving scratch column: it's already collapsed in the layout, so float
      // it on top at its old spot and slide it back out to the edge + fade.
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

    prevRectsRef.current = newRects;
    prevLayoutRef.current = cur;
  }, [columnLayout]);

  // Apply CSS variables from preferences
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
      if (useStore.getState().columnLayout !== 'center') {
        const left = leftHandleRef.current;
        const right = rightHandleRef.current;
        if (left && docHasContent(left.editor.document)) return true;
        if (right && docHasContent(right.editor.document)) return true;
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

  // Merge the visible columns into one Markdown string, top-to-bottom following
  // the on-screen left→right order (the layout itself isn't preserved). Empty
  // scratch columns are dropped.
  const buildMarkdown = useCallback(async (): Promise<string> => {
    const article = handleRef.current;
    if (!article) return '';
    const layout = useStore.getState().columnLayout;
    const articleMd = await article.asMarkdown();
    if (layout === 'center') return articleMd;
    const scratchMd = async (h: EditorHandle | null): Promise<string> =>
      h && docHasContent(h.editor.document) ? await h.asMarkdown() : '';
    const parts =
      layout === 'article-left'
        ? [articleMd, await scratchMd(rightHandleRef.current)] // article | right scratch
        : [await scratchMd(leftHandleRef.current), articleMd]; // left scratch | article
    return parts.filter((p) => p.trim().length > 0).join('\n\n');
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

  const activeEditor = useCallback((): EditorHandle | null => {
    if (leftHandleRef.current?.hasFocus()) return leftHandleRef.current;
    if (rightHandleRef.current?.hasFocus()) return rightHandleRef.current;
    if (handleRef.current?.hasFocus()) return handleRef.current;
    return handleRef.current;
  }, []);

  const loadContentByPath = useCallback(async (path: string, content: string) => {
    if (!handleRef.current) return;
    // Files are plain Markdown: parse into the article (middle) column, clear
    // both scratch columns, and drop back to single-column (Markdown can't carry
    // the multi-column layout).
    await handleRef.current.loadMarkdown(content);
    leftHandleRef.current?.load(JSON.stringify(EMPTY_DOC));
    rightHandleRef.current?.load(JSON.stringify(EMPTY_DOC));
    setColumnLayout('center');
    setFile(path);
  }, [setFile, setColumnLayout]);

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
        case 'push-article-left':
          shiftColumn('left');
          setDirty(true);
          break;
        case 'push-article-right':
          shiftColumn('right');
          setDirty(true);
          break;
        case 'paste-plain':
          activeEditor()?.pastePlainText();
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
  }, [activeEditor, doSave, setPrefsOpen, toggleMathMode, shiftColumn, setDirty]);

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

  // Map the article's position to which scratch column is revealed: article-left
  // shows the right column, article-right shows the left column.
  const pageLayoutClass =
    columnLayout === 'article-left'
      ? ' reveal-right'
      : columnLayout === 'article-right'
        ? ' reveal-left'
        : '';
  const displayFileName = getMarkdownDisplayName(filePath);

  return (
    <div className="app" ref={appRef} onClick={onShellClick}>
      <div className="drag-bar" />
      <div className="status-bar">
        {displayFileName && <div className="file-name">{displayFileName}</div>}
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
      <div className={`page${pageLayoutClass}`} ref={pageRef}>
        <div className="column column-left" ref={leftColRef}>
          <Editor onChange={onEditorChange} handleRef={leftHandleRef} autoFocus={false} />
        </div>
        <div className="column-divider divider-left" onPointerDown={onDividerPointerDown} />
        <div className="column column-middle" ref={midColRef}>
          <Editor onChange={onEditorChange} handleRef={handleRef} />
        </div>
        <div className="column-divider divider-right" onPointerDown={onDividerPointerDown} />
        <div className="column column-right" ref={rightColRef}>
          <Editor onChange={onEditorChange} handleRef={rightHandleRef} autoFocus={false} />
        </div>
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

// A fresh, empty BlockNote document (single empty paragraph).
const EMPTY_DOC = [{ type: 'paragraph', content: '' }];

// Pin an element on top of the page at the (now-collapsed) spot it occupied, so
// a leaving column can be animated out without disturbing the flex layout.
// `rect` is the element's old viewport rect; `origin` is the page's rect.
function floatAt(el: HTMLElement, rect: DOMRect, origin: DOMRect): void {
  el.style.position = 'absolute';
  el.style.left = `${rect.left - origin.left}px`;
  el.style.top = `${rect.top - origin.top}px`;
  el.style.width = `${rect.width}px`;
  el.style.height = `${rect.height}px`;
  el.style.zIndex = '1';
}

// Undo floatAt, handing layout back to the flex/CSS rules.
function resetSlideStyles(el: HTMLElement): void {
  el.style.position = '';
  el.style.left = '';
  el.style.top = '';
  el.style.width = '';
  el.style.height = '';
  el.style.zIndex = '';
}

function getMarkdownDisplayName(path: string | null): string | null {
  if (!path) return null;
  const name = path.split('/').pop() ?? '';
  return /\.md$/i.test(name) ? name : null;
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
