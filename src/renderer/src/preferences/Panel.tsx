import { useEffect, useState } from 'react';
import { useStore, Preferences } from '../store';

export function PreferencesPanel(): JSX.Element | null {
  const open = useStore((s) => s.prefsPanelOpen);
  const setOpen = useStore((s) => s.setPrefsPanelOpen);
  const committedPrefs = useStore((s) => s.preferences);
  const setPrefs = useStore((s) => s.setPreferences);

  const [draft, setDraft] = useState<Preferences>(committedPrefs);

  // Re-seed draft each time the panel opens with the latest committed prefs,
  // and apply draft to the live page while editing so changes are visible.
  useEffect(() => {
    if (open) {
      setDraft(committedPrefs);
      setPrefs(committedPrefs);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    setPrefs(draft);
  }, [draft, open, setPrefs]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!open) return;
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') confirm();
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

  return (
    <div className="prefs-overlay" onMouseDown={cancel}>
      <div className="prefs-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="prefs-header">
          <span>偏好設定</span>
        </div>

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

        <div className="prefs-field">
          <label>ExchangeRate-API Key</label>
          <input
            type="password"
            placeholder="輸入你的 API Key"
            value={draft.exchangeRateApiKey}
            onChange={(e) => update({ exchangeRateApiKey: e.target.value })}
          />
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
