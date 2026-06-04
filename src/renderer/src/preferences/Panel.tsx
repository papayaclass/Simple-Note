import { useEffect, useState, DragEvent } from 'react';
import { useStore, Preferences } from '../store';
import { MENU_COMMANDS, reconcileMenuCommands, isDivider } from '../context-menu/commands';

type Category = 'layout' | 'menu' | 'ai';

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'layout', label: '版面調整' },
  { id: 'menu', label: '右鍵選單' },
  { id: 'ai', label: 'AI 技能' },
];

const MENU_LABELS = new Map(MENU_COMMANDS.map((c) => [c.key, c.label]));

export function PreferencesPanel(): JSX.Element | null {
  const open = useStore((s) => s.prefsPanelOpen);
  const setOpen = useStore((s) => s.setPrefsPanelOpen);
  const committedPrefs = useStore((s) => s.preferences);
  const setPrefs = useStore((s) => s.setPreferences);

  const [draft, setDraft] = useState<Preferences>(committedPrefs);
  const [category, setCategory] = useState<Category>('layout');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // Gap index (0..length) where the dragged row would land if dropped now.
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Rows are only draggable while the drag handle is held, so the editable
  // label inputs remain clickable (a draggable parent would steal the click).
  const [dragEnabled, setDragEnabled] = useState(false);

  // Re-seed draft each time the panel opens with the latest committed prefs,
  // and apply draft to the live page while editing so changes are visible.
  useEffect(() => {
    if (open) {
      setDraft(committedPrefs);
      setPrefs(committedPrefs);
      setCategory('layout');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    setPrefs(draft);
  }, [draft, open, setPrefs]);

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

  const cancel = () => {
    setPrefs(committedPrefs); // revert live preview
    setOpen(false);
  };
  const confirm = () => {
    setPrefs(draft);
    window.api.prefs.setAll(draft as unknown as Record<string, unknown>);
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
            {category === 'layout' && (
              <>
                <Slider
                  label="頁面寬度"
                  value={draft.pageWidth}
                  min={480}
                  max={1200}
                  step={20}
                  unit="px"
                  onChange={(v) => update({ pageWidth: v })}
                />
                <Slider
                  label="雙欄頁寬"
                  value={draft.twoColumnPageWidth}
                  min={600}
                  max={1600}
                  step={20}
                  unit="px"
                  onChange={(v) => update({ twoColumnPageWidth: v })}
                />
                <Slider
                  label="段落間距"
                  value={draft.paragraphSpacing}
                  min={0}
                  max={32}
                  step={1}
                  unit="px"
                  onChange={(v) => update({ paragraphSpacing: v })}
                />
                <Slider
                  label="上方留白"
                  value={draft.topPadding}
                  min={0}
                  max={200}
                  step={4}
                  unit="px"
                  onChange={(v) => update({ topPadding: v })}
                />
              </>
            )}

            {category === 'menu' && (
              <>
                <div className="prefs-field">
                  <label>ExchangeRate-API Key</label>
                  <input
                    type="password"
                    placeholder="輸入你的 API Key"
                    value={draft.exchangeRateApiKey}
                    onChange={(e) => update({ exchangeRateApiKey: e.target.value })}
                  />
                </div>

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

            {category === 'ai' && (
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
                  <label>Model Name</label>
                  <input
                    type="text"
                    placeholder="anthropic/claude-3.5-sonnet"
                    value={draft.openRouterModel}
                    onChange={(e) => update({ openRouterModel: e.target.value })}
                  />
                </div>

                <div className="prefs-field">
                  <label>Global Custom Instruction</label>
                  <textarea
                    rows={3}
                    placeholder="套用到每個 Skill 的全域指令（選填）"
                    value={draft.aiGlobalInstruction}
                    onChange={(e) => update({ aiGlobalInstruction: e.target.value })}
                  />
                </div>

                <div className="prefs-skills">
                  <div className="prefs-skills-header">
                    <strong>AI Skills</strong>
                    <button
                      className="prefs-skill-add"
                      onClick={() =>
                        update({
                          aiSkills: [
                            ...draft.aiSkills,
                            { id: crypto.randomUUID(), name: '', prompt: '' },
                          ],
                        })
                      }
                    >
                      ＋ 新增 Skill
                    </button>
                  </div>

                  {draft.aiSkills.length === 0 && (
                    <p className="prefs-skills-empty">尚未建立任何 Skill。</p>
                  )}

                  {draft.aiSkills.map((skill) => (
                    <div className="prefs-skill-card" key={skill.id}>
                      <div className="prefs-skill-card-top">
                        <input
                          type="text"
                          className="prefs-skill-name"
                          placeholder="Skill 名稱"
                          value={skill.name}
                          onChange={(e) =>
                            update({
                              aiSkills: draft.aiSkills.map((s) =>
                                s.id === skill.id ? { ...s, name: e.target.value } : s
                              ),
                            })
                          }
                        />
                        <button
                          className="prefs-skill-delete"
                          onClick={() =>
                            update({ aiSkills: draft.aiSkills.filter((s) => s.id !== skill.id) })
                          }
                        >
                          刪除
                        </button>
                      </div>
                      <textarea
                        rows={3}
                        className="prefs-skill-prompt"
                        placeholder="提示詞（反白文字會自動附加在末端）"
                        value={skill.prompt}
                        onChange={(e) =>
                          update({
                            aiSkills: draft.aiSkills.map((s) =>
                              s.id === skill.id ? { ...s, prompt: e.target.value } : s
                            ),
                          })
                        }
                      />
                    </div>
                  ))}
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

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step, unit, onChange }: SliderProps): JSX.Element {
  return (
    <div className="prefs-field">
      <label>
        <span>{label}</span>
        <span className="prefs-value">
          {Number.isInteger(value) ? value : value.toFixed(2)} {unit}
        </span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}
