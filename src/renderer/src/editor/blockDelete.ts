// Deletes whole blocks when the selection cleanly covers them — the behaviour
// expected after a marquee block-selection (and matching Notion). Returns true
// if it handled the key (so the default char/merge behaviour is suppressed),
// false to fall through to BlockNote's normal Backspace/Delete.
//
// Rules, to avoid disrupting ordinary editing:
//   - Every block the selection touches must be *fully* covered (no partial
//     block) — otherwise it's a normal text selection → fall through.
//   - A single fully-covered block only triggers whole-block deletion when it's
//     a code block (a fully-selected paragraph keeps the default: clear text,
//     keep the block). Multiple covered blocks always delete as whole blocks.
type AnyEditor = {
  _tiptapEditor: { state: any };
  removeBlocks: (ids: string[]) => void;
  replaceBlocks: (
    remove: string[],
    insert: Array<{ type: string }>
  ) => { insertedBlocks?: Array<{ id: string }> };
  setTextCursorPosition: (block: string | { id: string }, placement?: 'start' | 'end') => void;
};

type ForwardDeleteEditor = {
  _tiptapEditor: { state: any };
  getTextCursorPosition: () => { block: any; nextBlock?: any };
  removeBlocks: (blocks: any[]) => void;
  setTextCursorPosition: (block: any, placement?: 'start' | 'end') => void;
};

// Pulls the following block up when Delete is pressed on an empty line.
//
// BlockNote 0.40 refuses to merge forward when the *current* block is empty: its
// merge guard (`canMergeBlocks`) requires the first of the two blocks to have
// content, so the forward-merge command no-ops yet still swallows the key. The
// net effect is that pressing Delete on a blank line does nothing — the text
// below never moves up. (Backspace is unaffected because then the non-empty
// block above is the first of the pair.) ProseMirror's `joinForward` is no help
// here either: in BlockNote's nested blockContainer/blockGroup schema it joins at
// the wrong level and drops the next block's content.
//
// So we do the simple, lossless thing: when the cursor sits in an empty leaf
// block that has a following block, remove the empty block and move the cursor to
// the start of that next block — which is exactly "delete the blank line and
// bring the text below up". Returns true if handled, false to fall through to
// BlockNote's default Delete (mid-text deletion, or an empty *last* block where
// there's nothing to pull up).
export function deleteForwardEmptyBlock(editor: ForwardDeleteEditor): boolean {
  if (!editor._tiptapEditor.state.selection.empty) return false;
  const { block, nextBlock } = editor.getTextCursorPosition();
  const empty = !block.content || (Array.isArray(block.content) && block.content.length === 0);
  const hasChildren = Array.isArray(block.children) && block.children.length > 0;
  if (!empty || hasChildren || !nextBlock) return false;
  editor.removeBlocks([block]);
  editor.setTextCursorPosition(nextBlock, 'start');
  return true;
}

export function deleteSelectedBlocks(editor: AnyEditor): boolean {
  const state = editor._tiptapEditor.state;
  const sel = state.selection;
  if (sel.empty) return false;

  const group = state.doc.firstChild;
  if (!group || group.type.name !== 'blockGroup') return false;

  const coveredIds: string[] = [];
  let coveredType = '';
  let partial = false;

  group.forEach((child: any, offset: number) => {
    const blockPos = 1 + offset; // absolute pos of this top-level blockContainer
    const nodeStart = blockPos;
    const nodeEnd = blockPos + child.nodeSize;
    const overlaps = sel.from < nodeEnd && sel.to > nodeStart;
    if (!overlaps) return;

    let cFrom = -1;
    let cTo = -1;
    let type = '';
    child.forEach((g: any, gOff: number) => {
      if (cFrom === -1 && g.type.spec.group === 'blockContent') {
        const before = blockPos + 1 + gOff;
        cFrom = before + 1;
        cTo = before + g.nodeSize - 1;
        type = g.type.name;
      }
    });
    if (cFrom === -1) {
      partial = true; // a block without resolvable content → bail out safely
      return;
    }
    if (sel.from <= cFrom && sel.to >= cTo) {
      coveredIds.push(child.attrs.id);
      coveredType = type;
    } else {
      partial = true;
    }
  });

  if (partial || coveredIds.length === 0) return false;
  // A single fully-covered block only deletes wholesale for code blocks and
  // toggles; other single blocks keep the default (clear text, keep the block).
  if (coveredIds.length === 1 && coveredType !== 'codeBlock' && coveredType !== 'toggle') {
    return false;
  }

  if (coveredIds.length >= group.childCount) {
    // Removing every block would leave an invalid empty document; reset to one
    // empty paragraph instead. Replacing under an AllSelection (Cmd+A ×2) keeps
    // the mapped selection as a block-spanning AllSelection, and the next typed
    // character then arrives as a range replacement (from ≠ to) — which breaks
    // anything keyed on collapsed text input, e.g. the slash-menu trigger. Reset
    // to a collapsed caret in the fresh paragraph.
    const res = editor.replaceBlocks(coveredIds, [{ type: 'paragraph' }]);
    const fresh = res?.insertedBlocks?.[0];
    if (fresh) editor.setTextCursorPosition(fresh, 'start');
  } else {
    editor.removeBlocks(coveredIds);
  }
  return true;
}
