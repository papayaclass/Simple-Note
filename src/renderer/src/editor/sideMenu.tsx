import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { parseYouTubeId } from './youtubePreview';

type MenuPosition = { left: number; top: number };
type HoverZone = { left: number; right: number; top: number; bottom: number };
type SideMenuData = {
  block: any;
  left: number;
  top: number;
  hoverZone: HoverZone;
};
type ColorKey =
  | 'default'
  | 'gray'
  | 'brown'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink';

const COLORS: ColorKey[] = [
  'default',
  'gray',
  'brown',
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
];

const SWATCH_COLORS: Record<ColorKey, { text: string; background: string }> = {
  default: { text: '#777777', background: '#ffffff' },
  gray: { text: '#9b9a97', background: '#ebeced' },
  brown: { text: '#64473a', background: '#e9e5e3' },
  red: { text: '#e03e3e', background: '#fbe4e4' },
  orange: { text: '#d9730d', background: '#f6e9d9' },
  yellow: { text: '#dfab01', background: '#fbf3db' },
  green: { text: '#4d6461', background: '#ddedea' },
  blue: { text: '#0b6e99', background: '#ddebf1' },
  purple: { text: '#6940a5', background: '#eae4f2' },
  pink: { text: '#ad1a72', background: '#f4dfeb' },
};

function youTubeUrlInBlock(block: { content?: unknown }): string | null {
  const content = block.content;
  if (!Array.isArray(content)) return null;
  for (const item of content as Array<{ type?: string; href?: string }>) {
    if (item?.type === 'link' && typeof item.href === 'string' && parseYouTubeId(item.href)) {
      return item.href;
    }
  }
  return null;
}

function blockSupportsProp(block: { props?: Record<string, unknown> }, prop: string): boolean {
  return Object.prototype.hasOwnProperty.call(block.props ?? {}, prop);
}

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

function menuPositionFor(button: HTMLElement): MenuPosition {
  const rect = button.getBoundingClientRect();
  const menuWidth = 164;
  const gap = 8;
  const left = rect.left >= menuWidth + gap ? rect.left - menuWidth - gap : rect.right + gap;
  const top = Math.min(window.innerHeight - 12, Math.max(12, rect.top - 4));
  return { left, top };
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
      if (target.closest('.bn-side-menu, .sn-drag-handle-menu')) return;
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

function SimpleNoteSideMenu(props: {
  editor: any;
  block: any;
  position: MenuPosition;
  blockDragStart: (event: DragEvent<HTMLButtonElement>, block: any) => void;
  blockDragEnd: (event: DragEvent<HTMLButtonElement>) => void;
  freezeMenu: () => void;
  unfreezeMenu: () => void;
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPosition>({ left: 0, top: 0 });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);

  const ytUrl = youTubeUrlInBlock(props.block);
  const blockProps = (props.block.props ?? {}) as Record<string, unknown>;
  const supportsTextColor = blockSupportsProp(props.block, 'textColor');
  const supportsBackgroundColor = blockSupportsProp(props.block, 'backgroundColor');
  const canColor = supportsTextColor || supportsBackgroundColor;
  const dict = props.editor.dictionary;

  const colorLabels = useMemo(() => {
    return (dict.color_picker?.colors ?? {}) as Record<string, string>;
  }, [dict]);

  const closeMenu = useCallback((): void => {
    setMenuOpen(false);
    setColorOpen(false);
    props.unfreezeMenu();
  }, [props]);

  const openMenu = useCallback(
    (button: HTMLElement): void => {
      setMenuPos(menuPositionFor(button));
      setMenuOpen(true);
      setColorOpen(false);
      props.freezeMenu();
    },
    [props]
  );

  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: globalThis.PointerEvent): void => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return;
      closeMenu();
    };

    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') closeMenu();
    };

    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [closeMenu, menuOpen]);

  const removeBlock = useCallback((): void => {
    props.editor.removeBlocks([props.block]);
    closeMenu();
  }, [closeMenu, props]);

  const applyBlockColor = useCallback(
    (prop: 'textColor' | 'backgroundColor', color: ColorKey): void => {
      props.editor.updateBlock(props.block, { props: { [prop]: color } } as never);
      closeMenu();
    },
    [closeMenu, props]
  );

  const copyYouTubeLink = useCallback((): void => {
    if (!ytUrl) return;
    window.api.clipboard.writeText(ytUrl);
    closeMenu();
  }, [closeMenu, ytUrl]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    pointerDownRef.current = { x: event.clientX, y: event.clientY };
    event.stopPropagation();
  }, []);

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
      menuOpen ? closeMenu() : openMenu(event.currentTarget);
    },
    [closeMenu, menuOpen, openMenu]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      menuOpen ? closeMenu() : openMenu(event.currentTarget);
    },
    [closeMenu, menuOpen, openMenu]
  );

  const onDragStart = useCallback(
    (event: DragEvent<HTMLButtonElement>): void => {
      setMenuOpen(false);
      setColorOpen(false);
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
        ref={buttonRef}
        type="button"
        className="bn-button sn-drag-handle-button"
        draggable={true}
        aria-label={dict.side_menu.drag_handle_label}
        aria-expanded={menuOpen}
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
      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            className="sn-drag-handle-menu"
            style={{ left: menuPos.left, top: menuPos.top }}
            role="menu"
          >
            {ytUrl && (
              <button type="button" role="menuitem" onClick={copyYouTubeLink}>
                Copy Link
              </button>
            )}
            <button type="button" role="menuitem" onClick={removeBlock}>
              {dict.drag_handle.delete_menuitem}
            </button>
            {canColor && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  aria-expanded={colorOpen}
                  onClick={() => setColorOpen((open) => !open)}
                >
                  {dict.drag_handle.colors_menuitem}
                  <span className="sn-menu-chevron" aria-hidden="true">
                    ›
                  </span>
                </button>
                {colorOpen && (
                  <div className="sn-color-panel">
                    {supportsTextColor && (
                      <ColorSection
                        title={dict.color_picker.text_title}
                        current={String(blockProps.textColor ?? 'default')}
                        labels={colorLabels}
                        type="text"
                        onSelect={(color) => applyBlockColor('textColor', color)}
                      />
                    )}
                    {supportsBackgroundColor && (
                      <ColorSection
                        title={dict.color_picker.background_title}
                        current={String(blockProps.backgroundColor ?? 'default')}
                        labels={colorLabels}
                        type="background"
                        onSelect={(color) => applyBlockColor('backgroundColor', color)}
                      />
                    )}
                  </div>
                )}
              </>
            )}
          </div>,
          document.body
        )}
    </div>
  );
}

function ColorSection({
  title,
  current,
  labels,
  type,
  onSelect,
}: {
  title: string;
  current: string;
  labels: Record<string, string>;
  type: 'text' | 'background';
  onSelect: (color: ColorKey) => void;
}): JSX.Element {
  return (
    <div className="sn-color-section">
      <div className="sn-color-title">{title}</div>
      <div className="sn-color-grid">
        {COLORS.map((color) => (
          <button
            key={`${type}-${color}`}
            type="button"
            className="sn-color-swatch"
            aria-label={labels[color] ?? color}
            aria-pressed={current === color}
            title={labels[color] ?? color}
            onClick={() => onSelect(color)}
          >
            <span
              style={{
                color: SWATCH_COLORS[color].text,
                backgroundColor:
                  type === 'background' ? SWATCH_COLORS[color].background : 'transparent',
              }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
