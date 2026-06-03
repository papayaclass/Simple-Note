import { useState } from 'react';

interface Props {
  original: string;
  pinyin: string;
  onClose: () => void;
}

export function PinyinModal({ original, pinyin, onClose }: Props): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pinyin);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; ignore silently.
    }
  };

  return (
    <div className="ai-modal-overlay" onMouseDown={onClose}>
      <div className="ai-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ai-modal-title">拼音查詢</div>
        <div className="pinyin-modal-original">{original}</div>
        <div className="ai-modal-body">{pinyin}</div>
        <div className="ai-modal-actions">
          <button className="prefs-btn prefs-btn-secondary" onClick={onClose}>
            關閉
          </button>
          <button className="prefs-btn prefs-btn-primary" onClick={copy}>
            {copied ? '已複製' : '複製'}
          </button>
        </div>
      </div>
    </div>
  );
}
