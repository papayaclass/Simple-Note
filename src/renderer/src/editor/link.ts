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
