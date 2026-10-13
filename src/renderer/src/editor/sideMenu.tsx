import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { NodeSelection } from 'prosemirror-state';

type MenuPosition = { left: number; top: number };
type HoverZone = { left: number; right: number; top: number; bottom: number };
type SideMenuData = {
  block: any;
  left: number;
  top: number;
  hoverZone: HoverZone;
};
function cssAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function firstVisibleTextRect(root: HTMLElement): DOMRect | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });

  let textNode = walker.nextNode() as Text | null;
  while (textNode) {
    const text = textNode.textContent ?? '';
    const start = text.search(/\S/);
    if (start >= 0) {
      const range = document.createRange();
      const firstCodePoint = text.codePointAt(start);
      const end = Math.min(text.length, start + (firstCodePoint && firstCodePoint > 0xffff ? 2 : 1));
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      const rect =
        Array.from(range.getClientRects()).find((item) => item.width > 0 && item.height > 0) ??
        range.getBoundingClientRect();
      range.detach();
      if (rect.height > 0) return rect;
    }
    textNode = walker.nextNode() as Text | null;
  }

  return null;
}

function lineHeightPx(el: HTMLElement, fallback: number): number {
  const style = window.getComputedStyle(el);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight)) return lineHeight;
  const fontSize = Number.parseFloat(style.fontSize);
  if (Number.isFinite(fontSize)) return fontSize * 1.2;
  return fallback;
}

function firstLineCenterY(blockEl: HTMLElement): number {
  const contentEl = blockEl.querySelector('.bn-block-content') as HTMLElement | null;
  const inlineEl = contentEl?.querySelector('.bn-inline-content') as HTMLElement | null;
  const textRect = inlineEl ? firstVisibleTextRect(inlineEl) : null;
  if (textRect) return textRect.top + textRect.height / 2;

  const anchorEl = inlineEl ?? contentEl ?? blockEl;
  const rect = anchorEl.getBoundingClientRect();
  const firstLineHeight = Math.min(rect.height, lineHeightPx(anchorEl, rect.height));
  return rect.top + firstLineHeight / 2;
}

function sideMenuTop(blockEl: HTMLElement, handleSize: number): number {
  const contentEl = blockEl.querySelector('.bn-block-content') as HTMLElement | null;
  if (contentEl?.dataset.contentType === 'codeBlock') {
    return contentEl.getBoundingClientRect().top;
  }
  return firstLineCenterY(blockEl) - handleSize / 2;
}

function blockPosition(editor: any, blockEl: HTMLElement): MenuPosition & { hoverZone: HoverZone } {
  const viewDom = (editor as { _tiptapEditor?: { view?: { dom?: HTMLElement } } })._tiptapEditor
    ?.view?.dom;
  const blockGroup = (viewDom?.firstElementChild as HTMLElement | null) ?? viewDom;
  const groupRect = (blockGroup ?? blockEl).getBoundingClientRect();
  const handleSize = 24;
  const gap = 8;
  const top = sideMenuTop(blockEl, handleSize);
  const left = groupRect.left - handleSize - gap;
  const clampedTop = Math.min(window.innerHeight - handleSize - 4, Math.max(4, top));

  return {
    left,
    top: clampedTop,
    hoverZone: {
      left: left - 8,
      right: groupRect.left + 12,
      top: clampedTop - 10,
      bottom: clampedTop + handleSize + 10,
    },
  };
}

function pointInZone(x: number, y: number, zone: HoverZone): boolean {
  return x >= zone.left && x <= zone.right && y >= zone.top && y <= zone.bottom;
}

function sideMenuAttributes(block: any): Record<string, string> {
  const attrs: Record<string, string> = { 'data-block-type': String(block.type ?? '') };
  if (block.type === 'heading') {
    attrs['data-level'] = String((block.props as { level?: unknown } | undefined)?.level ?? '1');
  }
  return attrs;
}

export function SimpleNoteSideMenuController({
  editor,
  containerRef,
}: {
  editor: any;
  containerRef: RefObject<HTMLElement>;
}): JSX.Element | null {
  const [menu, setMenu] = useState<SideMenuData | null>(null);
  const [frozen, setFrozen] = useState(false);
  const menuStateRef = useRef<SideMenuData | null>(null);

  useEffect(() => {
    menuStateRef.current = menu;
  }, [menu]);

  const setMenuForBlockElement = useCallback(
    (blockEl: HTMLElement): void => {
      const blockId = blockEl.getAttribute('data-id');
      if (!blockId) return;
      const block = editor.getBlock(blockId);
      if (!block) return;
      setMenu({ block, ...blockPosition(editor, blockEl) });
    },
    [editor]
  );

  const refreshPosition = useCallback((): void => {
    setMenu((current) => {
      if (!current) return current;
      const blockId = String(current.block.id ?? '');
      if (!blockId) return null;
      const viewDom = (editor as { _tiptapEditor?: { view?: { dom?: HTMLElement } } })
        ._tiptapEditor?.view?.dom;
      const blockEl =
        viewDom?.querySelector(
          `[data-node-type="blockContainer"][data-id="${cssAttr(blockId)}"]`
        ) ?? null;
      if (!(blockEl instanceof HTMLElement)) return null;
      return { ...current, ...blockPosition(editor, blockEl) };
    });
  }, [editor]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.bn-side-menu')) return;
      if (frozen) return;

      const current = menuStateRef.current;
      if (current && pointInZone(event.clientX, event.clientY, current.hoverZone)) return;

      const host = containerRef.current;
      if (!host || !host.contains(target)) {
        setMenu(null);
        return;
      }

      const blockEl = target.closest('[data-node-type="blockContainer"][data-id]');
      if (!(blockEl instanceof HTMLElement) || !host.contains(blockEl)) {
        setMenu(null);
        return;
      }

      setMenuForBlockElement(blockEl);
    };

    const onScroll = (): void => refreshPosition();
    const onResize = (): void => refreshPosition();

    window.addEventListener('mousemove', onMouseMove, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('mousemove', onMouseMove, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [containerRef, frozen, refreshPosition, setMenuForBlockElement]);

  if (!menu) return null;

  return createPortal(
    <SimpleNoteSideMenu
      editor={editor}
      block={menu.block}
      position={{ left: menu.left, top: menu.top }}
      blockDragStart={editor.sideMenu.blockDragStart}
      blockDragEnd={editor.sideMenu.blockDragEnd}
      freezeMenu={() => setFrozen(true)}
      unfreezeMenu={() => setFrozen(false)}
    />,
    document.body
  );
}

// Selects the whole block (with its children) as a NodeSelection on the block
// container, which editor.css paints as a highlighted block. Copy, cut and
// Delete then act on the entire block.
function selectBlock(editor: any, blockId: string): void {
  const view = editor._tiptapEditor?.view;
  if (!view) return;
  let pos: number | null = null;
  view.state.doc.descendants((node: any, p: number) => {
    if (pos !== null) return false;
    if (node.type.name === 'blockContainer' && node.attrs.id === blockId) {
      pos = p;
      return false;
    }
    return true;
  });
  if (pos === null) return;
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
  view.focus();
}

function SimpleNoteSideMenu(props: {
  editor: any;
  block: any;
  position: MenuPosition;
  blockDragStart: (event: DragEvent<HTMLButtonElement>, block: any) => void;
  blockDragEnd: (event: DragEvent<HTMLButtonElement>) => void;
  freezeMenu: () => void;
  unfreezeMenu: () => void;
}): JSX.Element {
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    pointerDownRef.current = { x: event.clientX, y: event.clientY };
    event.stopPropagation();
  }, []);

  // A click (no drag movement) selects the block; a drag goes to onDragStart.
  const onPointerUp = useCallback(
    (event: PointerEvent<HTMLButtonElement>): void => {
      if (event.button !== 0) return;
      const start = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!start) return;
      const dx = Math.abs(event.clientX - start.x);
      const dy = Math.abs(event.clientY - start.y);
      if (dx > 4 || dy > 4) return;
      event.preventDefault();
      event.stopPropagation();
      selectBlock(props.editor, props.block.id);
    },
    [props.editor, props.block.id]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      selectBlock(props.editor, props.block.id);
    },
    [props.editor, props.block.id]
  );

  const onDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>): void => {
      props.freezeMenu();
      props.blockDragStart(event, props.block);
    },
    [props]
  );

  const onDragEnd = useCallback(
    (event: DragEvent<HTMLButtonElement>): void => {
      props.blockDragEnd(event);
      props.unfreezeMenu();
    },
    [props]
  );

  return (
    <div
      className="bn-side-menu"
      style={{ left: props.position.left, top: props.position.top }}
      {...sideMenuAttributes(props.block)}
    >
      <button
        type="button"
        className="bn-button sn-drag-handle-button"
        draggable={true}
        aria-label={props.editor.dictionary.side_menu.drag_handle_label}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={onKeyDown}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <span className="sn-drag-handle-icon" aria-hidden="true" />
      </button>
    </div>
  );
}
