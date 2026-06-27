import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './popmenu.css';

export interface PopMenuItem {
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  checked?: boolean;
  disabled?: boolean;
  // A visual separator row (label/onClick ignored).
  divider?: boolean;
}

export interface PopMenuState {
  x: number;
  y: number;
  items: PopMenuItem[];
}

// A small fixed-position popover menu used for sidebar/tab context menus and the
// sort dropdown. Measures itself and clamps into the viewport; closes on any
// outside mousedown or window blur.
export function PopMenu({
  state,
  onClose,
}: {
  state: PopMenuState;
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = state.x;
    let y = state.y;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [state]);

  useEffect(() => {
    // Bubble phase (not capture): the menu root stops propagation on its own
    // mousedown, so clicks inside the menu don't close it before the item's
    // click handler runs. Outside mousedowns still bubble up here and close it.
    const close = (): void => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="pop-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {state.items.map((it, i) =>
        it.divider ? (
          <div key={i} className="pop-menu-divider" />
        ) : (
          <button
            key={i}
            className={`pop-menu-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return;
              it.onClick?.();
              onClose();
            }}
          >
            {it.checked != null && <span className="check">{it.checked ? '✓' : ''}</span>}
            {it.label}
          </button>
        )
      )}
    </div>
  );
}
