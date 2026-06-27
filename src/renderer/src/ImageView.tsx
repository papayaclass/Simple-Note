import { useEffect, useState } from 'react';
import { useStore } from './store';

// Read-only image preview surface for an `image`-kind tab. Loads the file at the
// tab's filePath via IPC (bytes → data URL) so it works regardless of the
// renderer's origin. Clicking opens the shared lightbox for a zoomed view.
export function ImageView({ tabId, active }: { tabId: string; active: boolean }): JSX.Element {
  const filePath = useStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    if (!filePath) {
      setState('error');
      setSrc(null);
      return;
    }
    setState('loading');
    void window.api.vault.readImageAsDataUrl(null, filePath).then((r) => {
      if (cancelled) return;
      if (r.ok && r.dataUrl) {
        setSrc(r.dataUrl);
        setState('ok');
      } else {
        setState('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="image-view" hidden={!active}>
      {state === 'ok' && src ? (
        <img
          className="image-view-img"
          src={src}
          alt=""
          draggable={false}
          onClick={() =>
            window.dispatchEvent(new CustomEvent('simple-note:preview-image', { detail: src }))
          }
        />
      ) : state === 'error' ? (
        <div className="image-view-empty">無法載入圖片</div>
      ) : null}
    </div>
  );
}
