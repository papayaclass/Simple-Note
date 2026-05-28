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
import { createMathPlugin } from '../math/overlay';
import { useStore } from '../store';
import { ContextMenu } from '../context-menu/ContextMenu';

export interface EditorHandle {
  serialize: () => string;
  load: (json: string) => void;
  asMarkdown: () => Promise<string>;
  focusLastBlock: () => void;
  editor: ReturnType<typeof useCreateBlockNote>;
}

const INITIAL_CONTENT: PartialBlock<any, any, any>[] = [{ type: 'paragraph', content: '' }];

interface Props {
  onChange: () => void;
  handleRef: React.MutableRefObject<EditorHandle | null>;
}

export function Editor({ onChange, handleRef }: Props): JSX.Element {
  const mathMode = useStore((s) => s.mathMode);

  // Custom ProseMirror extensions (math overlay + two-stage Cmd-A) registered via BlockNote's extension API
  const customExtensions = useRef([
    createBlockNoteExtension({
      key: 'simple-note-math',
      plugins: [createMathPlugin(() => useStore.getState().mathMode)],
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
      },
    }),
  ]).current;

  const editor = useCreateBlockNote({
    schema,
    initialContent: INITIAL_CONTENT,
    extensions: customExtensions,
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
  useEffect(() => {
    editor.focus();
  }, [editor]);

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
    <>
      <BlockNoteView
        editor={editor}
        slashMenu={false}
        formattingToolbar={false}
        sideMenu={false}
        filePanel={false}
        tableHandles={false}
      >
        <SideMenuController
          sideMenu={(props) => (
            <SideMenu {...props}>
              <DragHandleButton {...props} />
            </SideMenu>
          )}
        />
      </BlockNoteView>
      <ContextMenu editor={editor} />
    </>
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
