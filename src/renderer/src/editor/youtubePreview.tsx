import { useEffect, useRef, useState } from 'react';

/**
 * Extract an 11-char YouTube video id from a URL, or null if it isn't a
 * recognisable YouTube link. Handles youtu.be, /watch?v=, /shorts, /embed, /v.
 */
export function parseYouTubeId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const isId = (v: string | null | undefined): v is string => !!v && /^[\w-]{11}$/.test(v);

  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return isId(id) ? id : null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') {
      const v = url.searchParams.get('v');
      return isId(v) ? v : null;
    }
    const m = url.pathname.match(/^\/(?:shorts|embed|v)\/([\w-]{11})/);
    if (m && isId(m[1])) return m[1];
  }
  return null;
}

interface PreviewData {
  title: string;
  author: string;
  thumbnail: string;
  viewCount: string | null;
}

interface ViewState {
  id: string;
  rect: DOMRect;
  loading: boolean;
  error: boolean;
  data: PreviewData | null;
}

const SHOW_DELAY_MS = 400;
const HIDE_DELAY_MS = 200;
const CARD_W = 320;
// Rough height used only to decide above/below flip; the real card sizes itself.
const CARD_H = 268;
const GAP = 8;

/**
 * Watches the document for the pointer hovering a YouTube link and shows a
 * floating preview card (thumbnail + title + author + view count). Mount once
 * near the app root; the card renders as a fixed-position overlay.
 */
export function YouTubePreviewHover(): JSX.Element | null {
  const [view, setView] = useState<ViewState | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const showTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const activeId = useRef<string | null>(null);
  const pendingId = useRef<string | null>(null);
  const reqSeq = useRef(0);

  useEffect(() => {
    const clearShow = (): void => {
      if (showTimer.current !== null) {
        window.clearTimeout(showTimer.current);
        showTimer.current = null;
      }
    };
    const clearHide = (): void => {
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };

    const close = (): void => {
      clearShow();
      clearHide();
      activeId.current = null;
      pendingId.current = null;
      reqSeq.current++;
      setView(null);
    };

    const scheduleHide = (): void => {
      if (activeId.current === null && pendingId.current === null) return;
      if (hideTimer.current !== null) return;
      hideTimer.current = window.setTimeout(close, HIDE_DELAY_MS);
    };

    const openFor = (id: string, anchor: HTMLAnchorElement): void => {
      pendingId.current = null;
      activeId.current = id;
      const rect = anchor.getBoundingClientRect();
      const seq = ++reqSeq.current;
      // Thumbnail is derivable from the id, so the card appears immediately;
      // only title/author/views wait on the async response.
      setView({
        id,
        rect,
        loading: true,
        error: false,
        data: { title: '', author: '', thumbnail: thumbUrl(id), viewCount: null },
      });
      window.api.youtube
        .preview(id)
        .then((res) => {
          if (reqSeq.current !== seq) return; // superseded by a newer hover
          setView((v) =>
            v && v.id === id
              ? res.ok
                ? { ...v, loading: false, error: false, data: res.data }
                : { ...v, loading: false, error: true }
              : v
          );
        })
        .catch(() => {
          if (reqSeq.current !== seq) return;
          setView((v) => (v && v.id === id ? { ...v, loading: false, error: true } : v));
        });
    };

    const onMouseOver = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;

      // Over the card itself: keep it open.
      if (cardRef.current && cardRef.current.contains(target)) {
        clearHide();
        return;
      }

      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      const id = anchor ? parseYouTubeId(anchor.href) : null;

      if (anchor && id) {
        clearHide();
        if (activeId.current === id) return; // already shown for this link
        if (pendingId.current !== id) {
          clearShow();
          pendingId.current = id;
          showTimer.current = window.setTimeout(() => openFor(id, anchor), SHOW_DELAY_MS);
        }
        return;
      }

      // Over anything that isn't the active link or the card: dismiss.
      clearShow();
      pendingId.current = null;
      scheduleHide();
    };

    const onDocLeave = (): void => {
      clearShow();
      pendingId.current = null;
      scheduleHide();
    };

    document.addEventListener('mouseover', onMouseOver, true);
    document.addEventListener('mouseleave', onDocLeave);
    return () => {
      document.removeEventListener('mouseover', onMouseOver, true);
      document.removeEventListener('mouseleave', onDocLeave);
      clearShow();
      clearHide();
    };
  }, []);

  if (!view) return null;

  const watchUrl = `https://www.youtube.com/watch?v=${view.id}`;
  const data = view.data;
  const pos = computePosition(view.rect);

  return (
    <div
      className="sn-yt-card"
      ref={cardRef}
      style={{ left: pos.left, top: pos.top }}
      // Clicks inside the card shouldn't reach the shell's "focus last block".
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="sn-yt-thumb"
        title="在瀏覽器開啟"
        onClick={() => window.open(watchUrl)}
      >
        {data?.thumbnail && <img src={data.thumbnail} alt="" draggable={false} />}
        <span className="sn-yt-play" aria-hidden>
          ▶
        </span>
      </button>
      <div className="sn-yt-body">
        {view.error ? (
          <div className="sn-yt-status">無法取得影片資訊</div>
        ) : view.loading ? (
          <div className="sn-yt-status">載入中…</div>
        ) : (
          <>
            <div className="sn-yt-title">{data?.title}</div>
            <div className="sn-yt-meta">
              {data?.author}
              {data?.viewCount ? ` · ${data.viewCount}` : ''}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function thumbUrl(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

// Place the card below the link, flipping above when it would overflow the
// viewport bottom, and clamp horizontally so it never spills off-screen.
function computePosition(rect: DOMRect): { left: number; top: number } {
  let left = rect.left;
  left = Math.min(left, window.innerWidth - CARD_W - GAP);
  left = Math.max(GAP, left);

  let top = rect.bottom + GAP;
  const overflowsBottom = top + CARD_H > window.innerHeight;
  const fitsAbove = rect.top - GAP - CARD_H > 0;
  if (overflowsBottom && fitsAbove) top = rect.top - GAP - CARD_H;
  return { left, top };
}
