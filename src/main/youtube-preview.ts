import { app } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export interface YouTubePreviewData {
  title: string;
  author: string;
  thumbnail: string;
  // Pre-formatted for display (e.g. "123 萬次觀看"); null when it can't be parsed.
  viewCount: string | null;
  // Raw numeric view count for sorting; null when it can't be parsed. Mirrors
  // viewCount (same source), kept separately so the renderer doesn't have to
  // parse "123 萬次觀看" back into a number.
  viewCountRaw: number | null;
  // Pre-formatted upload date/time in Taiwan time (e.g. "2025年11月21日 上午6:00");
  // null when the watch page doesn't expose it.
  publishDate: string | null;
}

interface CacheEntry {
  data: YouTubePreviewData;
  fetchedAt: number;
}

// Titles barely change; view counts only grow. 12h keeps the popup feeling
// "instant" on re-hover while staying reasonably current.
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry>();
let diskLoaded = false;

function cachePath(): string {
  return join(app.getPath('userData'), 'youtube-preview-cache.json');
}

async function loadDiskCache(): Promise<void> {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const text = await readFile(cachePath(), 'utf-8');
    const obj = JSON.parse(text) as Record<string, CacheEntry>;
    for (const [id, entry] of Object.entries(obj)) cache.set(id, entry);
  } catch {
    // No cache yet (first run / offline) — start empty.
  }
}

async function saveDiskCache(): Promise<void> {
  const obj: Record<string, CacheEntry> = {};
  for (const [id, entry] of cache) obj[id] = entry;
  const p = cachePath();
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, JSON.stringify(obj), 'utf-8');
  } catch {
    // Best-effort persistence; a failed write just means the next hover refetches.
  }
}

// Title + author come from the official, key-free oEmbed endpoint.
async function fetchOEmbed(videoId: string): Promise<{ title: string; author: string }> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`oEmbed ${res.status}`);
  const data = (await res.json()) as { title?: string; author_name?: string };
  return { title: data.title ?? '', author: data.author_name ?? '' };
}

// Neither view count nor upload date is exposed by oEmbed, so scrape both from
// the watch page's embedded JSON in a single request. This depends on YouTube's
// page shape; if it ever changes the affected field is null and the popup simply
// omits that line (no error shown).
async function fetchWatchPageData(
  videoId: string
): Promise<{ viewCount: string | null; viewCountRaw: number | null; publishDate: string | null }> {
  const empty = { viewCount: null, viewCountRaw: null, publishDate: null };
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      headers: {
        'Accept-Language': 'zh-TW,zh;q=0.9',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) return empty;
    const html = await res.text();

    const viewMatch = html.match(/"viewCount":"(\d+)"/);
    const viewCountRaw = viewMatch ? Number(viewMatch[1]) : null;
    const viewCount = viewCountRaw !== null ? formatViewCount(viewCountRaw) : null;

    // "uploadDate" in the player microformat carries a full ISO timestamp with
    // timezone (e.g. "2025-11-20T14:00:08-08:00") on current pages.
    const dateMatch = html.match(/"uploadDate":"([^"]+)"/);
    const publishDate = dateMatch ? formatPublishDate(dateMatch[1]) : null;

    return { viewCount, viewCountRaw, publishDate };
  } catch {
    return empty;
  }
}

function trimDecimal(v: number): string {
  // One decimal place, but drop a trailing ".0".
  return (Math.round(v * 10) / 10).toString();
}

function formatViewCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n >= 1e8) return `${trimDecimal(n / 1e8)} 億次觀看`;
  if (n >= 1e4) return `${trimDecimal(n / 1e4)} 萬次觀看`;
  return `${n.toLocaleString('en-US')} 次觀看`;
}

// YouTube's uploadDate is effectively a calendar date — the time component is an
// unreliable midnight placeholder — so we show the date only, rendered in Taiwan
// time. Not every video exposes it; callers treat null as "omit the date".
function formatPublishDate(raw: string): string | null {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d);
}

export async function getYouTubePreview(
  videoId: string
): Promise<{ ok: true; data: YouTubePreviewData } | { ok: false; reason: string }> {
  if (!/^[\w-]{11}$/.test(videoId)) return { ok: false, reason: '無效的影片 ID' };
  await loadDiskCache();

  const cached = cache.get(videoId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { ok: true, data: cached.data };
  }

  try {
    // Title comes from oEmbed; view count and upload date from the watch page —
    // independent fetches, so run them together.
    const [oembed, watch] = await Promise.all([
      fetchOEmbed(videoId),
      fetchWatchPageData(videoId),
    ]);
    const data: YouTubePreviewData = {
      title: oembed.title,
      author: oembed.author,
      thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      viewCount: watch.viewCount,
      viewCountRaw: watch.viewCountRaw,
      publishDate: watch.publishDate,
    };
    cache.set(videoId, { data, fetchedAt: Date.now() });
    void saveDiskCache();
    return { ok: true, data };
  } catch {
    // Offline or oEmbed failure: fall back to a stale cache entry if we have one.
    if (cached) return { ok: true, data: cached.data };
    return { ok: false, reason: '離線或無法取得影片資訊' };
  }
}
