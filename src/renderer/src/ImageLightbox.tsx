import { useEffect, useState } from 'react';

// Full-screen preview for an image block. Opened by the `simple-note:preview-image`
// event (dispatched on double-click in editor/image.tsx) and mounted once at the
// app root so two-column mode doesn't get two overlays. Right-clicking the image
// shows a single "另存新檔…" command that writes the original bytes to disk via
// the file:saveImage IPC. Click the backdrop or press Escape to close.
export function ImageLightbox(): JSX.Element | null {
  const [src, setSrc] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const onOpen = (e: Event): void => {
      setSrc((e as CustomEvent<string>).detail);
      setMenu(null);
    };
    window.addEventListener('simple-note:preview-image', onOpen);
    return () => window.removeEventListener('simple-note:preview-image', onOpen);
  }, []);

  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setSrc(null);
        setMenu(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [src]);

  if (!src) return null;

  const close = (): void => {
    setSrc(null);
    setMenu(null);
  };

  return (
    <div className="image-lightbox" onClick={close} onContextMenu={(e) => e.preventDefault()}>
      <img
        className="image-lightbox-img"
        src={src}
        alt=""
        draggable={false}
        onClick={(e) => {
          e.stopPropagation();
          setMenu(null);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {menu && (
        <div
          className="image-lightbox-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={async () => {
              setMenu(null);
              await window.api.file.saveImage(src);
            }}
          >
            另存新檔…
          </button>
        </div>
      )}
    </div>
  );
}
