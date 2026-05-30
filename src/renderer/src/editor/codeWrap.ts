import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

const KEY = new PluginKey('simple-note-code-wrap');

// Lucide "wrap-text" icon.
const WRAP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="3" y1="6" x2="21" y2="6"/>' +
  '<path d="M3 12h15a3 3 0 1 1 0 6h-4"/>' +
  '<polyline points="16 16 14 18 16 20"/>' +
  '<line x1="3" y1="18" x2="10" y2="18"/></svg>';

function buildButton(active: boolean, toggle: () => void): HTMLElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-wrap-toggle' + (active ? ' active' : '');
  btn.contentEditable = 'false';
  btn.title = active ? '取消自動換行' : '自動換行';
  btn.setAttribute('aria-label', '切換程式碼自動換行');
  btn.innerHTML = WRAP_ICON;
  // mousedown (not click) + preventDefault so the editor selection isn't moved
  // into the code block when the button is pressed.
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  });
  return btn;
}

// Renders a word-wrap toggle in the top-right corner of every code block. The
// toggle drives a single global wrap state (getWrap / toggleWrap), so pressing
// any one of them flips wrapping for all code blocks. Decorations recompute on
// every transaction, so a no-op meta transaction (dispatched when the global
// state changes) is enough to refresh the active styling.
export function createCodeWrapPlugin(getWrap: () => boolean, toggleWrap: () => void): Plugin {
  return new Plugin({
    key: KEY,
    props: {
      decorations(state) {
        const wrapped = getWrap();
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'codeBlock') return true;
          decos.push(
            Decoration.widget(pos + 1, () => buildButton(wrapped, toggleWrap), {
              side: -1,
              key: `code-wrap-${pos}-${wrapped ? 'on' : 'off'}`,
              ignoreSelection: true,
            })
          );
          // Don't walk into the code block's text.
          return false;
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
