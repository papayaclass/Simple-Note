import { useEffect, useState, DragEvent } from 'react';
import { useStore, Preferences } from '../store';
import { MENU_COMMANDS, reconcileMenuCommands, isDivider } from '../context-menu/commands';

type Category = 'menu' | 'apikeys';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'menu', label: '右鍵選單' },
  { id: 'apikeys', label: 'API Keys' },
];

const MENU_LABELS = new Map(MENU_COMMANDS.map((c) => [c.key, c.label]));

export function PreferencesPanel(): JSX.Element | null {
  const open = useStore((s) => s.prefsPanelOpen);
  const setOpen = useStore((s) => s.setPrefsPanelOpen);
  const committedPrefs = useStore((s) => s.preferences);
  const setPrefs = useStore((s) => s.setPreferences);

  const [draft, setDraft] = useState<Preferences>(committedPrefs);
  const [category, setCategory] = useState<Category>('menu');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Gap index (0..length) where the dragged row would land if dropped now.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Rows are only draggable while the drag handle is held, so the editable
  // label inputs remain clickable (a draggable parent would steal the click).
  const [dragEnabled, setDragEnabled] = useState(false);

  // Re-seed draft each time the panel opens with the latest committed prefs.
  useEffect(() => {
    if (open) {
      setDraft(committedPrefs);
      setCategory('menu');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!open) return;
      // Only Escape cancels. Enter is intentionally NOT bound so multi-line
      // fields (e.g. Custom Instruction) can use Enter / Shift+Enter to add
      // line breaks without closing the dialog. Closing is via the 確定 button.
      if (e.key === 'Escape') cancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // depend on render so handlers see latest draft

  if (!open) return null;

  const cancel = () => setOpen(false);
  // Only commit the fields this panel edits, so layout values changed in the
  // 微調面板 while this panel was open are not overwritten by a stale draft.
  const confirm = () => {
    const patch: Partial<Preferences> = {
      menuCommands: draft.menuCommands,
      openRouterApiKey: draft.openRouterApiKey,
      openRouterModel: draft.openRouterModel,
      aiGlobalInstruction: draft.aiGlobalInstruction,
    };
    setPrefs(patch);
    window.api.prefs.setAll(patch as Record<string, unknown>);
    setOpen(false);
  };
  const update = (patch: Partial<Preferences>) => setDraft((d) => ({ ...d, ...patch }));

  // Always work with a reconciled (complete, ordered) command list so newly
  // added commands appear and the saved order/visibility stays in sync.
  const menuCommands = reconcileMenuCommands(draft.menuCommands);

  const setCommandVisible = (key: string, visible: boolean) =>
    update({
      menuCommands: menuCommands.map((c) =>
        !isDivider(c) && c.key === key ? { ...c, visible } : c
      ),
    });

  // Keep whatever the user types live (including empty) so deleting the last
  // character doesn't snap the field back to the default mid-edit.
  const setCommandLabel = (key: string, value: string) =>
    update({
      menuCommands: menuCommands.map((c) =>
        !isDivider(c) && c.key === key ? { ...c, label: value } : c
      ),
    });

  // Validate on commit (Enter / blur): an empty name is not allowed, so warn
  // the user and restore the default. Otherwise clear the override when it just
  // equals the default, to keep storage tidy.
  const commitCommandLabel = (key: string) => {
    const item = menuCommands.find((c) => !isDivider(c) && c.key === key);
    if (!item || isDivider(item)) return;
    const def = MENU_LABELS.get(key);
    // Only warn when the field is genuinely empty. A missing override
    // (label === undefined) means the field shows the default name, not empty.
    if (item.label !== undefined && !item.label.trim()) {
      window.alert('請輸入指令名稱');
    }
    const label = item.label && item.label.trim() && item.label !== def ? item.label : undefined;
    if (label !== item.label) {
      update({
        menuCommands: menuCommands.map((c) =>
          !isDivider(c) && c.key === key ? { ...c, label } : c
        ),
      });
    }
  };

  const addDivider = () =>
    update({ menuCommands: [...menuCommands, { type: 'divider', id: crypto.randomUUID() }] });

  const removeDivider = (id: string) =>
    update({ menuCommands: menuCommands.filter((it) => !(isDivider(it) && it.id === id)) });

  // `gap` is the insertion position (0..length) in the original array coords.
  const reorder = (from: number, gap: number) => {
    const target = from < gap ? gap - 1 : gap;
    if (target === from) return;
    const next = [...menuCommands];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    update({ menuCommands: next });
  };

  return (
    <div className="prefs-overlay" onMouseDown={cancel}>
      <div className="prefs-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="prefs-sidebar">
          <div className="prefs-sidebar-title">偏好設定</div>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={`prefs-sidebar-item${category === c.id ? ' active' : ''}`}
              onClick={() => setCategory(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="prefs-body">
          <div className="prefs-body-scroll">
            {category === 'menu' && (
              <>
                <div
                  className="prefs-menu-list"
                  onDrop={() => {
                    if (dragIndex !== null && dropIndex !== null) reorder(dragIndex, dropIndex);
                    setDragIndex(null);
                    setDropIndex(null);
                    setDragEnabled(false);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setDropIndex(null);
                    setDragEnabled(false);
                  }}
                >
                  <div className="prefs-menu-list-hint">
                    拖曳調整順序，關閉則從右鍵選單隱藏。可直接編輯指令名稱，或插入分隔線分組。
                  </div>
                  {menuCommands.map((c, i) => {
                    const rowClass = `prefs-menu-row${dragIndex === i ? ' dragging' : ''}${
                      dropIndex === i ? ' drop-before' : ''
                    }${dropIndex === i + 1 ? ' drop-after' : ''}`;
                    const dragProps = {
                      className: rowClass,
                      draggable: dragEnabled,
                      onDragStart: () => setDragIndex(i),
                      onDragOver: (e: DragEvent) => {
                        e.preventDefault();
                        // Top half → insert before this row, bottom half → after.
                        const rect = e.currentTarget.getBoundingClientRect();
                        const after = e.clientY > rect.top + rect.height / 2;
                        setDropIndex(after ? i + 1 : i);
                      },
                    };
                    const handle = (
                      <span
                        className="prefs-drag-handle"
                        aria-hidden
                        onMouseDown={() => setDragEnabled(true)}
                        onMouseUp={() => setDragEnabled(false)}
                      >
                        ⠿
                      </span>
                    );
                    if (isDivider(c)) {
                      return (
                        <div key={c.id} {...dragProps}>
                          {handle}
                          <span className="prefs-menu-divider-line" />
                          <button
                            className="prefs-skill-delete"
                            onClick={() => removeDivider(c.id)}
                          >
                            刪除
                          </button>
                        </div>
                      );
                    }
                    return (
                      <div key={c.key} {...dragProps}>
                        {handle}
                        <input
                          className="prefs-menu-label-input"
                          value={c.label ?? MENU_LABELS.get(c.key) ?? c.key}
                          placeholder="輸入指令名稱"
                          onChange={(e) => setCommandLabel(c.key, e.target.value)}
                          onBlur={() => commitCommandLabel(c.key)}
                          onKeyDown={(e) => {
                            // Enter commits via blur; the blur handler validates.
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                          }}
                        />
                        <label className="prefs-switch">
                          <input
                            type="checkbox"
                            checked={c.visible !== false}
                            onChange={(e) => setCommandVisible(c.key, e.target.checked)}
                          />
                          <span className="prefs-switch-track" />
                        </label>
                      </div>
                    );
                  })}
                  <button className="prefs-divider-add" onClick={addDivider}>
                    ＋ 插入分隔線
                  </button>
                </div>
              </>
            )}

            {category === 'apikeys' && (
              <>
                <div className="prefs-field">
                  <label>OpenRouter API Key</label>
                  <input
                    type="password"
                    placeholder="輸入你的 OpenRouter API Key"
                    value={draft.openRouterApiKey}
                    onChange={(e) => update({ openRouterApiKey: e.target.value })}
                  />
                </div>

                <div className="prefs-field">
                  <label>OpenRouter Model Name</label>
                  <input
                    type="text"
                    placeholder="anthropic/claude-3.5-sonnet"
                    value={draft.openRouterModel}
                    onChange={(e) => update({ openRouterModel: e.target.value })}
                  />
                </div>

                <div className="prefs-section-divider" />

                <div className="prefs-field">
                  <label>Global Custom Instruction</label>
                  <textarea
                    rows={10}
                    placeholder="套用到每個 Skill 的全域指令（選填）"
                    value={draft.aiGlobalInstruction}
                    onChange={(e) => update({ aiGlobalInstruction: e.target.value })}
                  />
                </div>
              </>
            )}

          </div>

          <div className="prefs-actions">
            <button className="prefs-btn prefs-btn-secondary" onClick={cancel}>
              取消
            </button>
            <button className="prefs-btn prefs-btn-primary" onClick={confirm}>
              確定
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
