import { useCallback, useEffect, useRef, useState } from 'react';
import { SideMenu, type SideMenuProps } from '@blocknote/react';
import { SimpleNoteDragHandleButton } from './dragHandleButton';

export function SimpleNoteSideMenu(props: SideMenuProps<any, any, any>): JSX.Element {
  const guardRef = useRef<HTMLDivElement | null>(null);
  const [hoverFrozen, setHoverFrozen] = useState(false);

  const menuDropdownOpen = useCallback((): boolean => {
    return !!guardRef.current?.querySelector('.mantine-Menu-dropdown');
  }, []);

  const freezeHover = useCallback((): void => {
    setHoverFrozen(true);
    props.freezeMenu();
  }, [props]);

  const releaseHover = useCallback((): void => {
    if (menuDropdownOpen()) return;
    setHoverFrozen(false);
    props.unfreezeMenu();
  }, [menuDropdownOpen, props]);

  useEffect(() => {
    if (!hoverFrozen) return;

    const onMouseMove = (event: MouseEvent): void => {
      if (menuDropdownOpen()) return;

      const guard = guardRef.current;
      if (!guard) {
        releaseHover();
        return;
      }

      const rect = guard.getBoundingClientRect();
      const insideGuard =
        event.clientX >= rect.left - 4 &&
        event.clientX <= rect.right + 40 &&
        event.clientY >= rect.top - 8 &&
        event.clientY <= rect.bottom + 8;

      if (!insideGuard) releaseHover();
    };

    window.addEventListener('mousemove', onMouseMove, true);
    return () => window.removeEventListener('mousemove', onMouseMove, true);
  }, [hoverFrozen, menuDropdownOpen, releaseHover]);

  return (
    <div
      ref={guardRef}
      className="sn-side-menu-guard"
      onMouseEnter={freezeHover}
      onMouseLeave={releaseHover}
    >
      <SideMenu {...props}>
        <SimpleNoteDragHandleButton {...props} />
      </SideMenu>
    </div>
  );
}
