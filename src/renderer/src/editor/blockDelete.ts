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
  replaceBlocks: (remove: string[], insert: Array<{ type: string }>) => void;
};

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
    // empty paragraph instead.
    editor.replaceBlocks(coveredIds, [{ type: 'paragraph' }]);
  } else {
    editor.removeBlocks(coveredIds);
  }
  return true;
}
