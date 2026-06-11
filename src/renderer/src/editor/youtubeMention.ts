import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { createBlockNoteExtension } from '@blocknote/core';
import { parseYouTubeId } from './youtubePreview';

const KEY = new PluginKey('youtube-mention');

// Shared preview cache so the synchronous decoration pass has immediate access
// to channel names and so the paste→title conversion reuses the same fetch.
// One window.api.youtube.preview call yields both title and channel.
interface PreviewEntry {
  title?: string;
  channel?: string;
  viewCount?: string | null;
  pending?: Promise<void>;
  failed?: boolean;
}
const previewCache = new Map<string, PreviewEntry>();

function ensurePreview(id: string, onLoaded: () => void): void {
  const cached = previewCache.get(id);
  if (cached && (cached.pending || cached.title || cached.failed)) return;
  const pending = window.api.youtube
    .preview(id)
    .then((res) => {
      if (res.ok) {
        previewCache.set(id, {
          title: res.data.title,
          channel: res.data.author,
          viewCount: res.data.viewCount,
        });
      } else {
        // Offline / unavailable: leave the raw URL untouched, don't spam retries.
        previewCache.set(id, { failed: true });
      }
      onLoaded();
    })
    .catch(() => {
      previewCache.set(id, { failed: true });
      onLoaded();
    });
  previewCache.set(id, { pending });
}

const YT_LOGO_SVG =
  '<svg width="17" height="17" viewBox="0 0 28 28" aria-hidden="true">' +
  '<path fill="#FF0000" d="M27 8.4a3.5 3.5 0 0 0-2.46-2.48C22.4 5.34 14 5.34 14 5.34s-8.4 0-10.54.58' +
  'A3.5 3.5 0 0 0 1 8.4 36.6 36.6 0 0 0 .42 14 36.6 36.6 0 0 0 1 19.6a3.5 3.5 0 0 0 2.46 2.48' +
  'C5.6 22.66 14 22.66 14 22.66s8.4 0 10.54-.58A3.5 3.5 0 0 0 27 19.6 36.6 36.6 0 0 0 27.58 14' +
  'A36.6 36.6 0 0 0 27 8.4Z"/>' +
  '<path fill="#fff" d="M11.2 18.2 18.4 14l-7.2-4.2v8.4Z"/></svg>';

function buildMentionEl(channel: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'sn-yt-mention';
  wrap.contentEditable = 'false';
  const icon = document.createElement('span');
  icon.className = 'sn-yt-mention-icon';
  icon.innerHTML = YT_LOGO_SVG;
  wrap.appendChild(icon);
  if (channel) {
    const ch = document.createElement('span');
    ch.className = 'sn-yt-mention-channel';
    ch.textContent = channel;
    wrap.appendChild(ch);
  }
  return wrap;
}

function buildViewsEl(viewCount: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'sn-yt-views';
  span.contentEditable = 'false';
  span.textContent = `(${viewCount})`;
  return span;
}

// Pull the YouTube link href off a text node, if it carries one.
function youTubeHrefOf(node: any): string | null {
  if (!node.isText || !node.text) return null;
  const link = node.marks.find((m: any) => m.type.name === 'link');
  const href = link?.attrs?.href as string | undefined;
  if (!href || !parseYouTubeId(href)) return null;
  return href;
}

export function createYouTubeMentionPlugin(): Plugin {
  let view: any = null;

  const redrawDecorations = (): void => {
    if (view) view.dispatch(view.state.tr.setMeta(KEY, { redraw: true }));
  };

  // Decoration pass: a pure read of the cache. The icon + channel widget is only
  // emitted once the channel is known, so it appears together with the title
  // (no lone-icon flash on the raw URL). Fetching is driven by processLinks().
  function recompute(doc: any): DecorationSet {
    const decos: Decoration[] = [];
    doc.descendants((node: any, pos: number) => {
      if (!node.isTextblock) return true;
      // Collapse each contiguous YouTube link into one run so the channel widget
      // sits before its start and the view-count widget after its end.
      let run: { href: string; start: number; end: number } | null = null;
      const runs: Array<{ href: string; start: number; end: number }> = [];
      node.forEach((child: any, offset: number) => {
        const href = youTubeHrefOf(child);
        const start = pos + 1 + offset;
        const end = start + child.nodeSize;
        if (href && run && run.href === href) {
          run.end = end;
        } else {
          if (run) runs.push(run);
          run = href ? { href, start, end } : null;
        }
      });
      if (run) runs.push(run);

      for (const r of runs) {
        const id = parseYouTubeId(r.href)!;
        const entry = previewCache.get(id);
        const channel = entry?.channel;
        if (channel) {
          decos.push(
            Decoration.widget(r.start, () => buildMentionEl(channel), {
              side: -1,
              key: `yt:${id}:${channel}`,
            })
          );
        }
        const viewCount = entry?.viewCount;
        if (viewCount) {
          decos.push(
            Decoration.widget(r.end, () => buildViewsEl(viewCount), {
              side: 1,
              key: `ytv:${id}:${viewCount}`,
            })
          );
        }
      }
      return false;
    });
    return DecorationSet.create(doc, decos);
  }

  // Single doc scan that (a) kicks off any missing preview fetches and (b) swaps
  // YouTube links whose visible text is still the raw URL for their title.
  // Replacements run back-to-front so earlier positions stay valid as we edit.
  function processLinks(): void {
    if (!view) return;
    const jobs: Array<{ from: number; to: number; marks: any; title: string }> = [];
    view.state.doc.descendants((node: any, pos: number) => {
      const href = youTubeHrefOf(node);
      if (!href) return;
      const id = parseYouTubeId(href)!;
      const entry = previewCache.get(id);
      if (!entry || (!entry.title && !entry.failed && !entry.pending)) {
        ensurePreview(id, onLoaded);
      }
      // Convert only when the text is still the raw URL and we have a title.
      if (node.text === href && entry?.title) {
        jobs.push({ from: pos, to: pos + node.nodeSize, marks: node.marks, title: entry.title });
      }
    });
    if (jobs.length === 0) return;
    let tr = view.state.tr;
    for (const job of jobs.sort((a, b) => b.from - a.from)) {
      tr = tr.replaceWith(job.from, job.to, view.state.schema.text(job.title, job.marks));
    }
    view.dispatch(tr);
  }

  let scheduled = false;
  function requestProcess(): void {
    if (scheduled) return;
    scheduled = true;
    // Defer so we never dispatch inside ProseMirror's update cycle.
    setTimeout(() => {
      scheduled = false;
      processLinks();
    }, 0);
  }

  function onLoaded(): void {
    requestProcess(); // convert raw URLs once their title arrives
    redrawDecorations(); // reveal the channel widget for already-titled links
  }

  return new Plugin({
    key: KEY,
    state: {
      init: (_c, state) => recompute(state.doc),
      apply: (tr, value, _o, newState) => {
        const meta = tr.getMeta(KEY);
        if (tr.docChanged || meta) return recompute(newState.doc);
        return value;
      },
    },
    view(v) {
      view = v;
      requestProcess();
      return {
        update(updated: any, prev: any) {
          // React only to real document changes; meta-only redraws must not
          // re-trigger the scan, or they'd loop.
          if (updated.state.doc !== prev.doc) requestProcess();
        },
        destroy() {
          view = null;
        },
      };
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

export function createYouTubeMentionExtension() {
  return createBlockNoteExtension({
    key: 'simple-note-youtube',
    plugins: [createYouTubeMentionPlugin()],
  });
}
