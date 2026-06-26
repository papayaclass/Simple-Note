import { TextSelection } from 'prosemirror-state';
import { setMarqueeImageSelection, clearMarqueeImageSelection } from './image';

const DRAG_THRESHOLD = 4; // px before a press becomes a marquee drag
const EDGE_ZONE = 56; // px from the container edge where auto-scroll kicks in
const MAX_SCROLL_SPEED = 24; // px per frame at full intensity

interface ProseView {
  state: any;
  dispatch: (tr: any) => void;
  focus: () => void;
  posAtCoords: (coords: { left: number; top: number }) => { pos: number } | null;
  dom: HTMLElement;
}

type BlockNoteEditor = { _tiptapEditor: { view: ProseView } };

// Inner content range (text positions) of the block whose blockContainer node
// carries the given id. Mirrors how BlockNote's own setSelection derives the
// anchor/head: blockContent.beforePos + 1 .. afterPos - 1. Returns null for
// blocks without inline content (e.g. dividers), so they can be skipped.
function blockContentRange(doc: any, id: string): { from: number; to: number } | null {
  let range: { from: number; to: number } | null = null;
  doc.descendants((node: any, pos: number) => {
    if (range) return false;
    if (node.type.name === 'blockContainer' && node.attrs?.id === id) {
      node.forEach((child: any, offset: number) => {
        if (range) return;
        if (child.type.spec.group === 'blockContent') {
          const before = pos + 1 + offset;
          range = { from: before + 1, to: before + child.nodeSize - 1 };
        }
      });
      return false;
    }
    return true;
  });
  return range;
}

// Photoshop/Illustrator-style rubber-band selection. Pressing in any blank area
// of the page (the side gutters, the padding around the text, the gaps between
// blocks — anywhere that isn't block text) and dragging draws a blue rectangle;
// every block the rectangle actually intersects is selected with a single
// ProseMirror TextSelection, so copy / cut / delete / formatting all work on it.
//
// `resolve` maps the initial mousedown to the editor that should own the drag
// (left vs. right column), so two-column mode routes correctly.
export function attachMarquee(
  root: HTMLElement,
  resolve: (e: MouseEvent) => BlockNoteEditor | null
): () => void {
  let view: ProseView | null = null;
  let startX = 0;
  let startY = 0;
  let active = false;
  let box: HTMLDivElement | null = null;
  // Latest pointer position (viewport coords), kept so the auto-scroll loop can
  // keep re-drawing / re-selecting while the mouse is held still at the edge.
  let lastX = 0;
  let lastY = 0;
  let scrollVel = 0; // px/frame; +down, -up, 0 = idle
  let rafId = 0;

  function onDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    // A fresh left-press clears any image frames left over from a previous
    // marquee, mirroring how clicking clears the text selection.
    clearMarqueeImageSelection();
    const t = e.target as HTMLElement;
    // Started on real block text → leave it to the editor's normal caret/drag.
    if (t.closest('.bn-block-content')) return;
    // Don't hijack interactive chrome or fixed overlays.
    if (
      t.closest(
        'button, a, input, select, .bn-side-menu, [contenteditable="false"], ' +
          '.drag-bar, .status-bar, .prefs-overlay, .prefs-panel, .word-count-popover, ' +
          '.column-divider'
      )
    )
      return;

    const editor = resolve(e);
    if (!editor) return;
    view = editor._tiptapEditor.view;

    startX = e.clientX;
    startY = e.clientY;
    active = false;
    // Stop the browser from starting its own text drag-selection / caret.
    e.preventDefault();
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }

  function onMove(e: MouseEvent): void {
    if (!view) return;
    if (!active) {
      if (
        Math.abs(e.clientX - startX) < DRAG_THRESHOLD &&
        Math.abs(e.clientY - startY) < DRAG_THRESHOLD
      )
        return;
      active = true;
      box = document.createElement('div');
      box.className = 'marquee-box';
      document.body.appendChild(box);
      // Focus so the selection highlight renders at full strength while dragging.
      view.focus();
    }
    e.preventDefault();
    lastX = e.clientX;
    lastY = e.clientY;
    drawBox(lastX, lastY);
    selectWithin(lastX, lastY);
    updateAutoScroll();
  }

  function onUp(e: MouseEvent): void {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    stopAutoScroll();
    if (box) {
      box.remove();
      box = null;
    }
    if (!active && view) {
      // Plain click in a blank area: place the caret where the user clicked,
      // matching the editor's normal click behaviour.
      const p = view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (p) {
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(p.pos))));
        view.focus();
      }
    } else if (active) {
      // Swallow the click that follows the drag so the app's blank-area click
      // handler doesn't move the caret and discard the selection we just made.
      const swallow = (ev: MouseEvent): void => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener('click', swallow, true);
      window.setTimeout(() => window.removeEventListener('click', swallow, true), 0);
    }
    active = false;
    view = null;
  }

  // When the pointer nears the top/bottom edge of the scroll container while
  // dragging, set a scroll velocity and (re)start the rAF loop. Leaving the edge
  // zone sets the velocity to 0, which ends the loop on its next tick.
  function updateAutoScroll(): void {
    const rect = root.getBoundingClientRect();
    const canScroll = root.scrollHeight > root.clientHeight;
    let v = 0;
    if (canScroll) {
      if (lastY > rect.bottom - EDGE_ZONE) {
        const intensity = Math.min((lastY - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE, 1);
        v = intensity * MAX_SCROLL_SPEED;
      } else if (lastY < rect.top + EDGE_ZONE) {
        const intensity = Math.min((rect.top + EDGE_ZONE - lastY) / EDGE_ZONE, 1);
        v = -intensity * MAX_SCROLL_SPEED;
      }
    }
    scrollVel = v;
    if (v !== 0 && !rafId) rafId = requestAnimationFrame(autoScrollTick);
  }

  function autoScrollTick(): void {
    rafId = 0;
    if (!view || !active || scrollVel === 0) return;
    const before = root.scrollTop;
    root.scrollTop = before + scrollVel;
    const delta = root.scrollTop - before; // actual movement (clamped at bounds)
    if (delta !== 0) {
      // The box is drawn in fixed viewport coords, but the selection should stay
      // anchored to the content where the drag began. As the content scrolls up
      // by `delta`, shift the start point up by the same amount so the rectangle
      // keeps growing over the blocks scrolling into view.
      startY -= delta;
      drawBox(lastX, lastY);
      selectWithin(lastX, lastY);
      rafId = requestAnimationFrame(autoScrollTick);
    } else {
      // Hit the top/bottom of the document — nothing more to reveal.
      scrollVel = 0;
    }
  }

  function stopAutoScroll(): void {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    scrollVel = 0;
  }

  function drawBox(cx: number, cy: number): void {
    if (!box) return;
    box.style.left = `${Math.min(cx, startX)}px`;
    box.style.top = `${Math.min(cy, startY)}px`;
    box.style.width = `${Math.abs(cx - startX)}px`;
    box.style.height = `${Math.abs(cy - startY)}px`;
  }

  // A block counts as touched only when the rectangle actually intersects it on
  // both axes — the Illustrator marquee model: the box must reach the block
  // (horizontally and vertically) before it is selected.
  function selectWithin(cx: number, cy: number): void {
    if (!view) return;
    const left = Math.min(cx, startX);
    const right = Math.max(cx, startX);
    const top = Math.min(cy, startY);
    const bottom = Math.max(cy, startY);

    // Image blocks have no text range, so they can't join the ProseMirror
    // TextSelection. Mark the ones the rectangle touches so they show the same
    // blue frame as a click-selected image (handled via image.tsx's store).
    const imageIds: string[] = [];
    view.dom.querySelectorAll<HTMLElement>('.sn-image-block').forEach((el) => {
      const r = el.getBoundingClientRect();
      const hit = r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom;
      if (!hit) return;
      const id = el.closest('[data-id]')?.getAttribute('data-id');
      if (id) imageIds.push(id);
    });
    setMarqueeImageSelection(imageIds);

    const doc = view.state.doc;
    const ranges: Array<{ from: number; to: number }> = [];
    view.dom.querySelectorAll<HTMLElement>('[data-id]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const intersects = r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom;
      if (!intersects) return;
      const id = el.getAttribute('data-id');
      if (!id) return;
      const range = blockContentRange(doc, id);
      if (range) ranges.push(range);
    });
    if (ranges.length === 0) return;

    // [data-id] elements come back in document order, so the first range's start
    // and the last range's end bound the whole touched span.
    const from = ranges[0].from;
    const to = ranges[ranges.length - 1].to;
    if (from > to) return;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, from, to)));
  }

  root.addEventListener('mousedown', onDown, true);
  return () => {
    root.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('mouseup', onUp, true);
    stopAutoScroll();
    if (box) box.remove();
  };
}
