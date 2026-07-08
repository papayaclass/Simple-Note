import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { common, createLowlight } from 'lowlight';

const KEY = new PluginKey('simple-note-code-highlight');

const lowlight = createLowlight(common);
const PLAIN_TEXT_LANGUAGES = new Set(['', 'text', 'plain', 'plaintext', 'none']);

type HastNode = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function normalizeLanguage(language: unknown): string {
  return typeof language === 'string' ? language.trim().toLowerCase() : '';
}

function classNameFrom(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.map(String).join(' ');
  if (typeof value === 'string') return value;
  return undefined;
}

function nodeTextSize(node: HastNode): number {
  if (node.type === 'text') return node.value?.length ?? 0;
  return (node.children ?? []).reduce((sum, child) => sum + nodeTextSize(child), 0);
}

function fillDecorations(decorations: Decoration[], node: HastNode, from: number): number {
  if (node.type === 'text') return from + (node.value?.length ?? 0);

  if (node.type === 'element') {
    const to = from + nodeTextSize(node);
    const className = classNameFrom(node.properties?.className);
    if (className && to > from) {
      decorations.push(
        Decoration.inline(from, to, {
          class: className,
          nodeName: node.tagName || 'span',
        })
      );
    }
    return to;
  }

  return (node.children ?? []).reduce((pos, child) => fillDecorations(decorations, child, pos), from);
}

function highlightCode(content: string, language: unknown, pos: number): Decoration[] {
  const normalized = normalizeLanguage(language);
  if (PLAIN_TEXT_LANGUAGES.has(normalized) || !lowlight.registered(normalized)) return [];

  try {
    const root = lowlight.highlight(normalized, content) as HastNode;
    const decorations: Decoration[] = [];
    fillDecorations(decorations, root, pos + 1);
    return decorations;
  } catch {
    return [];
  }
}

export function createCodeHighlightPlugin(): Plugin {
  return new Plugin({
    key: KEY,
    props: {
      decorations(state) {
        const decos: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.type.name !== 'codeBlock') return true;
          decos.push(...highlightCode(node.textContent, node.attrs.language, pos));
          return false;
        });
        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}
