import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { evaluateLine, formatNumber } from './evaluator';

const KEY = new PluginKey('math-overlay');

function buildResultEl(text: string, isError: boolean): HTMLElement {
  const span = document.createElement('span');
  span.className = 'math-result' + (isError ? ' math-error' : '');
  span.textContent = text;
  return span;
}

interface State {
  decorations: DecorationSet;
  enabled: boolean;
}

export function createMathPlugin(getEnabled: () => boolean): Plugin {
  function recompute(doc: any): DecorationSet {
    if (!getEnabled()) return DecorationSet.empty;
    const decos: Decoration[] = [];
    const vars = new Map<string, number>();

    doc.descendants((node: any, pos: number) => {
      if (!node.isTextblock) return true;
      const text = node.textContent;
      if (!text || !text.includes('=')) return false;
      const result = evaluateLine(text, vars, formatNumber);
      const endPos = pos + node.nodeSize - 1;
      if (result.kind === 'query') {
        decos.push(
          Decoration.widget(endPos, () => buildResultEl(result.display, false), { side: 1 })
        );
      } else if (result.kind === 'error') {
        // Silence "未定義變數" while user is still typing; show only meaningful arithmetic errors
        const isUndefinedVar = result.message.startsWith('未定義變數');
        const isSyntax = result.message === '語法錯誤' || result.message.startsWith('缺右括號') || result.message.startsWith('未知字元');
        if (!isUndefinedVar && !isSyntax) {
          decos.push(
            Decoration.widget(endPos, () => buildResultEl(result.message, true), { side: 1 })
          );
        }
      }
      return false;
    });

    return DecorationSet.create(doc, decos);
  }

  return new Plugin({
    key: KEY,
    state: {
      init: (_c, state) => ({ decorations: recompute(state.doc), enabled: getEnabled() }) as State,
      apply: (tr, value, _o, newState) => {
        const meta = tr.getMeta(KEY);
        if (tr.docChanged || meta || value.enabled !== getEnabled()) {
          return { decorations: recompute(newState.doc), enabled: getEnabled() };
        }
        return value;
      },
    },
    props: {
      decorations(state) {
        return (this.getState(state) as State).decorations;
      },
    },
  });
}

export function refreshMathPlugin(): void {
  // exported helper if external code wants to force redraw (e.g., prefs change)
}
