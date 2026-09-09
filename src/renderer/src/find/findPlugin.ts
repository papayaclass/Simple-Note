import { Plugin, PluginKey, TextSelection, EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';

export interface FindMatch {
  from: number;
  to: number;
}

interface FindPluginState {
  query: string;
  caseSensitive: boolean;
  matches: FindMatch[];
  // Index into `matches` of the highlighted "current" hit, or -1 for none.
  active: number;
}

export const findPluginKey = new PluginKey<FindPluginState>('simple-note-find');

// Lowercase without ever changing the string's UTF-16 length — match offsets
// are ProseMirror positions, so a character whose lowercase form is longer
// (İ → i̇) would desynchronise every position after it.
function foldCase(s: string): string {
  let out = '';
  for (const ch of s) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

// Scan every textblock for the needle. Within one textblock a character's
// offset maps directly onto a document position, so matches are found on the
// block's flattened text and therefore span mark boundaries (a bold letter in
// the middle of a word doesn't hide the match). Non-text inline leaves are
// stubbed with U+FFFC, which keeps them one character wide like their nodeSize.
function computeMatches(doc: PMNode, query: string, caseSensitive: boolean): FindMatch[] {
  const out: FindMatch[] = [];
  if (!query) return out;
  const needle = caseSensitive ? query : foldCase(query);
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    const start = pos + 1;
    const raw = doc.textBetween(start, start + node.content.size, undefined, '￼');
    const text = caseSensitive ? raw : foldCase(raw);
    let idx = text.indexOf(needle);
    while (idx !== -1) {
      out.push({ from: start + idx, to: start + idx + needle.length });
      idx = text.indexOf(needle, idx + needle.length);
    }
    return false; // textblocks never nest — no need to walk their inline content
  });
  return out;
}

export function createFindPlugin(): Plugin {
  return new Plugin<FindPluginState>({
    key: findPluginKey,
    state: {
      init: () => ({ query: '', caseSensitive: false, matches: [], active: -1 }),
      apply(tr, prev, _oldState, newState) {
        const meta = tr.getMeta(findPluginKey) as Partial<FindPluginState> | undefined;
        let next = meta ? { ...prev, ...meta } : prev;
        const queryChanged =
          meta?.query !== undefined || meta?.caseSensitive !== undefined;
        if (queryChanged || tr.docChanged) {
          const matches = computeMatches(newState.doc, next.query, next.caseSensitive);
          const active = next.active >= matches.length ? matches.length - 1 : next.active;
          next = { ...next, matches, active };
        }
        return next;
      },
    },
    props: {
      decorations(state) {
        const s = findPluginKey.getState(state);
        if (!s || !s.query || s.matches.length === 0) return DecorationSet.empty;
        return DecorationSet.create(
          state.doc,
          s.matches.map((m, i) =>
            Decoration.inline(m.from, m.to, {
              class: i === s.active ? 'sn-find-match sn-find-match-active' : 'sn-find-match',
            })
          )
        );
      },
    },
  });
}

// --- imperative API used by the find bar -----------------------------------

// The BlockNote editor object; its underlying TipTap editor owns the PM view.
// Taken as `unknown` so callers can pass editors around without importing
// BlockNote's generic-heavy editor type.
type AnyEditor = unknown;

function viewOf(editor: AnyEditor): EditorView | null {
  const view = (editor as { _tiptapEditor?: { view?: EditorView } })?._tiptapEditor?.view;
  return view && !(view as unknown as { isDestroyed?: boolean }).isDestroyed ? view : null;
}

function stateOf(editor: AnyEditor): { view: EditorView; state: EditorState } | null {
  const view = viewOf(editor);
  return view ? { view, state: view.state } : null;
}

// Push a plugin-only transaction (never a document change, never undoable).
function dispatchMeta(view: EditorView, meta: Partial<FindPluginState>): void {
  view.dispatch(view.state.tr.setMeta(findPluginKey, meta).setMeta('addToHistory', false));
}

export function setFindQuery(
  editor: AnyEditor,
  query: string,
  caseSensitive: boolean
): number {
  const ctx = stateOf(editor);
  if (!ctx) return 0;
  dispatchMeta(ctx.view, { query, caseSensitive, active: -1 });
  return findPluginKey.getState(ctx.view.state)?.matches.length ?? 0;
}

export function clearFind(editor: AnyEditor): void {
  const ctx = stateOf(editor);
  if (!ctx) return;
  dispatchMeta(ctx.view, { query: '', active: -1 });
}

export function matchCount(editor: AnyEditor): number {
  const ctx = stateOf(editor);
  return ctx ? (findPluginKey.getState(ctx.state)?.matches.length ?? 0) : 0;
}

// Highlight one hit (index -1 clears the highlight in this editor) and
// optionally bring it into view. The selection is moved too so the caret lands
// on the hit when the user clicks back into the text.
export function setActiveMatch(editor: AnyEditor, index: number, scroll: boolean): void {
  const ctx = stateOf(editor);
  if (!ctx) return;
  const s = findPluginKey.getState(ctx.state);
  let tr = ctx.state.tr.setMeta(findPluginKey, { active: index }).setMeta('addToHistory', false);
  if (scroll && s && index >= 0 && index < s.matches.length) {
    const m = s.matches[index];
    tr = tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
  }
  ctx.view.dispatch(tr);
}

// Build the replacement text carrying the marks of the text it replaces, so
// swapping a word inside bold/red text keeps that formatting.
function replacementNode(state: EditorState, m: FindMatch, text: string): PMNode {
  const marks = state.doc.resolve(Math.min(m.from + 1, m.to)).marks();
  return state.schema.text(text, marks);
}

export function replaceMatch(editor: AnyEditor, index: number, replacement: string): boolean {
  const ctx = stateOf(editor);
  if (!ctx) return false;
  const s = findPluginKey.getState(ctx.state);
  if (!s || index < 0 || index >= s.matches.length) return false;
  const m = s.matches[index];
  const tr = ctx.state.tr;
  if (replacement) tr.replaceWith(m.from, m.to, replacementNode(ctx.state, m, replacement));
  else tr.delete(m.from, m.to);
  ctx.view.dispatch(tr);
  return true;
}

// One transaction, applied back to front so each pending match keeps the
// positions it was found at.
export function replaceAllMatches(editor: AnyEditor, replacement: string): number {
  const ctx = stateOf(editor);
  if (!ctx) return 0;
  const s = findPluginKey.getState(ctx.state);
  if (!s || s.matches.length === 0) return 0;
  const tr = ctx.state.tr;
  for (let i = s.matches.length - 1; i >= 0; i -= 1) {
    const m = s.matches[i];
    if (replacement) tr.replaceWith(m.from, m.to, replacementNode(ctx.state, m, replacement));
    else tr.delete(m.from, m.to);
  }
  ctx.view.dispatch(tr);
  return s.matches.length;
}

// The editor's current selection as plain text — used to seed the find field
// the way macOS apps do when you hit Cmd+F with something selected.
export function selectedText(editor: AnyEditor): string {
  const ctx = stateOf(editor);
  if (!ctx) return '';
  const { from, to, empty } = ctx.state.selection;
  if (empty) return '';
  return ctx.state.doc.textBetween(from, to, ' ');
}
