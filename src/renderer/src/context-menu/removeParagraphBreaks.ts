type InlineContent = Array<Record<string, unknown>>;

interface TextBlock {
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown[];
}

function inlineContent(content: unknown): InlineContent {
  if (Array.isArray(content)) return content as InlineContent;
  if (typeof content === 'string' && content.length > 0) {
    return [{ type: 'text', text: content, styles: {} }];
  }
  return [];
}

function isBlankParagraph(block: TextBlock): boolean {
  if (block.type !== 'paragraph' || (block.children?.length ?? 0) > 0) return false;
  const content = inlineContent(block.content);
  return content.every((span) => {
    const text = span.text;
    return typeof text !== 'string' || text.length === 0;
  });
}

function copyBlock(block: TextBlock): TextBlock {
  return {
    type: block.type,
    props: block.props,
    content: inlineContent(block.content),
    ...(block.children?.length ? { children: block.children } : {}),
  };
}

// PDF text commonly arrives as one paragraph block per visual line. Join
// adjacent paragraph blocks directly; an empty paragraph means the source had
// at least two consecutive paragraph breaks, so collapse that run to one real
// paragraph boundary instead of joining everything into a single paragraph.
export function removeParagraphBreaks(editor: any): boolean {
  const blocks = (editor.getSelection?.()?.blocks ?? []) as TextBlock[];
  if (blocks.length < 2) return false;

  const result: TextBlock[] = [];
  let current: TextBlock | null = null;
  let preserveBoundary = false;

  for (const block of blocks) {
    if (isBlankParagraph(block)) {
      preserveBoundary = true;
      continue;
    }

    const next = copyBlock(block);
    const canJoin =
      !preserveBoundary && current?.type === 'paragraph' && next.type === 'paragraph';

    if (current && canJoin) {
      current.content = [...inlineContent(current.content), ...inlineContent(next.content)];
    } else {
      if (current) result.push(current);
      current = next;
    }
    preserveBoundary = false;
  }

  if (current) result.push(current);
  if (result.length === 0) result.push({ type: 'paragraph', content: [] });

  (editor.replaceBlocks as (remove: unknown, insert: unknown) => unknown)(blocks, result);
  return true;
}
