import { useEffect, useRef, useState } from 'react';
import { defaultProps } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';

// In-session image block. The image is held as a data URL in the `src` prop and
// only lives in memory: there is deliberately NO `toExternalHTML`/`parse`, so
// `blocksToMarkdownLossy()` drops it on save — the document keeps its text and
// discards images (by design). The block survives JSON serialization, so it is
// preserved when switching columns within a session.
//
// Interactions, all self-contained in ImageBlockView:
//   • click the image       → select it (8 resize handles appear)
//   • drag a corner/edge     → proportional resize (width-driven, height auto)
//   • Backspace/Delete       → remove the selected image block
//   • Escape / click outside → deselect
//   • double-click           → open the preview lightbox (App-level listener)
//   • drag the image body     → reorder the block up/down (drop indicator shown)
// Reordering also works via the shared SideMenu drag handle, like every block.

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type HandleDir = (typeof HANDLES)[number];

const MIN_WIDTH = 40;
const DRAG_THRESHOLD = 5; // px before a press on the image becomes a reorder drag

interface DropTarget {
  id: string;
  placement: 'before' | 'after';
  rect: DOMRect;
}

// Marquee (rubber-band) selection lives in marquee.ts and works on the
// ProseMirror TextSelection, which content-less image blocks can't join. This
// tiny store lets the marquee tell each image whether the rectangle is touching
// it, so the image shows the same blue frame. React owns the class via state, so
// node-view re-renders never clobber it. Cleared on the next mousedown.
const marqueeSelectedIds = new Set<string>();
const marqueeListeners = new Set<() => void>();

export function setMarqueeImageSelection(ids: Iterable<string>): void {
  marqueeSelectedIds.clear();
  for (const id of ids) marqueeSelectedIds.add(id);
  marqueeListeners.forEach((l) => l());
}

export function clearMarqueeImageSelection(): void {
  if (marqueeSelectedIds.size === 0) return;
  marqueeSelectedIds.clear();
  marqueeListeners.forEach((l) => l());
}

function ImageBlockView({ block, editor }: { block: any; editor: any }): JSX.Element {
  const src: string = block.props.src;
  const width: number = block.props.width;
  const [selected, setSelected] = useState(false);
  const [marqueeSelected, setMarqueeSelected] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const latestW = useRef(0);

  // Reflect marquee (rubber-band) selection touching this image.
  useEffect(() => {
    const update = (): void => setMarqueeSelected(marqueeSelectedIds.has(block.id));
    marqueeListeners.add(update);
    update();
    return () => {
      marqueeListeners.delete(update);
    };
  }, [block.id]);

  // Deselect when the pointer goes down anywhere outside this image, and on
  // Escape. Backspace/Delete (while selected) removes the whole image block.
  useEffect(() => {
    if (!selected) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setSelected(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setSelected(false);
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        setSelected(false);
        editor.removeBlocks([block.id]);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [selected, editor, block.id]);

  function onHandleDown(e: React.PointerEvent, dir: HandleDir): void {
    e.preventDefault();
    e.stopPropagation();
    const img = imgRef.current;
    if (!img) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = img.offsetWidth;
    const startH = img.offsetHeight;
    const aspect = startH > 0 ? startW / startH : 1;
    const maxW = wrapRef.current?.parentElement?.clientWidth ?? Infinity;
    latestW.current = startW;

    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let w = computeWidth(dir, startW, dx, dy, aspect);
      w = Math.max(MIN_WIDTH, Math.min(w, maxW));
      img.style.width = `${w}px`;
      latestW.current = w;
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      editor.updateBlock(block, { props: { width: Math.round(latestW.current) } });
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }

  // Press-and-drag on the image body reorders the block. A small threshold keeps
  // a plain click (select) and double-click (preview) from triggering a move; a
  // floating indicator line previews the drop position.
  function onBodyPointerDown(e: React.PointerEvent): void {
    setSelected(true);
    const startX = e.clientX;
    const startY = e.clientY;
    const viewDom = (editor as any)._tiptapEditor.view.dom as HTMLElement;
    let dragging = false;
    let indicator: HTMLDivElement | null = null;
    let target: DropTarget | null = null;

    const move = (ev: PointerEvent): void => {
      if (!dragging) {
        if (
          Math.abs(ev.clientX - startX) < DRAG_THRESHOLD &&
          Math.abs(ev.clientY - startY) < DRAG_THRESHOLD
        )
          return;
        dragging = true;
        document.body.classList.add('sn-image-dragging');
        indicator = document.createElement('div');
        indicator.className = 'sn-image-drop-indicator';
        document.body.appendChild(indicator);
      }
      ev.preventDefault();
      target = computeDropTarget(editor, viewDom, block.id, ev.clientY);
      if (indicator) drawDropIndicator(indicator, target);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      indicator?.remove();
      document.body.classList.remove('sn-image-dragging');
      if (dragging && target) {
        editor.insertBlocks(
          [{ type: 'image', props: { src: block.props.src, width: block.props.width } }],
          target.id,
          target.placement
        );
        editor.removeBlocks([block.id]);
      }
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
  }

  return (
    <div
      ref={wrapRef}
      className={`sn-image-block${selected ? ' selected' : ''}${
        marqueeSelected ? ' marquee-selected' : ''
      }`}
      contentEditable={false}
      onPointerDown={onBodyPointerDown}
      onDoubleClick={() =>
        window.dispatchEvent(new CustomEvent('simple-note:preview-image', { detail: src }))
      }
    >
      <img
        ref={imgRef}
        src={src}
        alt=""
        draggable={false}
        style={width ? { width: `${width}px` } : undefined}
      />
      {selected &&
        HANDLES.map((h) => (
          <div
            key={h}
            className={`sn-image-handle sn-h-${h}`}
            onPointerDown={(e) => onHandleDown(e, h)}
          />
        ))}
    </div>
  );
}

// Proportional resize is always driven by the resulting width. Left/top handles
// invert the delta; top/bottom map vertical movement through the aspect ratio.
function computeWidth(
  dir: HandleDir,
  startW: number,
  dx: number,
  dy: number,
  aspect: number
): number {
  switch (dir) {
    case 'e':
    case 'ne':
    case 'se':
      return startW + dx;
    case 'w':
    case 'nw':
    case 'sw':
      return startW - dx;
    case 's':
      return startW + dy * aspect;
    case 'n':
      return startW - dy * aspect;
    default:
      return startW;
  }
}

// Pick the top-level block whose vertical midpoint is nearest the cursor and
// whether the image should land before or after it. Returns null when the
// nearest block is the image itself (dropping in place is a no-op).
function computeDropTarget(
  editor: any,
  viewDom: HTMLElement,
  selfId: string,
  y: number
): DropTarget | null {
  let best: { id: string; rect: DOMRect; mid: number } | null = null;
  let bestDist = Infinity;
  for (const b of editor.document as Array<{ id: string }>) {
    const el = viewDom.querySelector(`[data-id="${b.id}"]`);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const dist = Math.abs(y - mid);
    if (dist < bestDist) {
      bestDist = dist;
      best = { id: b.id, rect, mid };
    }
  }
  if (!best || best.id === selfId) return null;
  return { id: best.id, placement: y < best.mid ? 'before' : 'after', rect: best.rect };
}

function drawDropIndicator(el: HTMLDivElement, target: DropTarget | null): void {
  if (!target) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.style.left = `${target.rect.left}px`;
  el.style.width = `${target.rect.width}px`;
  el.style.top = `${(target.placement === 'before' ? target.rect.top : target.rect.bottom) - 1}px`;
}

export const ImageBlock = createReactBlockSpec(
  {
    type: 'image',
    propSchema: { ...defaultProps, src: { default: '' }, width: { default: 0 } },
    content: 'none',
  },
  {
    render: (props: any) => <ImageBlockView block={props.block} editor={props.editor} />,
  }
);
