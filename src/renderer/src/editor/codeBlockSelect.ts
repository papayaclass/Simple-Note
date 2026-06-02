import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const KEY = new PluginKey('simple-note-codeblock-select');

// When a (non-empty) selection fully covers a code block or a toggle — e.g. a
// marquee drag that touched it — highlight the whole block instead of showing
// the ragged per-character text selection inside it. The accompanying CSS paints
// the block and hides the inner ::selection, so it reads as "the block is
// selected". Decorations are derived from state, so this clears itself the moment
// the selection changes.
const WHOLE_BLOCK_TYPES = new Set(['codeBlock', 'toggle']);

export function createCodeBlockSelectPlugin(): Plugin {
  return new Plugin({
    key: KEY,
    props: {
      decorations(state) {
        const { selection } = state;
        if (selection.empty) return null;
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (!WHOLE_BLOCK_TYPES.has(node.type.name)) return true;
          const contentFrom = pos + 1;
          const contentTo = pos + node.nodeSize - 1;
          if (selection.from <= contentFrom && selection.to >= contentTo) {
            decos.push(
              Decoration.node(pos, pos + node.nodeSize, { class: 'sn-block-selected' })
            );
          }
          // A toggle's children live in a sibling blockGroup, not inside this
          // content node, so there's nothing to recurse into here.
          return true;
        });
        return decos.length ? DecorationSet.create(state.doc, decos) : null;
      },
    },
  });
}
