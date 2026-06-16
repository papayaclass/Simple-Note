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
import { createYouTubeMentionExtension } from './youtubeMention';
import { createCodeWrapPlugin } from './codeWrap';
import { createCodeBlockSelectPlugin } from './codeBlockSelect';
import { deleteSelectedBlocks, deleteForwardEmptyBlock } from './blockDelete';
import { createToggleKeyboardExtension } from './toggle';
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
    createToggleKeyboardExtension(),
    createBlockNoteExtension({
      key: 'simple-note-math',
      plugins: [createMathPlugin(() => useStore.getState().mathMode)],
    }),
    createYouTubeMentionExtension(),
    createBlockNoteExtension({
      key: 'simple-note-codeblock-select',
      plugins: [createCodeBlockSelectPlugin()],
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
      key: 'simple-note-block-delete',
      keyboardShortcuts: {
        // When the selection cleanly covers whole blocks (e.g. a marquee
        // selection), Backspace/Delete removes the whole blocks rather than just
        // clearing their text. Returns false otherwise so normal editing keys
        // behave as usual.
        Backspace: ({ editor }) => deleteSelectedBlocks(editor as never),
        Delete: ({ editor }) =>
          deleteSelectedBlocks(editor as never) || deleteForwardEmptyBlock(editor as never),
      },
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
      key: 'simple-note-heading-enter',
      keyboardShortcuts: {
        // Pressing Enter at the very start or end of a heading should leave a
        // plain paragraph behind, not another heading. Splitting in the middle
        // keeps the default behaviour (both halves stay headings). Returns false
        // for every other case so the normal Enter handling still runs.
        Enter: ({ editor }) => {
          const { block } = editor.getTextCursorPosition();
          if (block.type !== 'heading') return false;

          const tt = (editor as unknown as { _tiptapEditor: { state: any } })._tiptapEditor;
          const { selection } = tt.state;
          if (!selection.empty) return false; // a real text selection → let default split
          const { $from } = selection;
          const atStart = $from.parentOffset === 0;
          const atEnd = $from.parentOffset === $from.parent.content.size;

          if (atStart && !atEnd) {
            // Cursor at the start of a non-empty heading: push the heading down
            // and drop a plain paragraph in the spot it used to occupy.
            (editor.insertBlocks as (b: unknown, r: unknown, p: string) => unknown)(
              [{ type: 'paragraph' }],
              block,
              'before'
            );
            return true;
          }

          if (atEnd) {
            // Cursor at the end (or an empty heading): start a plain paragraph
            // below and move the caret into it.
            const [inserted] = (
              editor.insertBlocks as (
                b: unknown,
                r: unknown,
                p: string
              ) => Array<{ id: string }>
            )([{ type: 'paragraph' }], block, 'after');
            if (inserted) editor.setTextCursorPosition(inserted.id, 'start');
            return true;
          }

          return false; // middle of the heading → default split (stays a heading)
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

  // Notion-style divider: when a paragraph's text becomes exactly "---", replace
  // it with a `divider` block and drop an empty paragraph below for the cursor to
  // land in (so typing continues under the line). Mirrors the checkbox fix above:
  // detect in onChange, mutate in a microtask to stay out of the change cycle.
  useEffect(() => {
    const unsub = editor.onChange(() => {
      const block: any = editor.getTextCursorPosition().block;
      if (!block || block.type !== 'paragraph') return;
      if (blockPlainText(block) !== '---') return;
      queueMicrotask(() => {
        const res = (
          editor.replaceBlocks as (
            remove: string[],
            insert: Array<{ type: string }>
          ) => { insertedBlocks: Array<{ id: string; type: string }> }
        )([block.id], [{ type: 'divider' }, { type: 'paragraph' }]);
        const para = res.insertedBlocks[res.insertedBlocks.length - 1];
        if (para) editor.setTextCursorPosition(para.id, 'end');
      });
    });
    return () => unsub?.();
  }, [editor]);

  // Paste (Cmd+V) and Finder drag-drop of images. Listen on the editor host in
  // the capture phase so we intercept before ProseMirror's own paste/drop, then
  // stopPropagation+preventDefault to suppress the default handling. Each column
  // has its own host, so the event is naturally scoped to the column it hit.
  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const onPaste = (e: ClipboardEvent): void => {
      const files = imageFilesFrom(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const ref = editor.getTextCursorPosition().block.id;
      void insertImageFiles(editor, files, ref);
    };

    const onDrop = (e: DragEvent): void => {
      const files = imageFilesFrom(e.dataTransfer);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const view = (editor as any)._tiptapEditor.view;
      let afterId: string | null = null;
      const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (hit) afterId = resolveBlockId(view.state.doc, hit.pos);
      if (!afterId) {
        const blocks = editor.document;
        afterId = blocks.length ? blocks[blocks.length - 1].id : null;
      }
      void insertImageFiles(editor, files, afterId);
    };

    const onDragOver = (e: DragEvent): void => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    };

    host.addEventListener('paste', onPaste, true);
    host.addEventListener('drop', onDrop, true);
    host.addEventListener('dragover', onDragOver, true);
    return () => {
      host.removeEventListener('paste', onPaste, true);
      host.removeEventListener('drop', onDrop, true);
      host.removeEventListener('dragover', onDragOver, true);
    };
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
      // Cmd+2 → toggle list (collapsible). Uses our custom `toggle` block (see
      // editor/toggle.ts); BlockNote's built-in `toggleListItem` renders without
      // a chevron in this setup.
      if (!e.altKey && !e.shiftKey && code === 'Digit2') {
        e.preventDefault();
        transformCurrentBlock(editor, 'toggle');
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
      // Cmd+5 → checkbox
      if (!e.altKey && !e.shiftKey && code === 'Digit5') {
        e.preventDefault();
        transformCurrentBlock(editor, 'checkListItem');
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

// Pull image files out of a clipboard/drag payload (screenshots paste as
// image/* files; Finder drops them as files too).
function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((f) => f.type.startsWith('image/'));
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Insert each image as an `image` block, chained after the reference block so
// multiple images keep their order. `afterId` null appends at the document end.
async function insertImageFiles(editor: any, files: File[], afterId: string | null): Promise<void> {
  let ref = afterId ?? editor.document[editor.document.length - 1]?.id ?? null;
  for (const file of files) {
    if (!ref) return;
    const src = await readAsDataURL(file);
    const [inserted] = editor.insertBlocks([{ type: 'image', props: { src } }], ref, 'after');
    ref = inserted?.id ?? ref;
  }
}

// Walk up from a ProseMirror position to the enclosing block's id (the
// blockContainer node carries `attrs.id`), used to place a dropped image.
function resolveBlockId(doc: any, pos: number): string | null {
  const $pos = doc.resolve(Math.min(Math.max(pos, 0), doc.content.size));
  for (let d = $pos.depth; d > 0; d--) {
    const node = $pos.node(d);
    if (node?.attrs?.id) return node.attrs.id;
  }
  return null;
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
