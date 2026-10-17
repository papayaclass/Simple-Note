// Simple Note's own document format (`.snote`).
//
// Markdown is still a first-class format — files opened as `.md` keep being
// saved as Markdown — but it can't express red text, toggle lists or in-editor
// images. `.snote` stores the raw BlockNote block tree as JSON, so a note
// round-trips with every formatting feature intact.
export const SNOTE_EXT = '.snote';
export const SNOTE_FORMAT = 'simple-note';

export interface SnoteFile {
  format: typeof SNOTE_FORMAT;
  version: 2;
  blocks: unknown[];
}

// The two payloads a document can be written as. Which one lands on disk is
// decided by the target file's extension (see the main process).
export interface NoteContents {
  markdown: string;
  snote: string;
}

export function isSnotePath(path: string | null | undefined): boolean {
  return !!path && path.toLowerCase().endsWith(SNOTE_EXT);
}

// "我的筆記.md" → "我的筆記.snote" (any known note extension is swapped).
export function withSnoteExt(name: string): string {
  return `${name.replace(/\.(md|txt|snote)$/i, '')}${SNOTE_EXT}`;
}

export function withMarkdownExt(name: string): string {
  return `${name.replace(/\.(md|txt|snote)$/i, '')}.md`;
}

export function serializeSnote(data: SnoteFile): string {
  return JSON.stringify(data, null, 2);
}

// Returns null when the text isn't a Simple Note document (i.e. it's Markdown).
// Version 1 files stored three columns (`columns.left/middle/right`) from the
// removed two-column layout; their non-empty columns are joined in on-screen
// order so nothing written there is lost.
export function parseSnote(text: string): SnoteFile | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{')) return null;
  try {
    const data = JSON.parse(trimmed) as {
      format?: string;
      blocks?: unknown;
      columns?: { left?: unknown; middle?: unknown; right?: unknown };
    };
    if (data?.format !== SNOTE_FORMAT) return null;
    let blocks: unknown[];
    if (Array.isArray(data.blocks)) {
      blocks = data.blocks;
    } else {
      const cols = data.columns ?? {};
      const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
      const middle = list(cols.middle);
      const left = list(cols.left);
      const right = list(cols.right);
      blocks = [
        ...(isBlank(left) ? [] : left),
        ...middle,
        ...(isBlank(right) ? [] : right),
      ];
    }
    return { format: SNOTE_FORMAT, version: 2, blocks };
  } catch {
    return null;
  }
}

// A column left at BlockNote's default: only empty paragraphs.
function isBlank(blocks: unknown[]): boolean {
  return blocks.every((b) => {
    const blk = b as { type?: string; content?: unknown; children?: unknown[] };
    const empty =
      blk.content == null ||
      (Array.isArray(blk.content) && blk.content.length === 0) ||
      blk.content === '';
    return blk.type === 'paragraph' && empty && !(blk.children && blk.children.length);
  });
}

// Split a leading YAML front matter block (`---` … `---`) off a Markdown file.
// The editor would parse it as a thematic break plus a setext heading and save
// it back as `***` / `------`, which breaks files whose header is read by other
// tools (e.g. Claude Code skills' SKILL.md). The raw text is kept aside and
// written back verbatim on save, so it is never shown in or touched by the editor.
export function splitFrontMatter(text: string): { frontMatter: string; body: string } {
  // The first line must be a `key:` pair, so a note that merely opens with a
  // divider isn't mistaken for front matter and hidden from the editor.
  const match =
    /^﻿?---[ \t]*\r?\n[A-Za-z_][\w-]*:[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontMatter: '', body: text };
  return { frontMatter: match[0], body: text.slice(match[0].length) };
}

// ---------------------------------------------------------------------------
// Detecting formatting Markdown can't carry.
// ---------------------------------------------------------------------------

interface LooseBlock {
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown;
}

function addStyleFeatures(styles: Record<string, unknown> | undefined, out: Set<string>): void {
  if (!styles) return;
  if (styles.redText) out.add('紅色文字');
  if (styles.underline) out.add('底線');
  if (styles.textColor && styles.textColor !== 'default') out.add('文字顏色');
  if (styles.backgroundColor && styles.backgroundColor !== 'default') out.add('文字底色');
}

function walkContent(content: unknown, out: Set<string>): void {
  if (!Array.isArray(content)) return;
  for (const span of content as Array<Record<string, unknown>>) {
    if (!span || typeof span !== 'object') continue;
    addStyleFeatures(span.styles as Record<string, unknown> | undefined, out);
    // Nested inline content (e.g. links carry their own spans).
    if (Array.isArray(span.content)) walkContent(span.content, out);
  }
}

function walkBlocks(blocks: unknown, out: Set<string>): void {
  if (!Array.isArray(blocks)) return;
  for (const raw of blocks as LooseBlock[]) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.type === 'toggle') out.add('折疊清單');
    if (raw.type === 'image') out.add('圖片');
    const props = raw.props ?? {};
    if (props.textColor && props.textColor !== 'default') out.add('文字顏色');
    if (props.backgroundColor && props.backgroundColor !== 'default') out.add('文字底色');
    walkContent(raw.content, out);
    walkBlocks(raw.children, out);
  }
}

// Human-readable list of the features in these blocks that a Markdown save
// would silently discard. Empty ⇒ the document survives Markdown untouched.
export function lossyFeatures(blocks: unknown): string[] {
  const out = new Set<string>();
  walkBlocks(blocks, out);
  return [...out];
}
