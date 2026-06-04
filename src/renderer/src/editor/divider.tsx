import { defaultProps } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';

// Notion-style horizontal divider.
//
// BlockNote 0.40's default schema has no horizontal-rule block, so we define our
// own content-less `divider` block. It renders a plain <hr>, exports to Markdown
// as a thematic break, and (via `parse`) is recreated from any <hr> when loading
// Markdown — keeping the round-trip lossless. Typing `---` on its own line turns
// the paragraph into one of these (handled in Editor.tsx).
export const Divider = createReactBlockSpec(
  {
    type: 'divider',
    propSchema: { ...defaultProps },
    content: 'none',
  },
  {
    render: () => <hr className="bn-divider" />,
    // Used by blocksToMarkdownLossy: an <hr> serializes to a Markdown thematic break.
    toExternalHTML: () => <hr />,
    // Used when parsing Markdown/HTML back into blocks: a thematic break (`---`)
    // becomes an <hr>, which we map back to a divider block.
    parse: (el) => (el.nodeName === 'HR' ? {} : undefined),
  }
);
