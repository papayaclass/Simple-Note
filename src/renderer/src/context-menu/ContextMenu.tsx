import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  halfToFullPunctuation,
  simplifiedToTraditional,
  toPinyin,
  toBoshiamy,
  BoshiamyEntry,
  LOREM_IPSUM,
  stripCitationMarkers,
  wordCount,
} from './transforms';
import { useStore } from '../store';
import { PinyinModal } from './PinyinModal';
import { BoshiamyModal } from './BoshiamyModal';
import { MENU_COMMANDS, reconcileMenuCommands, isDivider } from './commands';
import { parseYouTubeId } from '../editor/youtubePreview';
import { getCachedViewCount } from '../editor/youtubeMention';
import { removeParagraphBreaks } from './removeParagraphBreaks';

type MenuItem = { divider: true } | { label: string; disabled: boolean; onClick: () => void };

const TRANSLATION_PROMPT = `你是一位中英翻譯的語言專家，請針對我提供的【內容】進行中英互譯，並遵守以下要點。
- 如果我提供的內容為「繁體中文」，請翻譯成英文。
- 如果我提供的內容為「英文」，請翻譯成繁體中文。
- 執行「英翻中」時，請在遵守原意的前提下讓內容通俗易懂，並符合台灣繁體中文的表達習慣。
- 段落中的軟體指令、工具、參數、介面等名稱請維持英文，不要翻譯成中文。
- 英文術語或數字的兩側請加上空白符號。例：撰寫 Python 腳本。
- 如果我提供的內容中包含了不相關的廣告、UI 文字、促銷訊息等，請直接忽略這些與主題無關的文字。
- 只輸出翻譯結果，不要包含任何其它的說明。`;

// Drop leading/trailing dividers and collapse runs of adjacent dividers into one
// (hidden commands between two dividers would otherwise leave them adjacent).
function collapseDividers(items: MenuItem[]): MenuItem[] {
  const result: MenuItem[] = [];
  for (const item of items) {
    if ('divider' in item) {
      if (result.length === 0 || 'divider' in result[result.length - 1]) continue;
    }
    result.push(item);
  }
  while (result.length > 0 && 'divider' in result[result.length - 1]) result.pop();
  return result;
}

// The first YouTube video id linked anywhere in a top-level block, or null when
// the block carries no YouTube link. Used to decide which blocks participate in
// the "sort by views" command and to look up their view counts.
function blockYouTubeId(block: any): string | null {
  const content = block?.content;
  if (!Array.isArray(content)) return null;
  for (const inline of content) {
    if (inline?.type === 'link' && typeof inline.href === 'string') {
      const id = parseYouTubeId(inline.href);
      if (id) return id;
    }
  }
  return null;
}

interface Props {
  editor: any;
  containerRef?: React.RefObject<HTMLElement | null>;
}

interface MenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

interface PinyinState {
  original: string;
  pinyin: string;
}

interface BoshiamyState {
  entries: BoshiamyEntry[];
}

export function ContextMenu({ editor, containerRef }: Props): JSX.Element | null {
  const [menu, setMenu] = useState<MenuState | null>(null);
  // Position the menu is actually drawn at, clamped to stay inside the viewport
  // (the raw click point can sit too close to the right/bottom edge for a long
  // menu). Starts at the click point, then a layout effect nudges it on-screen.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [translationStatus, setTranslationStatus] = useState<string | null>(null);
  const [pinyinState, setPinyinState] = useState<PinyinState | null>(null);
  const [boshiamyState, setBoshiamyState] = useState<BoshiamyState | null>(null);
  const setWordCount = useStore((s) => s.setWordCountPopover);
  const menuCommands = useStore((s) => s.preferences.menuCommands);

  useEffect(() => {
    function onContext(e: MouseEvent) {
      // Scope to this editor's own container so that in two-column mode the
      // right-click menu only fires for the column the click landed in.
      const root = containerRef?.current ?? document.querySelector('.bn-container');
      if (!root || !root.contains(e.target as Node)) return;
      e.preventDefault();
      const sel = window.getSelection();
      const hasSelection = !!sel && !sel.isCollapsed && sel.toString().length > 0;
      setMenu({ x: e.clientX, y: e.clientY, hasSelection });
      setPos({ left: e.clientX, top: e.clientY });
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

  const close = () => setMenu(null);

  // Once the menu is laid out, clamp it so it never spills past the viewport
  // edges. If it's taller than the screen, pin it to the top margin and let the
  // CSS max-height + overflow scroll handle the rest.
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const margin = 8;
    const rect = menuRef.current.getBoundingClientRect();
    let left = menu.x;
    let top = menu.y;
    if (left + rect.width + margin > window.innerWidth) {
      left = Math.max(margin, window.innerWidth - rect.width - margin);
    }
    if (top + rect.height + margin > window.innerHeight) {
      top = Math.max(margin, window.innerHeight - rect.height - margin);
    }
    if (left !== pos?.left || top !== pos?.top) setPos({ left, top });
  }, [menu]); // eslint-disable-line react-hooks/exhaustive-deps

  const runTranslation = async () => {
    const { from, to } = editor._tiptapEditor.state.selection;
    const selText = editor.getSelectedText?.() ?? window.getSelection()?.toString() ?? '';
    if (!selText) return;
    close();
    setTranslationStatus('AI 翻譯中…');
    const res = await window.api.ai.run(`${TRANSLATION_PROMPT}\n\n${selText}`);
    if (!res.ok) {
      setTranslationStatus(res.reason);
      window.setTimeout(() => setTranslationStatus(null), 4000);
      return;
    }

    const tipTap = editor._tiptapEditor;
    const mode = useStore.getState().preferences.translationResultMode;
    if (mode === 'replaceSelection') {
      tipTap.chain().focus().insertContentAt({ from, to }, res.content).run();
    } else {
      tipTap.chain().focus().insertContentAt(to, `\n\n${res.content}`).run();
    }
    setTranslationStatus(null);
  };

  // Apply a text→text transform to the selection while preserving block
  // structure and inline marks. We can't round-trip through getSelectedText() +
  // insertContent(): textBetween() joins blocks with no separator, so the
  // re-inserted string collapses every selected paragraph into one. Instead we
  // walk the ProseMirror text nodes inside the selection and rewrite each in
  // place (last→first so earlier positions stay valid), leaving paragraph
  // boundaries and marks untouched.
  const transformSelection = (fn: (text: string) => string) => {
    const tt = editor._tiptapEditor;
    const { state, view } = tt;
    const { from, to, empty } = state.selection;
    if (empty) return;
    const edits: { start: number; end: number; text: string; marks: unknown[] }[] = [];
    state.doc.nodesBetween(from, to, (node: any, pos: number) => {
      if (!node.isText) return;
      const start = Math.max(pos, from);
      const end = Math.min(pos + node.nodeSize, to);
      if (start >= end) return;
      const original = node.text.slice(start - pos, end - pos);
      const replaced = fn(original);
      if (replaced !== original) edits.push({ start, end, text: replaced, marks: node.marks });
    });
    if (edits.length === 0) return;
    const tr = state.tr;
    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i];
      // schema.text() rejects empty strings, so delete instead when a transform
      // produces no output (none of our current transforms do, but be safe).
      if (e.text) tr.replaceWith(e.start, e.end, state.schema.text(e.text, e.marks as any));
      else tr.delete(e.start, e.end);
    }
    view.dispatch(tr);
  };

  const clearFormatting = () => {
    const tipTap = editor._tiptapEditor;
    tipTap.chain().focus().unsetAllMarks().run();
  };

  const stripLinksAndCitationMarkers = () => {
    const tipTap = editor._tiptapEditor;
    const { state, view } = tipTap;
    const linkMark = state.schema.marks.link;
    let tr = state.tr;
    if (linkMark) tr = tr.removeMark(0, state.doc.content.size, linkMark);

    const edits: { start: number; end: number; text: string; marks: unknown[] }[] = [];
    state.doc.descendants((node: any, pos: number) => {
      if (!node.isText || typeof node.text !== 'string') return;
      const replaced = stripCitationMarkers(node.text);
      if (replaced === node.text) return;
      const marks = linkMark
        ? node.marks.filter((mark: any) => mark.type !== linkMark)
        : node.marks;
      edits.push({ start: pos, end: pos + node.nodeSize, text: replaced, marks });
    });

    for (let i = edits.length - 1; i >= 0; i--) {
      const e = edits[i];
      if (e.text) tr = tr.replaceWith(e.start, e.end, state.schema.text(e.text, e.marks as any));
      else tr = tr.delete(e.start, e.end);
    }
    if (tr.docChanged) view.dispatch(tr.scrollIntoView());
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

  // Reorder every top-level block that links a YouTube video by view count
  // (most-viewed first), leaving all other blocks where they are. The YouTube
  // blocks are sorted among the slots they already occupy, so interleaved
  // headings/text/images don't move. Blocks whose view count isn't known yet
  // (still loading / offline / unavailable) sink to the bottom of that group,
  // keeping their relative order. One replaceBlocks call = one undo step.
  const sortYouTubeByViews = () => {
    const blocks = editor.document as any[];
    const slots: number[] = [];
    const ytBlocks: Array<{ block: any; views: number | null; order: number }> = [];
    blocks.forEach((block, i) => {
      const id = blockYouTubeId(block);
      if (!id) return;
      slots.push(i);
      ytBlocks.push({ block, views: getCachedViewCount(id), order: slots.length - 1 });
    });
    if (ytBlocks.length < 2) return; // nothing to reorder

    const sorted = [...ytBlocks].sort((a, b) => {
      if (a.views === b.views) return a.order - b.order; // stable
      if (a.views === null) return 1; // unknown counts sink to the bottom
      if (b.views === null) return -1;
      return b.views - a.views; // most-viewed first
    });

    const next = blocks.slice();
    slots.forEach((slot, k) => {
      next[slot] = sorted[k].block;
    });
    (editor.replaceBlocks as (remove: unknown, insert: unknown) => void)(
      blocks.map((b) => b.id),
      next
    );
  };

  const doWordCount = () => {
    const text = window.getSelection()?.toString() ?? '';
    const wc = wordCount(text);
    setWordCount({ count: wc.words, chars: wc.chars, charsNoSpace: wc.charsNoSpace, chinese: wc.chinese });
  };

  const doPinyin = () => {
    const text = (window.getSelection()?.toString() ?? '').trim();
    if (!text) return;
    setPinyinState({ original: text, pinyin: toPinyin(text) });
    close();
  };

  const doBoshiamy = () => {
    const text = (window.getSelection()?.toString() ?? '').trim();
    if (!text) return;
    const entries = toBoshiamy(text);
    if (entries.length === 0) return;
    setBoshiamyState({ entries });
    close();
  };

  // Open a web search for the selected text. window.open is intercepted by the
  // main process's setWindowOpenHandler, which routes it to the system browser
  // via shell.openExternal (see src/main/index.ts).
  const searchSelection = (buildUrl: (query: string) => string) => {
    const text = (window.getSelection()?.toString() ?? '').trim();
    if (!text) return;
    window.open(buildUrl(encodeURIComponent(text)), '_blank');
  };

  // Per-command click handlers, keyed to match the registry in commands.ts.
  const handlers: Record<string, () => void> = {
    s2t: () => {
      transformSelection(simplifiedToTraditional);
      close();
    },
    half2full: () => {
      transformSelection(halfToFullPunctuation);
      close();
    },
    clearFormat: () => {
      clearFormatting();
      close();
    },
    stripLinksAndCitations: () => {
      stripLinksAndCitationMarkers();
      close();
    },
    mergeBreaks: () => {
      mergeParagraphBreaks();
      close();
    },
    removeParagraphBreaks: () => {
      removeParagraphBreaks(editor);
      close();
    },
    lorem: () => {
      insertLoremIpsum();
      close();
    },
    sortYoutube: () => {
      sortYouTubeByViews();
      close();
    },
    wordCount: () => {
      doWordCount();
      close();
    },
    pinyin: doPinyin,
    boshiamy: doBoshiamy,
    googleSearch: () => {
      searchSelection((q) => `https://www.google.com/search?q=${q}`);
      close();
    },
    googleMaps: () => {
      searchSelection((q) => `https://www.google.com/maps/search/?api=1&query=${q}`);
      close();
    },
    youtube: () => {
      searchSelection((q) => `https://www.youtube.com/results?search_query=${q}`);
      close();
    },
    cambridge: () => {
      searchSelection(
        (q) => `https://dictionary.cambridge.org/search/english-chinese-traditional/direct/?q=${q}`
      );
      close();
    },
    translate: () => {
      void runTranslation();
    },
  };

  const labelByKey = new Map(MENU_COMMANDS.map((c) => [c.key, c]));

  // Built-in commands rendered in the user-defined order, hidden ones filtered
  // out, and user-inserted dividers kept in place.
  const builtInItems: MenuItem[] = [];
  for (const c of reconcileMenuCommands(menuCommands)) {
    if (isDivider(c)) {
      builtInItems.push({ divider: true });
    } else if (c.visible !== false) {
      const def = labelByKey.get(c.key)!;
      builtInItems.push({
        label: c.label?.trim() ? c.label : def.label,
        disabled: def.requiresSelection && !menu?.hasSelection,
        onClick: handlers[c.key],
      });
    }
  }

  const items = collapseDividers(builtInItems);

  return (
    <>
      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ position: 'fixed', top: pos?.top ?? menu.y, left: pos?.left ?? menu.x }}
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
      )}
      {translationStatus && (
        <div className="translation-status-toast" role="status">
          {translationStatus}
        </div>
      )}
      {pinyinState && (
        <PinyinModal
          original={pinyinState.original}
          pinyin={pinyinState.pinyin}
          onClose={() => setPinyinState(null)}
        />
      )}
      {boshiamyState && (
        <BoshiamyModal entries={boshiamyState.entries} onClose={() => setBoshiamyState(null)} />
      )}
    </>
  );
}
