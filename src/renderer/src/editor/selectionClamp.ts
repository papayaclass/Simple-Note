import { Plugin, PluginKey, Selection, TextSelection } from 'prosemirror-state';

const KEY = new PluginKey('simple-note-selection-clamp');
const DRAG_THRESHOLD = 4;
const EDGE_TOLERANCE = 2;
const EDGE_ZONE = 56;
const MAX_SCROLL_SPEED = 24;

interface EditorViewLike {
  state: any;
  dispatch: (tr: any) => void;
  focus: () => void;
  dom: HTMLElement;
  posAtCoords: (coords: { left: number; top: number }) => { pos: number } | null;
}

interface DragState {
  view: EditorViewLike;
  id: string;
  contentEl: HTMLElement;
  anchor: number;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  dragging: boolean;
  scrollRoot: HTMLElement;
  scrollVel: number;
  rafId: number;
  lastHead: number;
}

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

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function pointerIsStillInBlockContent(drag: DragState, clientY: number): boolean {
  const rect = drag.contentEl.getBoundingClientRect();
  return clientY >= rect.top - EDGE_TOLERANCE && clientY <= rect.bottom + EDGE_TOLERANCE;
}

function posAtPointer(drag: DragState, clientX: number, clientY: number): number {
  const hit = drag.view.posAtCoords({ left: clientX, top: clientY });
  if (hit) {
    drag.lastHead = hit.pos;
  }
  let pos = hit?.pos ?? drag.lastHead;

  const range = blockContentRange(drag.view.state.doc, drag.id);
  if (range && pointerIsStillInBlockContent(drag, clientY)) {
    pos = clamp(pos, range.from, range.to);
  }

  return pos;
}

function dispatchSelection(view: EditorViewLike, anchor: number, head: number): void {
  const doc = view.state.doc;
  const bias = head >= anchor ? 1 : -1;
  const selection = TextSelection.between(doc.resolve(anchor), doc.resolve(head), bias);
  view.dispatch(view.state.tr.setSelection(selection));
}

function dispatchCaret(view: EditorViewLike, pos: number): void {
  const doc = view.state.doc;
  view.dispatch(view.state.tr.setSelection(Selection.near(doc.resolve(pos))));
}

function scrollRootFor(view: EditorViewLike): HTMLElement {
  return (
    (view.dom.closest('.document-view') as HTMLElement | null) ??
    (document.scrollingElement as HTMLElement | null) ??
    document.documentElement
  );
}

function shouldSkipTarget(target: HTMLElement): boolean {
  return Boolean(
    target.closest(
      'button, a, input, select, textarea, [contenteditable="false"], .sn-image-block'
    )
  );
}

function eventElement(event: MouseEvent): HTMLElement | null {
  const target = event.target;
  if (target instanceof HTMLElement) return target;
  if (target instanceof Text) return target.parentElement;
  return null;
}

export function createSelectionClampPlugin(): Plugin {
  let drag: DragState | null = null;

  const clearDrag = (): void => {
    if (drag?.rafId) cancelAnimationFrame(drag.rafId);
    drag = null;
    window.removeEventListener('mousemove', onWindowMouseMove, true);
    window.removeEventListener('mouseup', onWindowMouseUp, true);
  };

  function updateAutoScroll(current: DragState): void {
    const root = current.scrollRoot;
    const rect = root.getBoundingClientRect();
    const canScroll = root.scrollHeight > root.clientHeight;
    let velocity = 0;

    if (canScroll) {
      if (current.latestY > rect.bottom - EDGE_ZONE) {
        const intensity = Math.min((current.latestY - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE, 1);
        velocity = intensity * MAX_SCROLL_SPEED;
      } else if (current.latestY < rect.top + EDGE_ZONE) {
        const intensity = Math.min((rect.top + EDGE_ZONE - current.latestY) / EDGE_ZONE, 1);
        velocity = -intensity * MAX_SCROLL_SPEED;
      }
    }

    current.scrollVel = velocity;
    if (velocity !== 0 && !current.rafId) {
      current.rafId = requestAnimationFrame(() => autoScrollTick(current));
    }
  }

  function autoScrollTick(current: DragState): void {
    current.rafId = 0;
    if (drag !== current || !current.dragging || current.scrollVel === 0) return;

    const root = current.scrollRoot;
    const before = root.scrollTop;
    root.scrollTop = before + current.scrollVel;
    const delta = root.scrollTop - before;

    if (delta !== 0) {
      try {
        dispatchSelection(
          current.view,
          current.anchor,
          posAtPointer(current, current.latestX, current.latestY)
        );
      } catch {
        // Position may temporarily be at a block gap; keep scrolling.
      }
      current.rafId = requestAnimationFrame(() => autoScrollTick(current));
    } else {
      current.scrollVel = 0;
    }
  }

  function onWindowMouseMove(e: MouseEvent): void {
    if (!drag) return;
    if (e.buttons === 0) {
      clearDrag();
      return;
    }

    drag.latestX = e.clientX;
    drag.latestY = e.clientY;

    const dx = Math.abs(e.clientX - drag.startX);
    const dy = Math.abs(e.clientY - drag.startY);
    if (!drag.dragging && dx < DRAG_THRESHOLD && dy < DRAG_THRESHOLD) return;

    drag.dragging = true;
    e.preventDefault();
    try {
      dispatchSelection(drag.view, drag.anchor, posAtPointer(drag, e.clientX, e.clientY));
    } catch {
      // Position may be at a block gap; keep going so auto-scroll still works.
    }
    updateAutoScroll(drag);
  }

  function onWindowMouseUp(e: MouseEvent): void {
    if (!drag) return;

    const current = drag;
    current.latestX = e.clientX;
    current.latestY = e.clientY;
    clearDrag();
    e.preventDefault();

    if (current.dragging) {
      try {
        dispatchSelection(current.view, current.anchor, posAtPointer(current, e.clientX, e.clientY));
      } catch {
        // ignore — leave the selection as-is on mouseup
      }
    } else {
      dispatchCaret(current.view, current.anchor);
    }
    current.view.focus();
  }

  return new Plugin({
    key: KEY,
    props: {
      handleDOMEvents: {
        mousedown(editorView, event) {
          if (event.button !== 0 || event.detail > 1) return false;
          if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false;

          const target = eventElement(event);
          if (!target || shouldSkipTarget(target)) return false;

          const contentEl = target.closest('.bn-block-content') as HTMLElement | null;
          if (!contentEl || !editorView.dom.contains(contentEl)) return false;

          const blockEl = contentEl.closest('[data-id]') as HTMLElement | null;
          const id = blockEl?.getAttribute('data-id') ?? '';
          const range = id ? blockContentRange(editorView.state.doc, id) : null;
          const hit = editorView.posAtCoords({ left: event.clientX, top: event.clientY });
          if (!id || !range || !hit) return false;

          event.preventDefault();
          clearDrag();

          const view = editorView as unknown as EditorViewLike;
          view.focus();

          drag = {
            view,
            id,
            contentEl,
            anchor: clamp(hit.pos, range.from, range.to),
            startX: event.clientX,
            startY: event.clientY,
            latestX: event.clientX,
            latestY: event.clientY,
            dragging: false,
            scrollRoot: scrollRootFor(view),
            scrollVel: 0,
            rafId: 0,
            lastHead: clamp(hit.pos, range.from, range.to),
          };
          window.addEventListener('mousemove', onWindowMouseMove, true);
          window.addEventListener('mouseup', onWindowMouseUp, true);
          return true;
        },
      },
    },
  });
}
