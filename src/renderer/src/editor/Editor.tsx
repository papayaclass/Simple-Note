import { useEffect, useRef } from 'react';
import { createBlockNoteExtension, PartialBlock } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import {
  DragHandleButton,
  SideMenu,
  SideMenuController,
  useCreateBlockNote,
} from '@blocknote/react';
import { TextSelection, AllSelection } from 'prosemirror-state';
import { schema } from './schema';
import { createLinkExtension } from './link';
import { createMathPlugin } from '../math/overlay';
import { createCodeWrapPlugin } from './codeWrap';
import { useStore } from '../store';
import { ContextMenu } from '../context-menu/ContextMenu';
import {
  TIMER_RE,
  ALARM_RE,
  parseTimer,
  parseAlarm,
  nextAlarmTimestamp,
  normalizeCommandText,
} from '../timer/parse';

export interface EditorHandle {
  serialize: () => string;
  load: (json: string) => void;
  loadMarkdown: (md: string) => Promise<void>;
  asMarkdown: () => Promise<string>;
  focusLastBlock: () => void;
  editor: ReturnType<typeof useCreateBlockNote>;
}

const INITIAL_CONTENT: PartialBlock<any, any, any>[] = [{ type: 'paragraph', content: '' }];

interface Props {
  onChange: () => void;
  handleRef: React.MutableRefObject<EditorHandle | null>;
  autoFocus?: boolean;
}

export function Editor({ onChange, handleRef, autoFocus = true }: Props): JSX.Element {
  const mathMode = useStore((s) => s.mathMode);
  const codeWrap = useStore((s) => s.preferences.codeWrap);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Custom ProseMirror extensions (math overlay + two-stage Cmd-A) registered via BlockNote's extension API
  const customExtensions = useRef([
    createBlockNoteExtension({
      key: 'simple-note-math',
      plugins: [createMathPlugin(() => useStore.getState().mathMode)],
    }),
    createBlockNoteExtension({
      key: 'simple-note-code-wrap',
      plugins: [
        createCodeWrapPlugin(
          () => useStore.getState().preferences.codeWrap,
          () => {
            const next = !useStore.getState().preferences.codeWrap;
            useStore.getState().setPreferences({ codeWrap: next });
            void window.api.prefs.set('codeWrap', next);
          }
        ),
      ],
    }),
    createBlockNoteExtension({
      key: 'simple-note-timer',
      keyboardShortcuts: {
        // Pressing Enter on a line like "timer 10m" / "alarm 13:30" starts the
        // timer/alarm and clears the line. Otherwise let Enter act normally.
        Enter: ({ editor }) => {
          const block = editor.getTextCursorPosition().block;
          const text = normalizeCommandText(blockPlainText(block));

          const timerMatch = TIMER_RE.exec(text);
          if (timerMatch) {
            const secs = parseTimer(timerMatch[1]!);
            if (secs != null && secs > 0) {
              useStore.getState().setTimer({ endsAt: Date.now() + secs * 1000 });
              (editor.updateBlock as (b: unknown, u: unknown) => unknown)(block, { content: [] });
              return true;
            }
          }

          const alarmMatch = ALARM_RE.exec(text);
          if (alarmMatch) {
            const parsed = parseAlarm(alarmMatch[1]!);
            if (parsed) {
              useStore.getState().addAlarm(nextAlarmTimestamp(parsed.hours, parsed.minutes));
              (editor.updateBlock as (b: unknown, u: unknown) => unknown)(block, { content: [] });
              return true;
            }
          }

          return false;
        },
      },
    }),
    createBlockNoteExtension({
      key: 'simple-note-select-all',
      keyboardShortcuts: {
        'Mod-a': ({ editor }) => {
          const tipTap = (editor as unknown as { _tiptapEditor: { state: any; view: any } })
            ._tiptapEditor;
          const state = tipTap.state;
          const { $from, $to } = state.selection;
          const blockStart = $from.start($from.depth);
          const blockEnd = $from.end($from.depth);
          const selectsWholeBlock = $from.pos === blockStart && $to.pos === blockEnd;
          if (!selectsWholeBlock) {
            tipTap.view.dispatch(
              state.tr.setSelection(TextSelection.create(state.doc, blockStart, blockEnd))
            );
          } else {
            tipTap.view.dispatch(state.tr.setSelection(new AllSelection(state.doc)));
          }
          return true;
        },
        // Escape stops a running timer first (if any). Otherwise it selects the
        // whole text of the block the cursor is in (same as Cmd+A's first
        // stage). Overrides BlockNote's default Escape (blur).
        Escape: ({ editor }) => {
          if (useStore.getState().timer) {
            useStore.getState().setTimer(null);
            return true;
          }
          const tipTap = (editor as unknown as { _tiptapEditor: { state: any; view: any } })
            ._tiptapEditor;
          const state = tipTap.state;
          const { $from } = state.selection;
          const blockStart = $from.start($from.depth);
          const blockEnd = $from.end($from.depth);
          tipTap.view.dispatch(
            state.tr.setSelection(TextSelection.create(state.doc, blockStart, blockEnd))
          );
          return true;
        },
      },
    }),
  ]).current;

  // Override BlockNote's default `link` mark to stop bare filenames (MEMORY.md,
  // App.tsx, …) from being auto-linked while typing. Created once per editor.
  const tiptapOptions = useRef({ extensions: [createLinkExtension()] }).current;

  const editor = useCreateBlockNote({
    schema,
    initialContent: INITIAL_CONTENT,
    extensions: customExtensions,
    _tiptapOptions: tiptapOptions,
    placeholders: {
      default: '',
      emptyDocument: '',
    },
  });

  // Expose handle
  useEffect(() => {
    handleRef.current = {
      editor,
      serialize: () => JSON.stringify(editor.document),
      load: (json: string) => {
        try {
          const blocks = JSON.parse(json);
          (editor.replaceBlocks as (a: unknown, b: unknown) => unknown)(
            editor.document,
            blocks
          );
        } catch {
          // ignore
        }
      },
      loadMarkdown: async (md: string) => {
        const blocks = await editor.tryParseMarkdownToBlocks(md);
        (editor.replaceBlocks as (a: unknown, b: unknown) => unknown)(editor.document, blocks);
      },
      asMarkdown: async () => editor.blocksToMarkdownLossy(editor.document),
      focusLastBlock: () => {
        const blocks = editor.document;
        if (blocks.length === 0) return;
        const last = blocks[blocks.length - 1];
        editor.setTextCursorPosition(last.id, 'end');
        editor.focus();
      },
    };
  }, [editor, handleRef]);

  // Auto-focus on mount so the caret is visible without an initial click.
  // Skipped for the secondary (right) column so switching to two-column mode
  // doesn't steal focus away from the left column.
  useEffect(() => {
    if (autoFocus) editor.focus();
  }, [editor, autoFocus]);

  // Subscribe to document changes
  useEffect(() => {
    const unsubscribe = editor.onChange(() => onChange());
    return () => {
      unsubscribe?.();
    };
  }, [editor, onChange]);

  // Redraw math overlay when mathMode toggles
  useEffect(() => {
    const view = (editor as unknown as { _tiptapEditor: { view: { dispatch: (tr: any) => void; state: any } } })
      ._tiptapEditor.view;
    view.dispatch(view.state.tr.setMeta('math-overlay', { redraw: true }));
  }, [mathMode, editor]);

  // Refresh the code-wrap toggles when the global wrap state changes so the
  // button's active styling stays in sync (the wrapping itself is CSS-driven).
  useEffect(() => {
    const view = (editor as unknown as { _tiptapEditor: { view: { dispatch: (tr: any) => void; state: any } } })
      ._tiptapEditor.view;
    view.dispatch(view.state.tr.setMeta('code-wrap', { redraw: true }));
  }, [codeWrap, editor]);

  // BlockNote's default `[ ]\s$` input rule inserts the new checklist item BEFORE
  // the current paragraph rather than transforming it, which leaves the cursor in
  // the empty paragraph below the new checkbox. Watch onChange for that exact
  // pattern and merge it: keep the checkListItem, remove the trailing empty
  // paragraph, and refocus the cursor into the checkbox.
  useEffect(() => {
    const unsub = editor.onChange(() => {
      const blocks = editor.document;
      for (let i = 0; i < blocks.length - 1; i++) {
        const b: any = blocks[i];
        const next: any = blocks[i + 1];
        if (b.type !== 'checkListItem') continue;
        const bEmpty = !b.content || (Array.isArray(b.content) && b.content.length === 0);
        if (!bEmpty) continue;
        if (next.type !== 'paragraph') continue;
        const nextEmpty =
          !next.content || (Array.isArray(next.content) && next.content.length === 0);
        if (!nextEmpty) continue;
        // Found the pattern. Remove the empty paragraph and refocus checkbox.
        queueMicrotask(() => {
          (editor.removeBlocks as (ids: string[]) => unknown)([next.id]);
          editor.setTextCursorPosition(b.id, 'end');
        });
        break;
      }
    });
    return () => unsub?.();
  }, [editor]);

  // Custom keyboard shortcuts for block transforms / styles.
  // Use e.code (physical key) instead of e.key because Option modifies the key value
  // on macOS (Opt+V → √, Opt+4 → ¢) and breaks naive e.key matching.
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // In two-column mode both editors register this window-level listener.
      // Only the focused editor should respond, otherwise a shortcut would be
      // applied to both columns at once.
      const view = (editor as unknown as { _tiptapEditor: { view: { hasFocus: () => boolean } } })
        ._tiptapEditor.view;
      if (!view.hasFocus()) return;
      const code = e.code;

      // Cmd+1 (no shift, no alt) → paragraph
      if (!e.altKey && !e.shiftKey && code === 'Digit1') {
        e.preventDefault();
        transformCurrentBlock(editor, 'paragraph');
        return;
      }
      // Cmd+3 → bulleted list
      if (!e.altKey && !e.shiftKey && code === 'Digit3') {
        e.preventDefault();
        transformCurrentBlock(editor, 'bulletListItem');
        return;
      }
      // Cmd+4 → code block
      if (!e.altKey && !e.shiftKey && code === 'Digit4') {
        e.preventDefault();
        transformCurrentBlock(editor, 'codeBlock');
        return;
      }
      // Shift+Cmd+L → quote
      if (e.shiftKey && !e.altKey && code === 'KeyL') {
        e.preventDefault();
        transformCurrentBlock(editor, 'quote');
        return;
      }
      // Shift+Cmd+S → strikethrough
      if (e.shiftKey && !e.altKey && code === 'KeyS') {
        e.preventDefault();
        editor.toggleStyles({ strike: true } as never);
        return;
      }
      // Shift+Cmd+X → inline code
      if (e.shiftKey && !e.altKey && code === 'KeyX') {
        e.preventDefault();
        editor.toggleStyles({ code: true } as never);
        return;
      }
      // Option+Cmd+1/2/3 → H1/H2/H3
      if (e.altKey && !e.shiftKey && (code === 'Digit1' || code === 'Digit2' || code === 'Digit3')) {
        e.preventDefault();
        const level = Number(code.slice(-1)) as 1 | 2 | 3;
        transformCurrentBlock(editor, 'heading', { level });
        return;
      }
      // Option+Cmd+4 → checkbox
      if (e.altKey && !e.shiftKey && code === 'Digit4') {
        e.preventDefault();
        transformCurrentBlock(editor, 'checkListItem');
        return;
      }
      // Option+Cmd+V → red text toggle
      if (e.altKey && !e.shiftKey && code === 'KeyV') {
        e.preventDefault();
        editor.toggleStyles({ redText: true } as never);
        return;
      }
    }
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [editor]);

  return (
    <div ref={containerRef} className="editor-host">
      <BlockNoteView
        editor={editor}
        slashMenu={false}
        formattingToolbar={false}
        sideMenu={false}
        filePanel={false}
        tableHandles={false}
        emojiPicker={false}
      >
        <SideMenuController
          sideMenu={(props) => (
            <SideMenu {...props}>
              <DragHandleButton {...props} />
            </SideMenu>
          )}
        />
      </BlockNoteView>
      <ContextMenu editor={editor} containerRef={containerRef} />
    </div>
  );
}

function transformCurrentBlock(
  editor: ReturnType<typeof useCreateBlockNote>,
  type: string,
  props?: Record<string, unknown>
): void {
  const block = editor.getTextCursorPosition().block;
  editor.updateBlock(block, { type, props } as never);
}

// Extract the plain text of a BlockNote block's inline content.
function blockPlainText(block: { content?: unknown }): string {
  const c = block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .map((span) => (typeof span.text === 'string' ? span.text : ''))
      .join('');
  }
  return '';
}
