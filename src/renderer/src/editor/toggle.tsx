import { createBlockNoteExtension, defaultProps } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';

// Notion-style collapsible block.
//
// BlockNote 0.40's built-in `toggleListItem` has no interactive rendering through
// BlockNoteView (it shows up as a plain paragraph), so we define our own `toggle`
// block. Unlike BlockNote's `ToggleWrapper` — which keeps the open/closed state in
// localStorage — we store it in an `open` prop on the block itself, so the state
// lives in the document model and can be driven from keyboard shortcuts.
//
// The chevron / collapse visuals reuse BlockNote's own CSS: a `.bn-toggle-wrapper`
// with `data-show-children` hides the child `.bn-block-group` when closed, and
// `.bn-toggle-button` styles + rotates the chevron.
const CHEVRON_PATH = 'M320-200v-560l440 280-440 280Z';

export const Toggle = createReactBlockSpec(
  {
    type: 'toggle',
    propSchema: { ...defaultProps, open: { default: true } },
    content: 'inline',
  },
  {
    // props typed as `any`: BlockNote's render FC type and our usage only need
    // block.props.open, editor.updateBlock and contentRef, which line up at runtime.
    render: (props: any) => {
      const open = props.block.props.open !== false;
      return (
        <div>
          <div className="bn-toggle-wrapper" data-show-children={open ? 'true' : 'false'}>
            <button
              className="bn-toggle-button"
              type="button"
              contentEditable={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => props.editor.updateBlock(props.block, { props: { open: !open } })}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" fill="currentcolor">
                <path d={CHEVRON_PATH} />
              </svg>
            </button>
            <p ref={props.contentRef} />
          </div>
        </div>
      );
    },
  }
);

// Keyboard behaviour, registered as a BlockNote extension in Editor.tsx. Both
// handlers return false when the cursor isn't in a toggle, so they chain after
// the other Enter handlers (e.g. the timer extension).
export function createToggleKeyboardExtension() {
  return createBlockNoteExtension({
    key: 'simple-note-toggle-keys',
    keyboardShortcuts: {
      // Enter on a toggle's own line:
      //  - expanded → move the cursor inside as a (first) child to keep typing.
      //  - collapsed → create a sibling toggle below, like a list item.
      Enter: ({ editor }: { editor: any }) => {
        const { block } = editor.getTextCursorPosition();
        if (block.type !== 'toggle') return false;
        const open = block.props.open !== false;
        if (open) {
          // Create the child already nested (single transaction). Inserting a
          // sibling and then nesting it would briefly render the block outside
          // the toggle and animate it inward — this avoids that jump.
          const updated = editor.updateBlock(block, {
            children: [{ type: 'paragraph' }, ...(block.children || [])],
          });
          editor.setTextCursorPosition(updated.children[0].id, 'end');
          return true;
        }
        const [sib] = editor.insertBlocks(
          [{ type: 'toggle', props: { open: true } }],
          block,
          'after'
        );
        // The new toggle is a React node view; its editable content DOM only
        // exists after React paints, so defer placing the caret until then,
        // otherwise the next keystroke lands back in the original block.
        requestAnimationFrame(() => {
          editor.setTextCursorPosition(sib.id, 'end');
          editor.focus();
        });
        return true;
      },
      // Cmd/Ctrl+Enter collapses or expands the toggle the cursor is in.
      'Mod-Enter': ({ editor }: { editor: any }) => {
        const { block } = editor.getTextCursorPosition();
        if (block.type !== 'toggle') return false;
        editor.updateBlock(block, { props: { open: block.props.open === false } });
        return true;
      },
    },
  });
}
