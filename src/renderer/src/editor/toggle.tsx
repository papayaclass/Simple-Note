import { createBlockNoteExtension, defaultProps } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import type { MouseEvent, PointerEvent } from 'react';

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

function stopEditorPointerHandling(
  event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>
): void {
  event.preventDefault();
  event.stopPropagation();
}

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
              aria-expanded={open}
              aria-label={open ? '摺疊 Toggle List' : '展開 Toggle List'}
              title={open ? '摺疊 Toggle List' : '展開 Toggle List'}
              draggable={false}
              onPointerDownCapture={stopEditorPointerHandling}
              onMouseDownCapture={stopEditorPointerHandling}
              onMouseDown={stopEditorPointerHandling}
              onClick={(event) => {
                stopEditorPointerHandling(event);
                props.editor.updateBlock(props.block, { props: { open: !open } });
              }}
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

// ---------- 剪貼簿 (跨 App 轉移，格式說明見 toggleClipboard.ts) ----------

const containsToggle = (b: any): boolean =>
  b.type === 'toggle' || (b.children ?? []).some(containsToggle);

// BlockNote 輸出外部 HTML 時會把子 block 攤平成兄弟節點，Toggle 結構因此消失。
// 含 Toggle 的部分改由這裡輸出 <details>，其他 block 仍交給 blocksToHTMLLossy。
export function toggleBlocksToHTML(editor: any, blocks: any[]): string | null {
  if (!blocks.some(containsToggle)) return null;
  let html = '';
  let run: any[] = [];
  const flush = (): void => {
    if (run.length) html += editor.blocksToHTMLLossy(run);
    run = [];
  };
  for (const b of blocks) {
    if (!containsToggle(b)) {
      run.push(b);
      continue;
    }
    flush();
    const children = toggleBlocksToHTML(editor, b.children) ?? editor.blocksToHTMLLossy(b.children);
    if (b.type === 'toggle') {
      const tpl = document.createElement('template');
      tpl.innerHTML = editor.blocksToHTMLLossy([{ type: 'paragraph', content: b.content }]);
      const summary = tpl.content.firstElementChild?.innerHTML ?? '';
      html += `<details${b.props.open !== false ? ' open' : ''}><summary>${summary}</summary>${children}</details>`;
    } else {
      html += editor.blocksToHTMLLossy([{ ...b, children: [] }]) + children;
    }
  }
  flush();
  return html;
}

// 外部 HTML 裡的 <details> 轉成 toggle block，其他內容交給 tryParseHTMLToBlocks。
export function htmlToToggleBlocks(editor: any, html: string): any[] {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const convert = (nodes: Node[]): any[] => {
    const out: any[] = [];
    let run: Node[] = [];
    const flush = (): void => {
      const div = document.createElement('div');
      run.forEach((n) => div.appendChild(n.cloneNode(true)));
      if (div.textContent?.trim() || div.querySelector('img, hr')) out.push(...editor.tryParseHTMLToBlocks(div.innerHTML));
      run = [];
    };
    for (const n of nodes) {
      if (!(n instanceof Element) || (n.tagName !== 'DETAILS' && !n.querySelector('details'))) {
        run.push(n);
        continue;
      }
      flush();
      if (n.tagName !== 'DETAILS') {
        // 包著 <details> 的外層 (例如 Simple Canvas 的 toggle-list div)：往裡面找
        out.push(...convert(Array.from(n.childNodes)));
        continue;
      }
      const kids = Array.from(n.childNodes);
      const summary = kids.find((k) => k instanceof Element && k.tagName === 'SUMMARY') as Element | undefined;
      const title = summary ? editor.tryParseHTMLToBlocks(`<p>${summary.innerHTML}</p>`)[0] : undefined;
      out.push({
        type: 'toggle',
        props: { open: n.hasAttribute('open') },
        content: title?.content ?? [],
        children: convert(kids.filter((k) => k !== summary)),
      });
    }
    flush();
    return out;
  };
  return convert(Array.from(tpl.content.childNodes));
}
