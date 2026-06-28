import { Link } from '@tiptap/extension-link';
import { DEFAULT_LINK_PROTOCOL, VALID_LINK_PROTOCOLS } from '@blocknote/core';

// linkifyjs registers custom protocols globally and `Link.onDestroy` resets
// them, so (mirroring BlockNote's own guard) only the first editor instance
// should register the protocol list. Two-column mode creates two editors.
let linkifyInitialized = false;

/**
 * A drop-in replacement for BlockNote's default `link` Tiptap extension,
 * injected via `_tiptapOptions.extensions` (keyed by the mark name "link", it
 * overrides the built-in one).
 *
 * The only behavioural change vs. BlockNote's default is `shouldAutoLink`:
 * we only auto-link text the user typed *with* an explicit http(s) scheme.
 * Without this, linkifyjs turns bare filenames like `MEMORY.md`, `App.tsx`,
 * or `store.ts` into links while typing, because `.md`, `.tsx`, `.ts`, … are
 * valid country-code TLDs. Manual links and pasted URLs are unaffected.
 */
export function createLinkExtension() {
  const ext = Link.extend({ inclusive: false }).configure({
    defaultProtocol: DEFAULT_LINK_PROTOCOL,
    protocols: linkifyInitialized ? [] : VALID_LINK_PROTOCOLS,
    shouldAutoLink: (url: string) => /^https?:\/\//i.test(url),
  });
  linkifyInitialized = true;
  return ext;
}

// File extensions that linkifyjs treats as valid TLDs (so a bare `CLAUDE.md`
// becomes a link), but which in a notes context are virtually always filenames,
// not websites. Mainstream web TLDs that double as extensions (.io, .ai, .co,
// .dev, .app, .tv, .me, …) are deliberately omitted so real links keep working.
const FILENAME_EXTENSIONS = [
  'md', 'markdown', 'mdx', 'txt', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'json5', 'css', 'scss', 'sass', 'less', 'html', 'htm', 'xml',
  'yml', 'yaml', 'toml', 'ini', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'sh', 'bash', 'zsh', 'fish',
  'sql', 'php', 'lua', 'dart', 'vue', 'svelte', 'astro', 'csv', 'tsv',
  'lock', 'log', 'conf', 'cfg', 'zip', 'tar', 'gz',
];
const FILENAME_EXT_RE = new RegExp(`\\.(${FILENAME_EXTENSIONS.join('|')})$`, 'i');
// `[label](scheme://host)` — the negative lookbehind skips image syntax `![…]`.
const MD_LINK_RE = /(?<!!)\[([^\]\n]+?)\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * Unwrap "bare filename" autolinks saved in older notes — e.g. turn
 * `[CLAUDE.md](http://CLAUDE.md)` back into plain `CLAUDE.md`. linkifyjs used to
 * autolink such filenames (many extensions like `.md`, `.py`, `.sh` are also
 * valid TLDs) before that was disabled; the marks were then persisted into the
 * saved Markdown. Run on load so those files render as plain text again. Only
 * links whose URL is exactly `scheme://<label>` and whose label looks like a
 * filename are touched — real URLs and deliberately-labelled links stay intact.
 */
export function stripFilenameAutolinks(markdown: string): string {
  return markdown.replace(MD_LINK_RE, (match, label: string, url: string) => {
    const bare = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    return bare === label && FILENAME_EXT_RE.test(label) ? label : match;
  });
}

/**
 * Collapse stray `****` runs. `editor.blocksToMarkdownLossy` serialises each
 * inline run of a styled span separately, so a bold span that contains a link
 * (or otherwise spans several runs) is saved as `**a****b**` — the touching
 * `**`-close / `**`-open then degrades into literal asterisks on the next load.
 * Four adjacent asterisks never carry meaning in Markdown, so dropping them
 * stitches the bold span back together (`**a****b**` → `**ab**`).
 */
export function collapseSplitBoldMarkers(markdown: string): string {
  return markdown.replace(/\*{4}/g, '');
}

/** Clean up Markdown artifacts (filename autolinks, split bold markers) on load. */
export function sanitizeLoadedMarkdown(markdown: string): string {
  return collapseSplitBoldMarkers(stripFilenameAutolinks(markdown));
}
