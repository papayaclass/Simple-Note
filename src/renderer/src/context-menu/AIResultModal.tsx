export interface AIState {
  status: 'loading' | 'done' | 'error';
  skillName: string;
  range: { from: number; to: number };
  result?: string;
  reason?: string;
}

interface Props {
  editor: any;
  state: AIState;
  onClose: () => void;
}

export function AIResultModal({ editor, state, onClose }: Props): JSX.Element {
  const tipTap = editor._tiptapEditor;

  const replace = () => {
    tipTap
      .chain()
      .focus()
      .insertContentAt({ from: state.range.from, to: state.range.to }, state.result ?? '')
      .run();
    onClose();
  };

  const insertBelow = () => {
    tipTap
      .chain()
      .focus()
      .insertContentAt(state.range.to, '\n\n' + (state.result ?? ''))
      .run();
    onClose();
  };

  return (
    <div className="ai-modal-overlay" onMouseDown={onClose}>
      <div className="ai-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ai-modal-title">{state.skillName}</div>

        {state.status === 'loading' && <div className="ai-modal-status">AI 處理中…</div>}

        {state.status === 'error' && (
          <>
            <div className="ai-modal-error">{state.reason}</div>
            <div className="ai-modal-actions">
              <button className="prefs-btn prefs-btn-secondary" onClick={onClose}>
                關閉
              </button>
            </div>
          </>
        )}

        {state.status === 'done' && (
          <>
            <div className="ai-modal-body">{state.result}</div>
            <div className="ai-modal-actions">
              <button className="prefs-btn prefs-btn-secondary" onClick={onClose}>
                取消
              </button>
              <button className="prefs-btn prefs-btn-secondary" onClick={insertBelow}>
                插入到下方
              </button>
              <button className="prefs-btn prefs-btn-primary" onClick={replace}>
                取代選取文字
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
