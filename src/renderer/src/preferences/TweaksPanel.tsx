import { PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react';
import { useStore, Preferences } from '../store';
import './tweaks.css';

// 「微調面板」：版面相關的滑桿。刻意做成浮在文件上方、可拖曳與縮放的面板，而不是偏好設定
// 的一個分頁，因為這些數值要一邊看著實際畫面一邊拉。改動即時生效並直接存檔，不走偏好設定
// 的取消／確定流程。

type NumericKey = {
  [K in keyof Preferences]: Preferences[K] extends number ? K : never;
}[keyof Preferences];

interface SliderDef {
  key: NumericKey;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const GROUPS: { title: string; sliders: SliderDef[] }[] = [
  {
    title: '版面',
    sliders: [
      { key: 'pageWidth', label: '頁面寬度', min: 480, max: 1200, step: 20, unit: 'px' },
      { key: 'paragraphSpacing', label: '段落間距', min: 0, max: 32, step: 1, unit: 'px' },
      { key: 'listMarkerGap', label: '清單符號間距', min: 0, max: 32, step: 1, unit: 'px' },
      { key: 'topPadding', label: '上方留白', min: 0, max: 200, step: 4, unit: 'px' },
    ],
  },
  {
    title: '標題大小',
    sliders: [
      { key: 'heading1Scale', label: '標題一', min: 1, max: 3, step: 0.05, unit: '×' },
      { key: 'heading2Scale', label: '標題二', min: 1, max: 3, step: 0.05, unit: '×' },
      { key: 'heading3Scale', label: '標題三', min: 1, max: 3, step: 0.05, unit: '×' },
    ],
  },
];

const MARGIN = 12;

export function TweaksPanel(): JSX.Element | null {
  const open = useStore((s) => s.tweaksPanelOpen);
  const setOpen = useStore((s) => s.setTweaksPanelOpen);
  const prefs = useStore((s) => s.preferences);
  const setPrefs = useStore((s) => s.setPreferences);
  const panelRef = useRef<HTMLDivElement>(null);
  // null = not placed yet; the panel opens docked to the top-right corner.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const update = (key: NumericKey, value: number) => {
    setPrefs({ [key]: value });
    void window.api.prefs.set(key, value);
  };

  // Drag by the header. Clamp so the header can never leave the window.
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    const header = e.currentTarget;
    header.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const maxLeft = window.innerWidth - rect.width - MARGIN;
      const maxTop = window.innerHeight - 48;
      setPos({
        left: Math.min(Math.max(MARGIN, ev.clientX - dx), Math.max(MARGIN, maxLeft)),
        top: Math.min(Math.max(MARGIN, ev.clientY - dy), maxTop),
      });
    };
    const up = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
  };

  const style = pos ? { left: pos.left, top: pos.top } : { right: 24, top: 64 };

  return (
    <div
      ref={panelRef}
      className="tweaks-panel"
      style={style}
      role="dialog"
      aria-label="微調面板"
    >
      <div className="tweaks-header" onPointerDown={startDrag}>
        <span className="tweaks-title">微調面板</span>
        <button className="tweaks-close" aria-label="關閉" onClick={() => setOpen(false)}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="tweaks-body">
        {GROUPS.map((g) => (
          <section key={g.title} className="tweaks-group">
            <h3 className="tweaks-group-title">{g.title}</h3>
            <div className="tweaks-grid">
              {g.sliders.map((s) => {
                const value = prefs[s.key];
                return (
                  <label key={s.key} className="tweaks-field">
                    <span className="tweaks-field-row">
                      <span>{s.label}</span>
                      <span className="tweaks-value">
                        {Number.isInteger(value) ? value : value.toFixed(2)} {s.unit}
                      </span>
                    </span>
                    <input
                      type="range"
                      min={s.min}
                      max={s.max}
                      step={s.step}
                      value={value}
                      onChange={(e) => update(s.key, Number(e.target.value))}
                    />
                  </label>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
