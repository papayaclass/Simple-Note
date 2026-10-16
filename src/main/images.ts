import { promises as fs } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';

function mimeFromExt(p: string): string {
  switch (extname(p).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.bmp':
      return 'image/bmp';
    case '.avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

// Read an image file (path may be relative to the note dir) as a data URL, used
// to display file-path image blocks.
export async function readImageAsDataUrl(
  noteDir: string | null,
  src: string
): Promise<{ ok: boolean; dataUrl?: string }> {
  try {
    if (!isAbsolute(src) && !noteDir) return { ok: false };
    const abs = isAbsolute(src) ? src : resolve(noteDir!, src);
    const buf = await fs.readFile(abs);
    return { ok: true, dataUrl: `data:${mimeFromExt(abs)};base64,${buf.toString('base64')}` };
  } catch {
    return { ok: false };
  }
}
