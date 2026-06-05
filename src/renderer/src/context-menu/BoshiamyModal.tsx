import { useState } from 'react';
import type { BoshiamyEntry } from './transforms';

interface Props {
  entries: BoshiamyEntry[];
  onClose: () => void;
}

export function BoshiamyModal({ entries, onClose }: Props): JSX.Element {
  const [copied, setCopied] = useState(false);

  // Copy the primary (建議) codes of all resolvable characters, space-joined —
  // i.e. "how to type this whole selection".
  const copyText = entries
    .map((e) => e.primary)
    .filter((c): c is string => c !== null)
    .join(' ');

  const copy = async () => {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable; ignore silently.
    }
  };

  return (
    <div className="ai-modal-overlay" onMouseDown={onClose}>
      <div className="ai-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ai-modal-title">嘸蝦米查碼</div>
        <div className="ai-modal-body boshiamy-list">
          {entries.map((e, i) => (
            <div className="boshiamy-row" key={i}>
              <span className="boshiamy-char">{e.char}</span>
              {e.primary === null ? (
                <span className="boshiamy-none">（查無此碼）</span>
              ) : (
                <span className="boshiamy-codes">
                  <span className="boshiamy-primary">{e.primary}</span>
                  {e.alternatives.map((alt, j) => (
                    <span className="boshiamy-alt" key={j}>
                      {alt}
                    </span>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="ai-modal-actions">
          <button className="prefs-btn prefs-btn-secondary" onClick={onClose}>
            關閉
          </button>
          <button className="prefs-btn prefs-btn-primary" onClick={copy} disabled={!copyText}>
            {copied ? '已複製' : '複製建議碼'}
          </button>
        </div>
      </div>
    </div>
  );
}
