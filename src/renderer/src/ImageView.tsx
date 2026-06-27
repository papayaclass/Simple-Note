import { useEffect, useState } from 'react';
import { useStore } from './store';

// Read-only image preview surface for an `image`-kind tab. Loads the file at the
// tab's filePath via IPC (bytes → data URL) so it works regardless of the
// renderer's origin. Clicking opens the shared lightbox for a zoomed view.
export function ImageView({ tabId, active }: { tabId: string; active: boolean }): JSX.Element {
  const filePath = useStore((s) => s.tabs.find((t) => t.id === tabId)?.filePath ?? null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!filePath) {
      setSrc(null);
      return;
    }
    void window.api.vault.readImageAsDataUrl(null, filePath).then((r) => {
      if (!cancelled) setSrc(r.ok ? r.dataUrl ?? null : null);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="image-view" hidden={!active}>
      {src ? (
        <img
          className="image-view-img"
          src={src}
          alt=""
          draggable={false}
          onClick={() =>
            window.dispatchEvent(new CustomEvent('simple-note:preview-image', { detail: src }))
          }
        />
      ) : (
        <div className="image-view-empty">無法載入圖片</div>
      )}
    </div>
  );
}
