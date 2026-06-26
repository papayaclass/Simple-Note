import { type ComponentType, type DragEvent } from 'react';
import {
  useBlockNoteEditor,
  useComponentsContext,
  type SideMenuProps,
} from '@blocknote/react';
import { SimpleNoteDragHandleMenu } from './dragHandleMenu';

type Props = Omit<SideMenuProps<any, any, any>, 'addBlock'>;

export function SimpleNoteDragHandleButton(props: Props): JSX.Element | null {
  const Components = useComponentsContext();
  const editor = useBlockNoteEditor();
  if (!Components) return null;

  const SideMenuButton = Components.SideMenu.Button as ComponentType<any>;

  return (
    <Components.Generic.Menu.Root
      onOpenChange={(open: boolean) => {
        if (open) props.freezeMenu();
        else props.unfreezeMenu();
      }}
      position="left"
    >
      <Components.Generic.Menu.Trigger>
        <SideMenuButton
          label={editor.dictionary.side_menu.drag_handle_label}
          draggable={true}
          onDragStart={(e: DragEvent) => props.blockDragStart(e, props.block)}
          onDragEnd={props.blockDragEnd}
          className="bn-button sn-drag-handle-button"
          icon={<span className="sn-drag-handle-icon" aria-hidden="true" />}
        />
      </Components.Generic.Menu.Trigger>
      <SimpleNoteDragHandleMenu block={props.block} />
    </Components.Generic.Menu.Root>
  );
}
