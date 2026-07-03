import { filterSuggestionItems, insertOrUpdateBlock } from '@blocknote/core';
import {
  SuggestionMenuController,
  useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from '@blocknote/react';

type SNEditor = ReturnType<typeof useCreateBlockNote>;

// Slash (/) menu, deliberately smaller than BlockNote's default: only the block
// types that already have a keyboard shortcut in Editor.tsx (the badge shows
// it), plus Table, which has no shortcut and is only reachable from this menu.
// Items intentionally carry no `group` so the menu renders as a flat list.
function slashMenuItems(editor: SNEditor): DefaultReactSuggestionItem[] {
  const insert =
    (block: Record<string, unknown>) => (): void =>
      void (insertOrUpdateBlock as (e: unknown, b: unknown) => unknown)(editor, block);

  return [
    {
      title: '段落',
      badge: '⌘1',
      aliases: ['paragraph', 'p', 'text'],
      onItemClick: insert({ type: 'paragraph' }),
    },
    {
      title: '折疊清單',
      badge: '⌘2',
      aliases: ['toggle', 'collapse'],
      onItemClick: () => {
        const block = (insertOrUpdateBlock as (e: unknown, b: unknown) => { id: string })(editor, {
          type: 'toggle',
        });
        // toggle 是 React node view，內容 DOM 要等 React 繪製後才存在；同步設的游標
        // 會落空（打字沒有反應），需在 rAF 內重設一次（同 toggle.tsx 的 sibling 處理）。
        requestAnimationFrame(() => {
          editor.setTextCursorPosition(block.id, 'start');
          editor.focus();
        });
      },
    },
    {
      title: '項目符號清單',
      badge: '⌘3',
      aliases: ['bullet', 'list', 'ul'],
      onItemClick: insert({ type: 'bulletListItem' }),
    },
    {
      title: '程式碼區塊',
      badge: '⌘4',
      aliases: ['code', 'codeblock'],
      onItemClick: insert({ type: 'codeBlock' }),
    },
    {
      title: '核取方塊',
      badge: '⌘5',
      aliases: ['check', 'checkbox', 'todo'],
      onItemClick: insert({ type: 'checkListItem' }),
    },
    {
      title: '引言',
      badge: '⇧⌘L',
      aliases: ['quote', 'blockquote'],
      onItemClick: insert({ type: 'quote' }),
    },
    {
      title: '標題 1',
      badge: '⌥⌘1',
      aliases: ['h1', 'heading1', 'heading'],
      onItemClick: insert({ type: 'heading', props: { level: 1 } }),
    },
    {
      title: '標題 2',
      badge: '⌥⌘2',
      aliases: ['h2', 'heading2'],
      onItemClick: insert({ type: 'heading', props: { level: 2 } }),
    },
    {
      title: '標題 3',
      badge: '⌥⌘3',
      aliases: ['h3', 'heading3'],
      onItemClick: insert({ type: 'heading', props: { level: 3 } }),
    },
    {
      title: '表格',
      aliases: ['table'],
      onItemClick: insert({
        type: 'table',
        content: {
          type: 'tableContent',
          // headerRows: 1,讓第一列作為表頭。Markdown 管線表格必有表頭列,若插入
          // 無表頭的表格,存檔時 serializer 會補一列空表頭,重新開檔就多出一列。
          headerRows: 1,
          rows: [{ cells: ['', '', ''] }, { cells: ['', '', ''] }],
        },
      }),
    },
  ];
}

export function SimpleNoteSlashMenu({ editor }: { editor: SNEditor }): JSX.Element {
  return (
    <SuggestionMenuController
      triggerCharacter="/"
      getItems={async (query) => filterSuggestionItems(slashMenuItems(editor), query)}
    />
  );
}
