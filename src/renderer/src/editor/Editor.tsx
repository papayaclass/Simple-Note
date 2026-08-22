import { useEffect, useRef } from 'react';
import { createBlockNoteExtension, PartialBlock } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import { useCreateBlockNote } from '@blocknote/react';
import { TextSelection, AllSelection } from 'prosemirror-state';
import { schema } from './schema';
import { createLinkExtension, sanitizeLoadedMarkdown } from './link';
import { createMathPlugin } from '../math/overlay';
import { createYouTubeMentionExtension } from './youtubeMention';
import { createCodeHighlightPlugin } from './codeHighlight';
import { createCodeWrapPlugin } from './codeWrap';
import { createCodeBlockSelectPlugin } from './codeBlockSelect';
import { createSelectionClampPlugin } from './selectionClamp';
import { deleteSelectedBlocks, deleteForwardEmptyBlock } from './blockDelete';
import { createToggleKeyboardExtension } from './toggle';
import { SimpleNoteSideMenuController } from './sideMenu';
import { SimpleNoteSlashMenu } from './slashMenu';
import { BlankFirstLineFormat, useStore } from '../store';
import { setEditorNoteDir, dirOf } from './noteDir';
import { openFileInTab } from '../fileActions';
import { ContextMenu } from '../context-menu/ContextMenu';
import { removeParagraphBreaks } from '../context-menu/removeParagraphBreaks';

export interface EditorHandle {
  serialize: () => string;
  load: (json: string) => void;
  loadMarkdown: (md: string) => Promise<void>;
  asMarkdown: () => Promise<string>;
  // Raw BlockNote block tree — the payload of the `.snote` format, which keeps
  // everything Markdown drops (red text, toggles, images…).
  asBlocks: () => unknown[];
  loadBlocks: (blocks: unknown[]) => void;
  focusLastBlock: () => void;
  focus: () => void;
  pastePlainText: () => void;
  removeParagraphBreaks: () => void;
  hasFocus: () => boolean;
  editor: ReturnType<typeof useCreateBlockNote>;
}

const SIDEBAR_PATH_MIME = 'application/x-simple-note-path';

function blankContentForFormat(format: BlankFirstLineFormat): PartialBlock<any, any, any>[] {
  switch (format) {
    case 'heading1':
      return [{ type: 'heading', props: { level: 1 }, content: '' }];
    case 'heading2':
      return [{ type: 'heading', props: { level: 2 }, content: '' }];
    case 'heading3':
      return [{ type: 'heading', props: { level: 3 }, content: '' }];
    case 'paragraph':
    default:
      return [{ type: 'paragraph', content: '' }];
  }
}

function placeholderForFormat(format: BlankFirstLineFormat): string {
  switch (format) {
    case 'heading1':
      return '標題 1';
    case 'heading2':
      return '標題 2';
    case 'heading3':
      return '標題 3';
    case 'paragraph':
    default:
      return '';
  }
}

const BLANK_LINE_MARKER = '<!-- simple-note:blank-line -->';

type LooseBlock = PartialBlock<any, any, any> & {
  type?: string;
  content?: unknown;
  children?: LooseBlock[];
};

function inlineContentIsEmpty(content: unknown): boolean {
  if (content == null) return true;
  if (typeof content === 'string') return content.length === 0;
  if (!Array.isArray(content)) return false;
  return content.every((span) => {
    if (!span || typeof span !== 'object') return true;
    const text = (span as { text?: string }).text;
    return typeof text !== 'string' || text.length === 0;
  });
}

function isSerializableBlankParagraph(block: LooseBlock): boolean {
  return (
    block.type === 'paragraph' &&
    inlineContentIsEmpty(block.content) &&
    (!block.children || block.children.length === 0)
  );
}

function markdownWithBlankLines(editor: ReturnType<typeof useCreateBlockNote>): string {
  const blocks = editor.document as LooseBlock[];
  const firstContentIndex = blocks.findIndex((block) => !isSerializableBlankParagraph(block));
  if (firstContentIndex === -1) return '';

  let lastContentIndex = firstContentIndex;
  for (let i = blocks.length - 1; i > firstContentIndex; i -= 1) {
    if (!isSerializableBlankParagraph(blocks[i])) {
      lastContentIndex = i;
      break;
    }
  }

  const parts: string[] = [];
  let run: LooseBlock[] = [];
  const flushRun = (): void => {
    if (run.length === 0) return;
    const markdown = editor.blocksToMarkdownLossy(run);
    if (markdown.trim().length > 0) parts.push(markdown);
    run = [];
  };

  blocks.forEach((block, index) => {
    if (
      index > firstContentIndex &&
      index < lastContentIndex &&
      isSerializableBlankParagraph(block)
    ) {
      flushRun();
      parts.push(BLANK_LINE_MARKER);
      return;
    }
    run.push(block);
  });
  flushRun();

  return parts.join('\n\n');
}

function markdownFenceMarker(line: string): { char: '`' | '~'; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const marker = match[1]!;
  return { char: marker[0] as '`' | '~', length: marker.length };
}

function markdownLineClosesFence(
  line: string,
  fence: { char: '`' | '~'; length: number }
): boolean {
  const marker = markdownFenceMarker(line);
  return !!marker && marker.char === fence.char && marker.length >= fence.length;
}

function preserveMarkdownBlankLineRuns(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let blankCount = 0;
  let fence: { char: '`' | '~'; length: number } | null = null;

  const flushBlankLines = (): void => {
    if (blankCount === 0) return;
    if (fence || blankCount === 1) {
      for (let i = 0; i < blankCount; i += 1) out.push('');
    } else {
      out.push('');
      for (let i = 1; i < blankCount; i += 1) {
        out.push(BLANK_LINE_MARKER, '');
      }
    }
    blankCount = 0;
  };

  for (const line of lines) {
    if (line.trim() === '') {
      blankCount += 1;
      continue;
    }

    flushBlankLines();
    out.push(line);

    if (fence) {
      if (markdownLineClosesFence(line, fence)) fence = null;
    } else {
      fence = markdownFenceMarker(line);
    }
  }
  flushBlankLines();

  return out.join('\n');
}

async function parseMarkdownWithBlankLines(
  editor: ReturnType<typeof useCreateBlockNote>,
  markdown: string,
  blankFirstLineFormat: BlankFirstLineFormat
): Promise<PartialBlock<any, any, any>[]> {
  const sanitized = preserveMarkdownBlankLineRuns(sanitizeLoadedMarkdown(markdown));
  if (!sanitized.includes(BLANK_LINE_MARKER)) {
    const parsed = await editor.tryParseMarkdownToBlocks(sanitized);
    return parsed.length > 0 ? parsed : blankContentForFormat(blankFirstLineFormat);
  }

  const blocks: PartialBlock<any, any, any>[] = [];
  let segment: string[] = [];
  const flushSegment = async (): Promise<void> => {
    const text = segment.join('\n').trim();
    segment = [];
    if (!text) return;
    const parsed = await editor.tryParseMarkdownToBlocks(text);
    blocks.push(...parsed);
  };

  for (const line of sanitized.split(/\r?\n/)) {
    if (line.trim() === BLANK_LINE_MARKER) {
      await flushSegment();
      blocks.push({ type: 'paragraph', content: '' });
    } else {
      segment.push(line);
    }
  }
  await flushSegment();

  return blocks.length > 0 ? blocks : blankContentForFormat(blankFirstLineFormat);
}

interface Props {
  onChange: () => void;
  handleRef: React.MutableRefObject<EditorHandle | null>;
  autoFocus?: boolean;
  interactive?: boolean;
  notePath?: string | null;
  blankFirstLineFormat?: BlankFirstLineFormat;
}

export function Editor({
  onChange,
  handleRef,
  autoFocus = true,
  interactive = true,
  notePath = null,
  blankFirstLineFormat = 'paragraph',
}: Props): JSX.Element {
  const mathMode = useStore((s) => s.mathMode);
  const codeWrap = useStore((s) => s.preferences.codeWrap);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const notePathRef = useRef<string | null>(notePath);
  notePathRef.current = notePath;
  const initialContent = useRef(blankContentForFormat(blankFirstLineFormat)).current;

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
      key: 'simple-note-code-highlight',
      plugins: [createCodeHighlightPlugin()],
    }),
    createBlockNoteExtension({
      key: 'simple-note-selection-clamp',
      plugins: [createSelectionClampPlugin()],
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
        // Escape selects the whole text of the block the cursor is in (same as
        // Cmd+A's first stage). Overrides BlockNote's default Escape (blur).
        Escape: ({ editor }) => {
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
    initialContent,
    extensions: customExtensions,
    _tiptapOptions: tiptapOptions,
    placeholders: {
      default: '',
      emptyDocument: placeholderForFormat(blankFirstLineFormat),
      paragraph: '',
      heading: placeholderForFormat(blankFirstLineFormat),
    },
  });

  // Tell image blocks which directory to resolve relative `src` paths against.
  useEffect(() => {
    setEditorNoteDir(editor, dirOf(notePath));
  }, [editor, notePath]);

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
        if (md.trim() === '') {
          (editor.replaceBlocks as (a: unknown, b: unknown) => unknown)(
            editor.document,
            blankContentForFormat(blankFirstLineFormat)
          );
          return;
        }
        const blocks = await parseMarkdownWithBlankLines(editor, md, blankFirstLineFormat);
        (editor.replaceBlocks as (a: unknown, b: unknown) => unknown)(editor.document, blocks);
      },
      asMarkdown: async () => markdownWithBlankLines(editor),
      asBlocks: () => JSON.parse(JSON.stringify(editor.document)) as unknown[],
      loadBlocks: (blocks: unknown[]) => {
        const next =
          Array.isArray(blocks) && blocks.length > 0
            ? blocks
            : blankContentForFormat(blankFirstLineFormat);
        (editor.replaceBlocks as (a: unknown, b: unknown) => unknown)(editor.document, next);
      },
      focusLastBlock: () => {
        focusLastBlock(editor);
      },
      focus: () => editor.focus(),
      pastePlainText: () => pastePlainText(editor),
      removeParagraphBreaks: () => {
        removeParagraphBreaks(editor);
      },
      hasFocus: () => editorHasFocus(editor),
    };
  }, [blankFirstLineFormat, editor, handleRef]);

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
      void insertImageFiles(editor, files, ref, notePathRef.current);
    };

    const onDrop = (e: DragEvent): void => {
      const images = imageFilesFrom(e.dataTransfer);
      const textPaths = textNoteFilesFrom(e.dataTransfer);
      const sidebarImagePaths = sidebarImagePathsFrom(e.dataTransfer);
      if (images.length === 0 && textPaths.length === 0 && sidebarImagePaths.length === 0) return;
      e.preventDefault();
      e.stopPropagation();

      // md/txt dropped from Finder open as new tabs (storage location unchanged).
      for (const p of textPaths) {
        void window.api.vault.read(p).then((r) => {
          if (r.ok) void openFileInTab(p, r.content ?? '');
          else console.error('[editor] failed to read dropped file:', p);
        });
      }

      if (images.length > 0 || sidebarImagePaths.length > 0) {
        const view = (editor as any)._tiptapEditor.view;
        clearDropCursor(view);
        let afterId: string | null = null;
        const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
        if (hit) afterId = resolveBlockId(view.state.doc, hit.pos);
        if (!afterId) {
          const blocks = editor.document;
          afterId = blocks.length ? blocks[blocks.length - 1].id : null;
        }
        if (images.length > 0) {
          void insertImageFiles(editor, images, afterId, notePathRef.current);
        }
        if (sidebarImagePaths.length > 0) {
          void insertImagePaths(editor, sidebarImagePaths, afterId, notePathRef.current);
        }
      }
    };

    const onDragOver = (e: DragEvent): void => {
      if (
        e.dataTransfer &&
        (Array.from(e.dataTransfer.types).includes('Files') ||
          Array.from(e.dataTransfer.types).includes(SIDEBAR_PATH_MIME))
      ) {
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
        transformSelectedBlocks(editor, 'paragraph');
        return;
      }
      // Cmd+2 → toggle list (collapsible). Uses our custom `toggle` block (see
      // editor/toggle.ts); BlockNote's built-in `toggleListItem` renders without
      // a chevron in this setup.
      if (!e.altKey && !e.shiftKey && code === 'Digit2') {
        e.preventDefault();
        transformSelectedBlocks(editor, 'toggle');
        return;
      }
      // Cmd+3 → bulleted list
      if (!e.altKey && !e.shiftKey && code === 'Digit3') {
        e.preventDefault();
        transformSelectedBlocks(editor, 'bulletListItem');
        return;
      }
      // Cmd+4 → code block
      if (!e.altKey && !e.shiftKey && code === 'Digit4') {
        e.preventDefault();
        transformSelectedBlocks(editor, 'codeBlock');
        return;
      }
      // Cmd+5 → checkbox
      if (!e.altKey && !e.shiftKey && code === 'Digit5') {
        e.preventDefault();
        transformSelectedBlocks(editor, 'checkListItem');
        return;
      }
      // Shift+Cmd+L → quote
      if (e.shiftKey && !e.altKey && code === 'KeyL') {
        e.preventDefault();
        transformSelectedBlocks(editor, 'quote');
        return;
      }
      // Shift+Cmd+S → strikethrough
      if (e.shiftKey && !e.altKey && code === 'KeyS') {
        e.preventDefault();
        editor.toggleStyles({ strike: true } as never);
        return;
      }
      // Shift+Cmd+V → paste clipboard contents as plain text.
      if (e.shiftKey && !e.altKey && code === 'KeyV') {
        e.preventDefault();
        e.stopPropagation();
        pastePlainText(editor);
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
        transformSelectedBlocks(editor, 'heading', { level });
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
    <div
      ref={containerRef}
      className="editor-host"
      data-interactive={interactive ? 'true' : 'false'}
    >
      <BlockNoteView
        editor={editor}
        editable={interactive}
        slashMenu={false}
        formattingToolbar={false}
        sideMenu={false}
        filePanel={false}
        emojiPicker={false}
      >
        {interactive && <SimpleNoteSideMenuController editor={editor} containerRef={containerRef} />}
        {interactive && <SimpleNoteSlashMenu editor={editor} />}
      </BlockNoteView>
      <ContextMenu editor={editor} containerRef={containerRef} />
    </div>
  );
}

function transformSelectedBlocks(
  editor: ReturnType<typeof useCreateBlockNote>,
  type: string,
  props?: Record<string, unknown>
): void {
  const blocks = editor.getSelection()?.blocks ?? [editor.getTextCursorPosition().block];

  // Keep a multi-block format change as one undo step. BlockNote nests the
  // updateBlock transactions into this outer transaction automatically.
  editor.transact(() => {
    for (const block of blocks) {
      editor.updateBlock(block, { type, props } as never);
    }
  });
}

function editorHasFocus(editor: ReturnType<typeof useCreateBlockNote>): boolean {
  return (
    editor as unknown as { _tiptapEditor: { view: { hasFocus: () => boolean } } }
  )._tiptapEditor.view.hasFocus();
}

function pastePlainText(editor: ReturnType<typeof useCreateBlockNote>): void {
  const text = window.api.clipboard.readText();
  if (!text) return;
  editor.focus();
  editor.pasteText(text);
}

function focusLastBlock(editor: ReturnType<typeof useCreateBlockNote>): void {
  const focus = (): void => {
    const blocks = editor.document;
    if (blocks.length === 0) return;
    const last = blocks[blocks.length - 1];
    editor.setTextCursorPosition(last.id, 'end');
    editor.focus();
  };
  focus();
  requestAnimationFrame(focus);
}

// Pull image files out of a clipboard/drag payload (screenshots paste as
// image/* files; Finder drops them as files too).
function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((f) => {
    const path = filePathFor(f);
    return f.type.startsWith('image/') || (path ? isImagePath(path) : false);
  });
}

// Pull md/txt files (with their Finder paths) out of a drag payload. Electron
// exposes dropped file paths through webUtils, bridged from preload.
function textNoteFilesFrom(data: DataTransfer | null): string[] {
  if (!data) return [];
  return Array.from(data.files)
    .map((f) => filePathFor(f))
    .filter((p) => Boolean(p) && /\.(md|txt)$/i.test(p));
}

function sidebarImagePathsFrom(data: DataTransfer | null): string[] {
  if (!data) return [];
  const path = data.getData(SIDEBAR_PATH_MIME);
  if (!path.startsWith('/')) return [];
  return isImagePath(path) ? [path] : [];
}

function filePathFor(file: File): string {
  try {
    return window.api.file.getPathForFile(file);
  } catch {
    return '';
  }
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(path);
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Insert each image as an `image` block. For each file we ask main where it
// should live: in-vault notes back the image into <vault>/Assets and store a
// relative path; out-of-vault notes store an absolute path; pasted screenshots
// without a source file fall back to an in-memory data URL when not in a vault.
async function insertImageFiles(
  editor: any,
  files: File[],
  afterId: string | null,
  notePath: string | null
): Promise<void> {
  let ref = afterId ?? editor.document[editor.document.length - 1]?.id ?? null;
  for (const file of files) {
    if (!ref) return;
    const sourcePath = filePathFor(file);
    let blockSrc: string | null = null;
    if (sourcePath) {
      const r = await window.api.vault.saveImageForNote({ notePath, sourcePath });
      blockSrc = r.ok ? r.persistSrc || null : null;
    } else {
      const dataUrl = await readAsDataURL(file);
      const r = await window.api.vault.saveImageForNote({ notePath, dataUrl });
      blockSrc = r.ok ? (r.memoryOnly ? dataUrl : r.persistSrc || null) : dataUrl;
    }
    if (!blockSrc) {
      console.warn('[editor] image insert skipped:', sourcePath || '(clipboard image)');
      continue;
    }
    ref = insertImageBlock(editor, ref, blockSrc) ?? ref;
  }
}

async function insertImagePaths(
  editor: any,
  paths: string[],
  afterId: string | null,
  notePath: string | null
): Promise<void> {
  let ref = afterId ?? editor.document[editor.document.length - 1]?.id ?? null;
  for (const sourcePath of paths) {
    if (!ref) return;
    const r = await window.api.vault.saveImageForNote({ notePath, sourcePath });
    const blockSrc = r.ok ? r.persistSrc || null : null;
    if (!blockSrc) {
      console.warn('[editor] image insert skipped:', sourcePath);
      continue;
    }
    ref = insertImageBlock(editor, ref, blockSrc) ?? ref;
  }
}

function insertImageBlock(editor: any, ref: string, src: string): string | null {
  const target = findBlockById(editor.document, ref);
  if (isEmptyParagraphBlock(target)) {
    const result = (
      editor.replaceBlocks as (
        remove: string[],
        insert: Array<{ type: string; props?: Record<string, unknown> }>
      ) => { insertedBlocks?: Array<{ id: string; type: string }> }
    )([target.id], [{ type: 'image', props: { src } }, { type: 'paragraph' }]);
    const inserted = result.insertedBlocks ?? [];
    const image = inserted.find((b) => b.type === 'image') ?? null;
    const paragraph = inserted.find((b) => b.type === 'paragraph') ?? null;
    if (paragraph) {
      requestAnimationFrame(() => editor.setTextCursorPosition(paragraph.id, 'start'));
    }
    return image?.id ?? paragraph?.id ?? null;
  }
  const [inserted] = editor.insertBlocks([{ type: 'image', props: { src } }], ref, 'after');
  return inserted?.id ?? null;
}

function clearDropCursor(view: any): void {
  try {
    view.dom.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true }));
  } catch {
    // ignore; insertion still succeeds if the browser refuses synthetic drag events
  }
}

function findBlockById(blocks: readonly any[], id: string): any | null {
  for (const block of blocks) {
    if (block?.id === id) return block;
    if (Array.isArray(block?.children)) {
      const child = findBlockById(block.children, id);
      if (child) return child;
    }
  }
  return null;
}

function isEmptyParagraphBlock(block: any): block is { id: string; type: string } {
  return (
    !!block &&
    typeof block.id === 'string' &&
    block.type === 'paragraph' &&
    (!Array.isArray(block.children) || block.children.length === 0) &&
    blockPlainText(block).trim() === ''
  );
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
