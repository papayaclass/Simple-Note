import {
  BlockColorsItem,
  DragHandleMenu,
  RemoveBlockItem,
  useBlockNoteEditor,
  useComponentsContext,
  type DragHandleMenuProps,
} from '@blocknote/react';
import { parseYouTubeId } from './youtubePreview';

// First YouTube video URL among a block's inline-content links, or null.
// Only paragraphs / headings / list items expose an inline-content array; table
// blocks (content is a row tree, not an array) and media blocks fall through.
function youTubeUrlInBlock(block: { content?: unknown }): string | null {
  const content = block.content;
  if (!Array.isArray(content)) return null;
  for (const item of content as Array<{ type?: string; href?: string }>) {
    if (item?.type === 'link' && typeof item.href === 'string' && parseYouTubeId(item.href)) {
      return item.href;
    }
  }
  return null;
}

// Copies the block's underlying YouTube link to the clipboard. Rendered only for
// blocks that actually contain one, so the label never shows on a plain block.
function CopyYouTubeLinkItem({ url }: { url: string }): JSX.Element | null {
  const Components = useComponentsContext();
  if (!Components) return null;
  return (
    <Components.Generic.Menu.Item
      className="bn-menu-item"
      onClick={() => window.api.clipboard.writeText(url)}
    >
      Copy Link
    </Components.Generic.Menu.Item>
  );
}

// Drag-handle (left side) menu. A block holding a YouTube link gets a "Copy Link"
// item prepended to the default Delete / Colors items; every other block —
// including tables — falls back to BlockNote's untouched default menu.
export function SimpleNoteDragHandleMenu(props: DragHandleMenuProps<any, any, any>): JSX.Element {
  const editor = useBlockNoteEditor();
  const ytUrl = youTubeUrlInBlock(props.block);
  if (!ytUrl) return <DragHandleMenu {...props} />;
  const dict = editor.dictionary;
  return (
    <DragHandleMenu {...props}>
      <CopyYouTubeLinkItem url={ytUrl} />
      <RemoveBlockItem {...props}>{dict.drag_handle.delete_menuitem}</RemoveBlockItem>
      <BlockColorsItem {...props}>{dict.drag_handle.colors_menuitem}</BlockColorsItem>
    </DragHandleMenu>
  );
}
