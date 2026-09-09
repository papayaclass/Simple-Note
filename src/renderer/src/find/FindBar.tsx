import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  clearFind,
  matchCount,
  replaceAllMatches,
  replaceMatch,
  setActiveMatch,
  setFindQuery,
} from './findPlugin';

// Anything with an `_tiptapEditor` — the find plugin helpers only need the view.
type TargetEditor = unknown;

export interface FindBarHandle {
  // Re-focus + select the query field (Cmd+F while the bar is already open).
  focusQuery: () => void;
  // Replace the query with the given text (seeding from the selection).
  seed: (text: string) => void;
  next: () => void;
  prev: () => void;
}

interface Props {
  // The editors to search, in on-screen order. Re-read on every operation so
  // switching the column layout while the bar is open keeps working.
  getEditors: () => TargetEditor[];
  // Changes whenever the set of searched editors changes (column layout), so
  // the search re-runs against the newly visible columns.
  scopeKey: string;
  showReplace: boolean;
  onToggleReplace: (next: boolean) => void;
  onClose: () => void;
  handleRef: React.MutableRefObject<FindBarHandle | null>;
}

export function FindBar({
  getEditors,
  scopeKey,
  showReplace,
  onToggleReplace,
  onClose,
  handleRef,
}: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [total, setTotal] = useState(0);
  // Index of the highlighted hit across all searched editors, -1 when none.
  const [current, setCurrent] = useState(-1);
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  // Per-editor hit counts, in the same order as getEditors().
  const countsRef = useRef<number[]>([]);
  const currentRef = useRef(-1);
  currentRef.current = current;

  // Translate a global hit index into "editor N, its Mth hit" and light it up,
  // clearing the highlight in every other editor.
  const applyActive = useCallback(
    (globalIndex: number, scroll: boolean) => {
      const editors = getEditors();
      const counts = countsRef.current;
      let remaining = globalIndex;
      editors.forEach((editor, i) => {
        const count = counts[i] ?? 0;
        if (remaining >= 0 && remaining < count) {
          setActiveMatch(editor, remaining, scroll);
          remaining = -1;
        } else {
          setActiveMatch(editor, -1, false);
          if (remaining >= 0) remaining -= count;
        }
      });
    },
    [getEditors]
  );

  // Re-read the hit counts from the editors (they recompute themselves on every
  // document change) and report the new total.
  const recount = useCallback((): number => {
    const counts = getEditors().map((editor) => matchCount(editor));
    countsRef.current = counts;
    const sum = counts.reduce((a, b) => a + b, 0);
    setTotal(sum);
    return sum;
  }, [getEditors]);

  // Push a new query into every editor and jump to the first hit.
  const runSearch = useCallback(
    (nextQuery: string, nextCase: boolean, opts: { scroll?: boolean } = {}) => {
      const counts = getEditors().map((editor) => setFindQuery(editor, nextQuery, nextCase));
      countsRef.current = counts;
      const sum = counts.reduce((a, b) => a + b, 0);
      setTotal(sum);
      const next = sum > 0 ? 0 : -1;
      setCurrent(next);
      applyActive(next, opts.scroll ?? true);
    },
    [applyActive, getEditors]
  );

  const step = useCallback(
    (delta: number) => {
      const sum = recount();
      if (sum === 0) {
        setCurrent(-1);
        applyActive(-1, false);
        return;
      }
      const from = currentRef.current;
      const next = from < 0 ? (delta > 0 ? 0 : sum - 1) : (from + delta + sum) % sum;
      setCurrent(next);
      applyActive(next, true);
    },
    [applyActive, recount]
  );

  const doReplace = useCallback(() => {
    const editors = getEditors();
    const counts = countsRef.current;
    let remaining = currentRef.current;
    if (remaining < 0) {
      step(1);
      return;
    }
    for (let i = 0; i < editors.length; i += 1) {
      const count = counts[i] ?? 0;
      if (remaining < count) {
        if (!replaceMatch(editors[i], remaining, replacement)) return;
        break;
      }
      remaining -= count;
    }
    const sum = recount();
    if (sum === 0) {
      setCurrent(-1);
      applyActive(-1, false);
      return;
    }
    // Replacing shifts the following hits down into the slot we just vacated,
    // so the same index is already the next hit — unless the replacement text
    // contains the query itself, which would otherwise re-find what we just
    // wrote and never advance.
    const selfMatch = caseSensitive
      ? replacement.includes(query)
      : replacement.toLowerCase().includes(query.toLowerCase());
    let next = currentRef.current + (selfMatch ? 1 : 0);
    if (next >= sum) next = 0;
    setCurrent(next);
    applyActive(next, true);
  }, [applyActive, caseSensitive, getEditors, query, recount, replacement, step]);

  const doReplaceAll = useCallback(() => {
    getEditors().forEach((editor) => replaceAllMatches(editor, replacement));
    const sum = recount();
    const next = sum > 0 ? 0 : -1;
    setCurrent(next);
    applyActive(next, sum > 0);
  }, [applyActive, getEditors, recount, replacement]);

  const close = useCallback(() => {
    getEditors().forEach((editor) => clearFind(editor));
    onClose();
  }, [getEditors, onClose]);

  // Search as you type (and when the case-sensitivity toggle flips).
  useLayoutEffect(() => {
    runSearch(query, caseSensitive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, scopeKey]);

  // Editing the document while the bar is open keeps the counter honest.
  useEffect(() => {
    const timer = { id: 0 };
    const schedule = (): void => {
      window.clearTimeout(timer.id);
      timer.id = window.setTimeout(() => {
        const sum = recount();
        if (currentRef.current >= sum) {
          const next = sum > 0 ? sum - 1 : -1;
          setCurrent(next);
        }
      }, 200);
    };
    const offs = getEditors()
      .map((editor) => (editor as { onChange?: (cb: () => void) => (() => void) | undefined }).onChange?.(schedule))
      .filter((off): off is () => void => typeof off === 'function');
    return () => {
      window.clearTimeout(timer.id);
      offs.forEach((off) => off());
    };
  }, [getEditors, recount, scopeKey]);

  // Drop every highlight when the bar unmounts (tab closed, layout torn down).
  useEffect(() => {
    return () => {
      getEditors().forEach((editor) => clearFind(editor));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    handleRef.current = {
      focusQuery: () => {
        queryInputRef.current?.focus();
        queryInputRef.current?.select();
      },
      seed: (text: string) => {
        if (text && text !== query) setQuery(text);
      },
      next: () => step(1),
      prev: () => step(-1),
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, query, step]);

  useEffect(() => {
    queryInputRef.current?.focus();
    queryInputRef.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onFieldKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.currentTarget === replaceInputRef.current) doReplace();
      else step(e.shiftKey ? -1 : 1);
    }
  };

  const counterLabel = query === '' ? '' : total === 0 ? '沒有結果' : `${current + 1} / ${total}`;
  const disabled = total === 0;

  return (
    <div className="sn-find-dock">
      <div className="sn-find-bar" onKeyDownCapture={(e) => e.stopPropagation()}>
        <div className="sn-find-row">
          <button
            className="sn-find-disclosure"
            aria-label={showReplace ? '收合取代欄' : '展開取代欄'}
            data-open={showReplace ? 'true' : 'false'}
            onClick={() => onToggleReplace(!showReplace)}
          >
            <ChevronRight />
          </button>
          <div className="sn-find-field">
            <input
              ref={queryInputRef}
              value={query}
              placeholder="尋找"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onFieldKeyDown}
            />
            <span className="sn-find-counter">{counterLabel}</span>
          </div>
          <button
            className="sn-find-btn sn-find-toggle"
            data-on={caseSensitive ? 'true' : 'false'}
            title="區分大小寫"
            aria-label="區分大小寫"
            onClick={() => setCaseSensitive((v) => !v)}
          >
            Aa
          </button>
          <button
            className="sn-find-btn"
            title="上一筆"
            aria-label="上一筆"
            disabled={disabled}
            onClick={() => step(-1)}
          >
            <ChevronUp />
          </button>
          <button
            className="sn-find-btn"
            title="下一筆"
            aria-label="下一筆"
            disabled={disabled}
            onClick={() => step(1)}
          >
            <ChevronDown />
          </button>
          <button className="sn-find-btn" title="關閉" aria-label="關閉" onClick={close}>
            <CloseIcon />
          </button>
        </div>

        {showReplace && (
          <div className="sn-find-row">
            <span className="sn-find-disclosure-spacer" />
            <div className="sn-find-field">
              <input
                ref={replaceInputRef}
                value={replacement}
                placeholder="取代為"
                spellCheck={false}
                onChange={(e) => setReplacement(e.target.value)}
                onKeyDown={onFieldKeyDown}
              />
            </div>
            <button className="sn-find-text-btn" disabled={disabled} onClick={doReplace}>
              取代
            </button>
            <button className="sn-find-text-btn" disabled={disabled} onClick={doReplaceAll}>
              全部取代
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChevronRight(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function ChevronUp(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 15l6-6 6 6" />
    </svg>
  );
}

function ChevronDown(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}
