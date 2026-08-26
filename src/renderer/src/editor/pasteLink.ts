import { Plugin, PluginKey } from 'prosemirror-state';
import { createBlockNoteExtension } from '@blocknote/core';

const KEY = new PluginKey('simple-note-paste-link');

/**
 * Rewrite a pasted link so the visible text is the real URL rather than the
 * label the source app supplied. Notion (and most web apps) put
 * `<a href="https://…">Note Page</a>` on the clipboard, which would otherwise
 * show up here as just "Note Page".
 *
 * Only applied when the paste is *nothing but* links (one or more anchors plus
 * whitespace) — copying a link, a page mention, or a list of them. A paste that
 * also carries prose keeps its inline labels, so copying an article doesn't
 * blow every linked word up into a full URL.
 */
function rewriteLinkLabels(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  if (anchors.length === 0) return html;

  // Anything in the paste that isn't inside an anchor? Then it's prose — leave it.
  const anchorText = anchors.map((a) => a.textContent ?? '').join('');
  const allText = doc.body.textContent ?? '';
  if (allText.replace(/\s+/g, '') !== anchorText.replace(/\s+/g, '')) return html;

  // Images / embeds inside an anchor must survive, so only touch text-only ones.
  if (anchors.some((a) => a.querySelector('img, picture, svg, video'))) return html;

  let changed = false;
  for (const a of anchors) {
    // `href` on the parsed anchor is already absolute-resolved; read the raw
    // attribute so the URL is shown exactly as it was copied.
    const href = a.getAttribute('href')?.trim();
    if (!href || !/^https?:\/\//i.test(href)) continue;
    if ((a.textContent ?? '').trim() === href) continue;
    a.textContent = href;
    changed = true;
  }
  return changed ? doc.body.innerHTML : html;
}

export function createPasteLinkExtension() {
  return createBlockNoteExtension({
    key: 'simple-note-paste-link',
    plugins: [
      new Plugin({
        key: KEY,
        props: {
          transformPastedHTML(html: string) {
            // Copies from inside the editor carry ProseMirror's own slice
            // marker; those already say what the user wants them to say.
            if (html.includes('data-pm-slice')) return html;
            return rewriteLinkLabels(html);
          },
        },
      }),
    ],
  });
}
