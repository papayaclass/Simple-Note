import { useEffect, useState } from 'react';
import {
  halfToFullPunctuation,
  simplifiedToTraditional,
  LOREM_IPSUM,
  wordCount,
} from './transforms';
import { useStore } from '../store';

interface Props {
  editor: any;
}

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

export function ContextMenu({ editor }: Props): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const setWordCount = useStore((s) => s.setWordCountPopover);

  useEffect(() => {
    function onContext(e: MouseEvent) {
      const root = document.querySelector('.bn-container');
      if (!root || !root.contains(e.target as Node)) return;
      e.preventDefault();
      const sel = window.getSelection();
      const hasSelection = !!sel && !sel.isCollapsed && sel.toString().length > 0;
      setMenu({ x: e.clientX, y: e.clientY, hasSelection });
    }
    function onClick() {
      setMenu(null);
    }
    window.addEventListener('contextmenu', onContext);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('contextmenu', onContext);
      window.removeEventListener('mousedown', onClick);
    };
  }, []);

  if (!menu) return null;

  const close = () => setMenu(null);

  const transformSelection = (fn: (text: string) => string) => {
    const sel = editor.getSelectedText?.();
    if (sel) {
      const newText = fn(sel);
      editor._tiptapEditor.commands.insertContent(newText);
    } else {
      const range = window.getSelection()?.toString() ?? '';
      if (range) document.execCommand('insertText', false, fn(range));
    }
  };

  const clearFormatting = () => {
    const tipTap = editor._tiptapEditor;
    tipTap.chain().focus().unsetAllMarks().run();
  };

  // BlockNote turns "\n" inside a text node into a hardBreak when rendering
  // (see BlockNoteSchema: text.split(/(\n)/g) → hardBreak). So merging multiple
  // selected blocks into one block with "\n" between them gives the user a
  // single paragraph whose former block boundaries are now soft line breaks.
  const mergeParagraphBreaks = () => {
    const sel = editor.getSelection?.();
    const blocks = sel?.blocks ?? [];
    if (blocks.length < 2) return;
    const first = blocks[0];
    const merged: any[] = [];
    blocks.forEach((b: any, i: number) => {
      if (i > 0) merged.push({ type: 'text', text: '\n', styles: {} });
      const c = b.content;
      if (Array.isArray(c)) merged.push(...c);
      else if (typeof c === 'string' && c.length > 0)
        merged.push({ type: 'text', text: c, styles: {} });
    });
    (editor.replaceBlocks as (a: unknown, b: unknown) => unknown)(blocks, [
      { type: first.type, props: first.props, content: merged },
    ]);
  };

  const insertLoremIpsum = () => {
    const tipTap = editor._tiptapEditor;
    tipTap.chain().focus().insertContent(LOREM_IPSUM).run();
  };

  const doWordCount = () => {
    const text = window.getSelection()?.toString() ?? '';
    const wc = wordCount(text);
    setWordCount({ count: wc.words, chars: wc.chars, charsNoSpace: wc.charsNoSpace, chinese: wc.chinese });
  };

  const items = [
    {
      label: '簡體轉繁體',
      disabled: !menu.hasSelection,
      onClick: () => {
        transformSelection(simplifiedToTraditional);
        close();
      },
    },
    {
      label: '半形標點轉全形',
      disabled: !menu.hasSelection,
      onClick: () => {
        transformSelection(halfToFullPunctuation);
        close();
      },
    },
    {
      label: '清除所有格式',
      disabled: !menu.hasSelection,
      onClick: () => {
        clearFormatting();
        close();
      },
    },
    {
      label: '分段符號轉分行符號',
      disabled: !menu.hasSelection,
      onClick: () => {
        mergeParagraphBreaks();
        close();
      },
    },
    { divider: true },
    {
      label: '插入 Lorem Ipsum',
      onClick: () => {
        insertLoremIpsum();
        close();
      },
    },
    {
      label: '字數統計',
      disabled: !menu.hasSelection,
      onClick: () => {
        doWordCount();
        close();
      },
    },
  ];

  return (
    <div
      className="context-menu"
      style={{ position: 'fixed', top: menu.y, left: menu.x }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((item, i) =>
        'divider' in item ? (
          <div key={i} className="context-menu-divider" />
        ) : (
          <button
            key={i}
            className="context-menu-item"
            disabled={item.disabled}
            onClick={item.onClick}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
