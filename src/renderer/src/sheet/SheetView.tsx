import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { DocumentViewHandle, registerDocumentView } from '../DocumentView';
import { isPathInVault, rememberLastEditedFile } from '../fileActions';
import {
  cellKey,
  colName,
  createEvaluator,
  formatNumber,
  formatValue,
  FormulaError,
  formulaRanges,
  isFormula,
  MAX_COLS,
  MAX_ROWS,
  shiftForStructure,
  shiftRelative,
  Val,
} from './formula';
import {
  Cell,
  EMPTY_SHEET,
  lossySheetFeatures,
  parseCsv,
  parseSheetContent,
  serializeCsv,
  serializeSsheet,
  SHEET_COLORS,
  SheetColor,
  SheetData,
  sheetSource,
  toTsv,
  usedExtent,
  withSsheetExt,
} from './sheetFormat';
import './sheet.css';

const ROW_H = 26;
const HEAD_H = 26;
const ROWHEAD_W = 52;
const DEFAULT_COL_W = 110;
const MIN_COL_W = 36;
const OVERSCAN = 6;
const UNDO_LIMIT = 200;

interface Pos {
  r: number;
  c: number;
}

interface Selection {
  // The active cell (what gets edited) …
  a: Pos;
  // … and the far corner of the selected range.
  f: Pos;
}

interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

type StyleFlag = 'b' | 'i' | 'u' | 's';

function rangeOf(sel: Selection): Range {
  return {
    r1: Math.min(sel.a.r, sel.f.r),
    c1: Math.min(sel.a.c, sel.f.c),
    r2: Math.max(sel.a.r, sel.f.r),
    c2: Math.max(sel.a.c, sel.f.c),
  };
}

function inRange(p: Pos, rg: Range): boolean {
  return p.r >= rg.r1 && p.r <= rg.r2 && p.c >= rg.c1 && p.c <= rg.c2;
}

function rangeLabel(rg: Range): string {
  const start = cellKey(rg.r1, rg.c1);
  return rg.r1 === rg.r2 && rg.c1 === rg.c2 ? start : `${start}:${cellKey(rg.r2, rg.c2)}`;
}

// Drop empty flags so the file stays tidy; null when nothing is left.
function tidy(cell: Cell): Cell | null {
  const out: Cell = {};
  if (cell.v) out.v = cell.v;
  if (cell.b) out.b = true;
  if (cell.i) out.i = true;
  if (cell.u) out.u = true;
  if (cell.s) out.s = true;
  if (cell.color) out.color = cell.color;
  if (cell.fill) out.fill = cell.fill;
  return Object.keys(out).length > 0 ? out : null;
}

function patchCells(
  cells: Record<string, Cell>,
  rg: Range,
  patch: (cell: Cell) => Cell
): Record<string, Cell> {
  const next = { ...cells };
  for (let r = rg.r1; r <= rg.r2; r += 1) {
    for (let c = rg.c1; c <= rg.c2; c += 1) {
      const key = cellKey(r, c);
      const cell = tidy(patch(next[key] ?? {}));
      if (cell) next[key] = cell;
      else delete next[key];
    }
  }
  return next;
}

// Insert (count > 0) or delete (count < 0) rows/columns at `at`, rewriting
// every formula that points across the change.
function restructure(data: SheetData, axis: 'row' | 'col', at: number, count: number): SheetData {
  const cells: Record<string, Cell> = {};
  for (const [key, cell] of Object.entries(data.cells)) {
    const m = /^([A-Z]+)(\d+)$/.exec(key);
    if (!m) continue;
    let r = Number(m[2]) - 1;
    let c = colIndexOf(m[1]!);
    const idx = axis === 'row' ? r : c;
    if (count < 0 && idx >= at && idx < at - count) continue;
    if (idx >= at) {
      if (axis === 'row') r += count;
      else c += count;
    }
    const v = cell.v && isFormula(cell.v) ? shiftForStructure(cell.v, axis, at, count) : cell.v;
    cells[cellKey(r, c)] = v === cell.v ? cell : { ...cell, v };
  }
  let colWidths = data.colWidths;
  if (axis === 'col') {
    colWidths = {};
    for (const [k, w] of Object.entries(data.colWidths)) {
      const c = Number(k);
      if (count < 0 && c >= at && c < at - count) continue;
      colWidths[c >= at ? c + count : c] = w;
    }
  }
  return { cells, colWidths };
}

function colIndexOf(name: string): number {
  let n = 0;
  for (const ch of name) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// In-app clipboard: remembers the raw cells behind the last copy so a paste
// back into the sheet keeps formulas (shifted) and styling, not just text.
let sheetClipboard: { text: string; origin: Pos; cells: Array<Array<Cell | undefined>> } | null =
  null;

// Formula entry is at a spot where clicking a cell should insert its address.
function canInsertRef(text: string, caret: number): boolean {
  if (!isFormula(text) && text !== '=') return false;
  const before = text.slice(0, caret).trimEnd();
  return /[=(,+\-*/^&<>:]$/.test(before);
}

// Physical-key match (the app convention — Option rewrites e.key on macOS),
// falling back to e.key only for synthetic events that carry no code.
function isKey(e: React.KeyboardEvent, letter: string): boolean {
  return e.code ? e.code === `Key${letter}` : e.key.toUpperCase() === letter;
}

let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 8;
  measureCtx.font =
    "13px -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang TC', sans-serif";
  return measureCtx.measureText(text).width;
}

interface Props {
  tabId: string;
  active: boolean;
}

export function SheetView({ tabId, active }: Props): JSX.Element {
  const setTabDirty = useStore((s) => s.setTabDirty);
  const setTabFile = useStore((s) => s.setTabFile);
  const updateTab = useStore((s) => s.updateTab);

  const [data, setData] = useState<SheetData>(EMPTY_SHEET);
  const dataRef = useRef(data);
  dataRef.current = data;
  const undoRef = useRef<SheetData[]>([]);
  const redoRef = useRef<SheetData[]>([]);

  const [sel, setSel] = useState<Selection>({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } });
  const selRef = useRef(sel);
  selRef.current = sel;
  const [editing, setEditing] = useState<null | { mode: 'enter' | 'edit' }>(null);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState({ top: 0, left: 0, w: 1200, h: 900 });
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [resizing, setResizing] = useState<{ c: number; w: number } | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const cellsRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const barRef = useRef<HTMLInputElement | null>(null);
  const autoSaveTimer = useRef<number | null>(null);
  const initialAutoFocus = useRef(
    active && (useStore.getState().tabs.find((t) => t.id === tabId)?.autoFocus ?? true)
  );
  const firstActiveRun = useRef(true);
  // Cell-address insertion while typing a formula: where the inserted text sits.
  const refPick = useRef<{ start: number; len: number; from: Pos } | null>(null);

  // ---------------------------------------------------------------------------
  // Geometry
  // ---------------------------------------------------------------------------

  const extent = useMemo(() => usedExtent(data.cells), [data.cells]);
  const range = rangeOf(sel);
  // The grid always runs a margin past the data, the cursor and the scroll
  // position. (Whole-row/column selections only need to fit, not add margin,
  // or every header click would grow the grid.)
  const rowCount = Math.min(
    MAX_ROWS,
    Math.max(
      100,
      extent.rows + 50,
      sel.a.r + 50,
      range.r2 + 1,
      Math.ceil((view.top + view.h) / ROW_H) + 30
    )
  );
  const colCount = Math.min(MAX_COLS, Math.max(26, extent.cols + 5, sel.a.c + 5, range.c2 + 1));

  const colWidth = useCallback(
    (c: number): number =>
      resizing && resizing.c === c ? resizing.w : (data.colWidths[c] ?? DEFAULT_COL_W),
    [data.colWidths, resizing]
  );

  // colX[c] = left edge of column c inside the cell area; colX[colCount] = total.
  const colX = useMemo(() => {
    const xs = new Array<number>(colCount + 1);
    xs[0] = 0;
    for (let c = 0; c < colCount; c += 1) xs[c + 1] = xs[c]! + colWidth(c);
    return xs;
  }, [colCount, colWidth]);

  const bodyW = colX[colCount]!;
  const bodyH = rowCount * ROW_H;

  const colAtX = useCallback(
    (x: number): number => {
      let lo = 0;
      let hi = colCount - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (colX[mid]! <= x) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [colCount, colX]
  );

  const visibleRows = {
    from: Math.max(0, Math.floor(view.top / ROW_H) - OVERSCAN),
    to: Math.min(rowCount - 1, Math.ceil((view.top + view.h) / ROW_H) + OVERSCAN),
  };
  const visibleCols = {
    from: Math.max(0, colAtX(view.left) - 1),
    to: Math.min(colCount - 1, colAtX(view.left + view.w) + 1),
  };

  const value = useMemo(() => createEvaluator(sheetSource(data.cells)), [data.cells]);

  // ---------------------------------------------------------------------------
  // Scroll tracking
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const read = (): void => {
      frame = 0;
      setView({
        top: el.scrollTop,
        left: el.scrollLeft,
        w: el.clientWidth - ROWHEAD_W,
        h: el.clientHeight - HEAD_H,
      });
    };
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    read();
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const scrollIntoView = useCallback(
    (p: Pos) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = p.r * ROW_H;
      const bottom = top + ROW_H;
      const viewH = el.clientHeight - HEAD_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + viewH) el.scrollTop = bottom - viewH;
      const left = colX[p.c] ?? 0;
      const right = left + colWidth(p.c);
      const viewW = el.clientWidth - ROWHEAD_W;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + viewW) el.scrollLeft = Math.min(left, right - viewW);
    },
    [colX, colWidth]
  );

  // ---------------------------------------------------------------------------
  // Saving (mirrors DocumentView: vault files auto-save, others mark dirty)
  // ---------------------------------------------------------------------------

  const tabNow = useCallback(() => useStore.getState().tabs.find((t) => t.id === tabId), [tabId]);

  const save = useCallback(async (): Promise<boolean> => {
    const tab = tabNow();
    if (!tab) return false;
    const d = dataRef.current;
    const r = await window.api.file.save(
      { markdown: serializeCsv(d), snote: serializeSsheet(d) },
      { path: tab.filePath, suggestedName: withSsheetExt(tab.fileName) }
    );
    if (!r.ok || !r.path) return false;
    const cur = tabNow();
    if (cur?.filePath !== r.path) setTabFile(tabId, r.path);
    else if (cur?.dirty) setTabDirty(tabId, false);
    rememberLastEditedFile(r.path);
    return true;
  }, [setTabDirty, setTabFile, tabId, tabNow]);
  const saveRef = useRef(save);
  saveRef.current = save;

  const cancelPendingAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
  }, []);

  const flushAutoSave = useCallback(() => {
    if (autoSaveTimer.current) {
      cancelPendingAutoSave();
      void saveRef.current();
    }
  }, [cancelPendingAutoSave]);

  const markChanged = useCallback(() => {
    const tab = tabNow();
    if (!tab) return;
    if (isPathInVault(tab.filePath)) {
      cancelPendingAutoSave();
      autoSaveTimer.current = window.setTimeout(() => {
        autoSaveTimer.current = null;
        void saveRef.current();
      }, 600);
    } else if (!tab.dirty) {
      setTabDirty(tabId, true);
    }
  }, [cancelPendingAutoSave, setTabDirty, tabId, tabNow]);

  useEffect(() => {
    if (!active) flushAutoSave();
  }, [active, flushAutoSave]);
  useEffect(() => () => flushAutoSave(), [flushAutoSave]);

  // Every edit goes through here so it lands on the undo stack.
  const apply = useCallback(
    (updater: (d: SheetData) => SheetData) => {
      const prev = dataRef.current;
      const next = updater(prev);
      if (next === prev) return;
      undoRef.current.push(prev);
      if (undoRef.current.length > UNDO_LIMIT) undoRef.current.shift();
      redoRef.current = [];
      dataRef.current = next;
      setData(next);
      markChanged();
    },
    [markChanged]
  );

  const undo = useCallback(
    (redo = false) => {
      const from = redo ? redoRef.current : undoRef.current;
      const to = redo ? undoRef.current : redoRef.current;
      const snapshot = from.pop();
      if (!snapshot) return;
      to.push(dataRef.current);
      dataRef.current = snapshot;
      setData(snapshot);
      markChanged();
    },
    [markChanged]
  );

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  const loadText = useCallback((text: string) => {
    const next = parseSheetContent(text);
    undoRef.current = [];
    redoRef.current = [];
    dataRef.current = next;
    setData(next);
    setSel({ a: { r: 0, c: 0 }, f: { r: 0, c: 0 } });
    setEditing(null);
  }, []);

  useEffect(() => {
    const tab = tabNow();
    if (!tab) return;
    const finish = (): void => {
      const loaded = tabNow();
      const restoreDirty = loaded?.restoreDirtyAfterLoad;
      setTabDirty(tabId, restoreDirty ?? false);
      if (restoreDirty !== undefined) updateTab(tabId, { restoreDirtyAfterLoad: undefined });
    };
    if (tab.initialMarkdown != null) {
      const text = tab.initialMarkdown;
      updateTab(tabId, { initialMarkdown: undefined });
      loadText(text);
      finish();
    } else if (tab.filePath) {
      void window.api.vault.read(tab.filePath).then((r) => {
        if (r.ok && r.content != null) loadText(r.content);
        finish();
      });
    } else {
      finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const focusGrid = useCallback(() => {
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  }, []);

  useEffect(() => {
    if (initialAutoFocus.current) focusGrid();
  }, [focusGrid]);

  useEffect(() => {
    if (firstActiveRun.current) {
      firstActiveRun.current = false;
      return;
    }
    if (active) focusGrid();
  }, [active, focusGrid]);

  // ---------------------------------------------------------------------------
  // Selection & editing
  // ---------------------------------------------------------------------------

  const rawAt = useCallback((p: Pos): string => data.cells[cellKey(p.r, p.c)]?.v ?? '', [data]);

  const select = useCallback(
    (a: Pos, f: Pos = a, reveal = true) => {
      const clamp = (p: Pos): Pos => ({
        r: Math.max(0, Math.min(MAX_ROWS - 1, p.r)),
        c: Math.max(0, Math.min(MAX_COLS - 1, p.c)),
      });
      const next = { a: clamp(a), f: clamp(f) };
      setSel(next);
      if (reveal) requestAnimationFrame(() => scrollIntoView(next.f));
    },
    [scrollIntoView]
  );

  const beginEdit = useCallback(
    (mode: 'enter' | 'edit', initial?: string) => {
      setDraft(initial ?? rawAt(selRef.current.a));
      setEditing({ mode });
      refPick.current = null;
    },
    [rawAt]
  );

  // Write the draft into the active cell and (optionally) move the cursor.
  const commitEdit = useCallback(
    (move?: [number, number]) => {
      if (!editing) return;
      const a = selRef.current.a;
      const key = cellKey(a.r, a.c);
      const text = draft;
      if ((dataRef.current.cells[key]?.v ?? '') !== text) {
        apply((d) => {
          const cell = tidy({ ...(d.cells[key] ?? {}), v: text });
          const cells = { ...d.cells };
          if (cell) cells[key] = cell;
          else delete cells[key];
          return { ...d, cells };
        });
      }
      setEditing(null);
      setDraft('');
      refPick.current = null;
      if (move) select({ r: a.r + move[0], c: a.c + move[1] });
      focusGrid();
    },
    [apply, draft, editing, focusGrid, select]
  );
  const commitRef = useRef(commitEdit);
  commitRef.current = commitEdit;

  const cancelEdit = useCallback(() => {
    setEditing(null);
    setDraft('');
    refPick.current = null;
    focusGrid();
  }, [focusGrid]);

  const moveBy = useCallback(
    (dr: number, dc: number, extend: boolean) => {
      const s = selRef.current;
      if (extend) select(s.a, { r: s.f.r + dr, c: s.f.c + dc });
      else select({ r: s.a.r + dr, c: s.a.c + dc });
    },
    [select]
  );

  // ---------------------------------------------------------------------------
  // Range operations
  // ---------------------------------------------------------------------------

  const toggleStyle = useCallback(
    (flag: StyleFlag) => {
      const rg = rangeOf(selRef.current);
      apply((d) => {
        let allOn = true;
        outer: for (let r = rg.r1; r <= rg.r2; r += 1) {
          for (let c = rg.c1; c <= rg.c2; c += 1) {
            if (!d.cells[cellKey(r, c)]?.[flag]) {
              allOn = false;
              break outer;
            }
          }
        }
        return { ...d, cells: patchCells(d.cells, rg, (cell) => ({ ...cell, [flag]: !allOn })) };
      });
    },
    [apply]
  );

  const setColor = useCallback(
    (prop: 'color' | 'fill', color: SheetColor | undefined) => {
      const rg = rangeOf(selRef.current);
      apply((d) => ({ ...d, cells: patchCells(d.cells, rg, (cell) => ({ ...cell, [prop]: color })) }));
    },
    [apply]
  );

  const clearContents = useCallback(() => {
    const rg = rangeOf(selRef.current);
    apply((d) => ({ ...d, cells: patchCells(d.cells, rg, (cell) => ({ ...cell, v: undefined })) }));
  }, [apply]);

  const clearFormats = useCallback(() => {
    const rg = rangeOf(selRef.current);
    apply((d) => ({ ...d, cells: patchCells(d.cells, rg, (cell) => ({ v: cell.v })) }));
  }, [apply]);

  const insertOrDelete = useCallback(
    (axis: 'row' | 'col', mode: 'insert' | 'delete') => {
      const rg = rangeOf(selRef.current);
      const at = axis === 'row' ? rg.r1 : rg.c1;
      const n = axis === 'row' ? rg.r2 - rg.r1 + 1 : rg.c2 - rg.c1 + 1;
      apply((d) => restructure(d, axis, at, mode === 'insert' ? n : -n));
      if (mode === 'delete') {
        const a = selRef.current.a;
        select(a, a, false);
      }
    },
    [apply, select]
  );

  const copySelection = useCallback((): string => {
    const rg = rangeOf(selRef.current);
    const { rows, cols } = usedExtent(dataRef.current.cells);
    // Whole rows/columns: only copy up to the data, not thousands of blanks.
    const r2 = Math.min(rg.r2, Math.max(rg.r1, rows - 1));
    const c2 = Math.min(rg.c2, Math.max(rg.c1, cols - 1));
    const text: string[][] = [];
    const cells: Array<Array<Cell | undefined>> = [];
    for (let r = rg.r1; r <= r2; r += 1) {
      const t: string[] = [];
      const cs: Array<Cell | undefined> = [];
      for (let c = rg.c1; c <= c2; c += 1) {
        t.push(formatValue(value(r, c)));
        cs.push(dataRef.current.cells[cellKey(r, c)]);
      }
      text.push(t);
      cells.push(cs);
    }
    const tsv = toTsv(text);
    sheetClipboard = { text: tsv, origin: { r: rg.r1, c: rg.c1 }, cells };
    return tsv;
  }, [value]);

  const pasteText = useCallback(
    (text: string, valuesOnly = false) => {
      const rg = rangeOf(selRef.current);
      const internal = !valuesOnly && sheetClipboard && sheetClipboard.text === text;
      const block: Array<Array<Cell | undefined>> = internal
        ? sheetClipboard!.cells
        : parseCsv(text.replace(/\r?\n$/, ''), '\t').map((row) => row.map((v) => ({ v })));
      if (block.length === 0) return;
      const h = block.length;
      const w = Math.max(...block.map((row) => row.length));
      // A single copied cell fills the whole selection (quick fill-down).
      const single = h === 1 && w === 1;
      const target: Range = single
        ? rg
        : { r1: rg.r1, c1: rg.c1, r2: rg.r1 + h - 1, c2: rg.c1 + w - 1 };
      const origin = internal ? sheetClipboard!.origin : null;
      apply((d) => {
        const cells = { ...d.cells };
        for (let r = target.r1; r <= target.r2; r += 1) {
          for (let c = target.c1; c <= target.c2; c += 1) {
            const src = single ? block[0]![0] : block[r - target.r1]?.[c - target.c1];
            const key = cellKey(r, c);
            let cell: Cell | null = src ? { ...src } : {};
            if (cell.v && origin && isFormula(cell.v)) {
              const sr = single ? origin.r : origin.r + (r - target.r1);
              const sc = single ? origin.c : origin.c + (c - target.c1);
              cell.v = shiftRelative(cell.v, r - sr, c - sc);
            }
            if (!internal) cell = { ...(d.cells[key] ?? {}), v: cell.v };
            const t = tidy(cell);
            if (t) cells[key] = t;
            else delete cells[key];
          }
        }
        return { ...d, cells };
      });
      select({ r: target.r1, c: target.c1 }, { r: target.r2, c: target.c2 }, false);
    },
    [apply, select]
  );

  const copyToClipboard = useCallback(() => {
    window.api.clipboard.writeText(copySelection());
  }, [copySelection]);

  const cutToClipboard = useCallback(() => {
    copyToClipboard();
    clearContents();
  }, [clearContents, copyToClipboard]);

  const pasteFromClipboard = useCallback(
    (valuesOnly = false) => {
      const text = window.api.clipboard.readText();
      if (text) pasteText(text, valuesOnly);
    },
    [pasteText]
  );

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  const onStyleShortcut = useCallback(
    (e: React.KeyboardEvent): boolean => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta || e.altKey) return false;
      const flag: StyleFlag | null =
        !e.shiftKey && isKey(e, 'B')
          ? 'b'
          : !e.shiftKey && isKey(e, 'I')
            ? 'i'
            : !e.shiftKey && isKey(e, 'U')
              ? 'u'
              : e.shiftKey && isKey(e, 'S')
                ? 's'
                : null;
      if (!flag) return false;
      e.preventDefault();
      toggleStyle(flag);
      return true;
    },
    [toggleStyle]
  );

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Let an input method (注音、倉頡…) finish composing first.
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      const meta = e.metaKey || e.ctrlKey;
      if (onStyleShortcut(e)) return;

      if (editing) {
        if (e.key === 'Enter') {
          e.preventDefault();
          commitEdit([e.shiftKey ? -1 : 1, 0]);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commitEdit([0, e.shiftKey ? -1 : 1]);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelEdit();
        } else if (editing.mode === 'enter' && !meta && e.key.startsWith('Arrow')) {
          e.preventDefault();
          const d: Record<string, [number, number]> = {
            ArrowUp: [-1, 0],
            ArrowDown: [1, 0],
            ArrowLeft: [0, -1],
            ArrowRight: [0, 1],
          };
          commitEdit(d[e.key]);
        }
        return;
      }

      const s = selRef.current;
      const page = Math.max(1, Math.floor(view.h / ROW_H) - 1);
      switch (e.key) {
        case 'ArrowUp':
        case 'ArrowDown':
        case 'ArrowLeft':
        case 'ArrowRight': {
          e.preventDefault();
          const vertical = e.key === 'ArrowUp' || e.key === 'ArrowDown';
          const sign = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1;
          if (meta) {
            // Jump to the edge of the data.
            const edge = vertical
              ? { r: sign < 0 ? 0 : Math.max(0, extent.rows - 1), c: s.f.c }
              : { r: s.f.r, c: sign < 0 ? 0 : Math.max(0, extent.cols - 1) };
            if (e.shiftKey) select(s.a, edge);
            else select(edge);
          } else {
            moveBy(vertical ? sign : 0, vertical ? 0 : sign, e.shiftKey);
          }
          return;
        }
        case 'PageDown':
        case 'PageUp':
          e.preventDefault();
          moveBy(e.key === 'PageDown' ? page : -page, 0, e.shiftKey);
          return;
        case 'Home':
          e.preventDefault();
          select({ r: s.a.r, c: 0 });
          return;
        case 'Enter':
          e.preventDefault();
          moveBy(e.shiftKey ? -1 : 1, 0, false);
          return;
        case 'Tab':
          e.preventDefault();
          moveBy(0, e.shiftKey ? -1 : 1, false);
          return;
        case 'F2':
          e.preventDefault();
          beginEdit('edit');
          return;
        case 'Backspace':
        case 'Delete':
          e.preventDefault();
          clearContents();
          return;
      }
      if (meta && !e.altKey) {
        if (!e.shiftKey && isKey(e, 'A')) {
          e.preventDefault();
          select({ r: 0, c: 0 }, { r: rowCount - 1, c: colCount - 1 }, false);
        } else if (isKey(e, 'Z')) {
          e.preventDefault();
          undo(e.shiftKey);
        } else if (e.shiftKey && isKey(e, 'V')) {
          e.preventDefault();
          e.stopPropagation();
          pasteFromClipboard(true);
        }
      }
    },
    [
      beginEdit,
      cancelEdit,
      clearContents,
      colCount,
      commitEdit,
      editing,
      extent,
      moveBy,
      onStyleShortcut,
      pasteFromClipboard,
      rowCount,
      select,
      undo,
      view.h,
    ]
  );

  const onBarKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      if (onStyleShortcut(e)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        commitEdit([e.shiftKey ? -1 : 1, 0]);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        commitEdit([0, e.shiftKey ? -1 : 1]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    },
    [cancelEdit, commitEdit, onStyleShortcut]
  );

  // Leaving the sheet (sidebar click, another pane) commits a pending edit.
  const onRootBlur = useCallback((e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && rootRef.current?.contains(next)) return;
    commitRef.current();
  }, []);

  // ---------------------------------------------------------------------------
  // Mouse
  // ---------------------------------------------------------------------------

  const cellFromPoint = useCallback(
    (clientX: number, clientY: number): Pos => {
      const rect = cellsRef.current!.getBoundingClientRect();
      const x = Math.max(0, clientX - rect.left);
      const y = Math.max(0, clientY - rect.top);
      return { r: Math.min(rowCount - 1, Math.floor(y / ROW_H)), c: colAtX(x) };
    },
    [colAtX, rowCount]
  );

  const activeInput = useCallback(
    (): HTMLInputElement | null =>
      document.activeElement === barRef.current ? barRef.current : inputRef.current,
    []
  );

  // Click-to-reference while typing a formula; dragging widens it to a range.
  const tryInsertRef = useCallback(
    (p: Pos): boolean => {
      if (!editing) return false;
      const input = activeInput();
      const caret = input?.selectionStart ?? draft.length;
      if (!canInsertRef(draft, caret)) return false;
      const text = cellKey(p.r, p.c);
      setDraft(draft.slice(0, caret) + text + draft.slice(caret));
      refPick.current = { start: caret, len: text.length, from: p };
      requestAnimationFrame(() => {
        input?.focus({ preventScroll: true });
        input?.setSelectionRange(caret + text.length, caret + text.length);
      });
      return true;
    },
    [activeInput, draft, editing]
  );

  const extendRefPick = useCallback((p: Pos) => {
    const pick = refPick.current;
    if (!pick) return;
    const r1 = Math.min(pick.from.r, p.r);
    const c1 = Math.min(pick.from.c, p.c);
    const r2 = Math.max(pick.from.r, p.r);
    const c2 = Math.max(pick.from.c, p.c);
    const text = rangeLabel({ r1, c1, r2, c2 });
    setDraft((d) => d.slice(0, pick.start) + text + d.slice(pick.start + pick.len));
    const end = pick.start + text.length;
    refPick.current = { ...pick, len: text.length };
    requestAnimationFrame(() => {
      const input = activeInput();
      input?.setSelectionRange(end, end);
    });
  }, [activeInput]);

  const trackDrag = useCallback((onMove: (e: MouseEvent) => void) => {
    const up = (): void => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', up, true);
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', up, true);
  }, []);

  const onCellsMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t === inputRef.current && editing) return; // caret placement inside the editor
      e.preventDefault();
      const p = cellFromPoint(e.clientX, e.clientY);
      if (tryInsertRef(p)) {
        trackDrag((ev) => extendRefPick(cellFromPoint(ev.clientX, ev.clientY)));
        return;
      }
      if (editing) commitEdit();
      const s = selRef.current;
      if (e.shiftKey) select(s.a, p, false);
      else select(p, p, false);
      inputRef.current?.focus({ preventScroll: true });
      const anchor = e.shiftKey ? s.a : p;
      trackDrag((ev) => {
        const q = cellFromPoint(ev.clientX, ev.clientY);
        setSel({ a: anchor, f: q });
      });
    },
    [cellFromPoint, commitEdit, editing, extendRefPick, select, trackDrag, tryInsertRef]
  );

  const onCellsDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === inputRef.current && editing) return;
      const p = cellFromPoint(e.clientX, e.clientY);
      select(p, p, false);
      setDraft(rawAt(p));
      setEditing({ mode: 'edit' });
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      });
    },
    [cellFromPoint, editing, rawAt, select]
  );

  const onHeaderMouseDown = useCallback(
    (e: React.MouseEvent, axis: 'row' | 'col', index: number) => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (editing) commitEdit();
      const span = (i: number, j: number): Selection =>
        axis === 'row'
          ? { a: { r: i, c: 0 }, f: { r: j, c: colCount - 1 } }
          : { a: { r: 0, c: i }, f: { r: rowCount - 1, c: j } };
      const from = e.shiftKey
        ? axis === 'row'
          ? selRef.current.a.r
          : selRef.current.a.c
        : index;
      setSel(span(from, index));
      inputRef.current?.focus({ preventScroll: true });
      trackDrag((ev) => {
        const q = cellFromPoint(ev.clientX, ev.clientY);
        setSel(span(from, axis === 'row' ? q.r : q.c));
      });
    },
    [cellFromPoint, colCount, commitEdit, editing, rowCount, trackDrag]
  );

  const onCornerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (editing) commitEdit();
      select({ r: 0, c: 0 }, { r: rowCount - 1, c: colCount - 1 }, false);
      inputRef.current?.focus({ preventScroll: true });
    },
    [colCount, commitEdit, editing, rowCount, select]
  );

  const onResizeMouseDown = useCallback(
    (e: React.MouseEvent, c: number) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = colWidth(c);
      let w = startW;
      setResizing({ c, w });
      document.body.style.cursor = 'col-resize';
      const move = (ev: MouseEvent): void => {
        w = Math.max(MIN_COL_W, Math.round(startW + ev.clientX - startX));
        setResizing({ c, w });
      };
      const up = (): void => {
        window.removeEventListener('mousemove', move, true);
        window.removeEventListener('mouseup', up, true);
        document.body.style.cursor = '';
        setResizing(null);
        if (w !== startW) apply((d) => ({ ...d, colWidths: { ...d.colWidths, [c]: w } }));
      };
      window.addEventListener('mousemove', move, true);
      window.addEventListener('mouseup', up, true);
    },
    [apply, colWidth]
  );

  // Double-click a column edge: fit the widest value in that column.
  const autoFitColumn = useCallback(
    (e: React.MouseEvent, c: number) => {
      e.preventDefault();
      e.stopPropagation();
      let widest = 0;
      for (let r = 0; r < extent.rows; r += 1) {
        const text = formatValue(value(r, c));
        if (text) widest = Math.max(widest, textWidth(text));
      }
      const w = Math.max(MIN_COL_W, Math.min(600, Math.ceil(widest + 18)));
      apply((d) => ({ ...d, colWidths: { ...d.colWidths, [c]: w } }));
    },
    [apply, extent.rows, value]
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (editing) commitEdit();
      const target = e.target as HTMLElement;
      if (cellsRef.current?.contains(target)) {
        const p = cellFromPoint(e.clientX, e.clientY);
        if (!inRange(p, rangeOf(selRef.current))) select(p, p, false);
      }
      inputRef.current?.focus({ preventScroll: true });
      setMenu({ x: e.clientX, y: e.clientY });
    },
    [cellFromPoint, commitEdit, editing, select]
  );

  // ---------------------------------------------------------------------------
  // Imperative handle for the app shell
  // ---------------------------------------------------------------------------

  const handleRef = useRef<DocumentViewHandle>({} as DocumentViewHandle);
  Object.assign(handleRef.current, {
    save,
    buildMarkdown: async () => serializeCsv(dataRef.current),
    buildSnote: async () => serializeSsheet(dataRef.current),
    lossyFeatures: () => lossySheetFeatures(dataRef.current),
    hasContent: () => Object.values(dataRef.current.cells).some((c) => !!c.v),
    cancelPendingAutoSave,
    replaceWithContent: async (text: string, opts: { focus?: boolean } = {}) => {
      cancelPendingAutoSave();
      loadText(text);
      setTabDirty(tabId, false);
      if (opts.focus) focusGrid();
    },
    pastePlainText: () => pasteFromClipboard(true),
    removeParagraphBreaks: () => {},
    focusLastBlock: focusGrid,
    focus: focusGrid,
    openFind: () => {},
    findNext: () => {},
    findPrev: () => {},
  } satisfies DocumentViewHandle);
  useEffect(() => registerDocumentView(tabId, handleRef.current), [tabId]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const activeCell = data.cells[cellKey(sel.a.r, sel.a.c)];
  const barValue = editing ? draft : rawAt(sel.a);

  // Sum / average / count of the selected numbers, shown beside the formula bar.
  const summary = useMemo(() => {
    if (range.r1 === range.r2 && range.c1 === range.c2) return null;
    const r2 = Math.min(range.r2, extent.rows - 1);
    const c2 = Math.min(range.c2, extent.cols - 1);
    let count = 0;
    let numbers = 0;
    let sum = 0;
    for (let r = range.r1; r <= r2; r += 1) {
      for (let c = range.c1; c <= c2; c += 1) {
        const v = value(r, c);
        if (v === null || v === '') continue;
        count += 1;
        if (typeof v === 'number') {
          numbers += 1;
          sum += v;
        }
      }
    }
    if (count === 0) return null;
    return { count, numbers, sum, avg: numbers ? sum / numbers : 0 };
  }, [extent, range.c1, range.c2, range.r1, range.r2, value]);

  const rows: JSX.Element[] = [];
  const rowHeads: JSX.Element[] = [];
  for (let r = visibleRows.from; r <= visibleRows.to; r += 1) {
    const selected = r >= range.r1 && r <= range.r2;
    rowHeads.push(
      <div
        key={r}
        className={`sheet-rowhead${selected ? ' in-sel' : ''}`}
        style={{ top: r * ROW_H }}
        onMouseDown={(e) => onHeaderMouseDown(e, 'row', r)}
      >
        {r + 1}
      </div>
    );
    for (let c = visibleCols.from; c <= visibleCols.to; c += 1) {
      const key = cellKey(r, c);
      const cell = data.cells[key];
      const v: Val = cell?.v ? value(r, c) : null;
      let cls = 'sheet-cell';
      if (typeof v === 'number') cls += ' num';
      else if (typeof v === 'boolean') cls += ' bool';
      else if (v instanceof FormulaError) cls += ' err';
      if (cell) {
        if (cell.b) cls += ' b';
        if (cell.i) cls += ' i';
        if (cell.u) cls += ' u';
        if (cell.s) cls += ' s';
        if (cell.color) cls += ` text-${cell.color}`;
        if (cell.fill) cls += ` fill-${cell.fill}`;
      }
      rows.push(
        <div
          key={key}
          className={cls}
          style={{ top: r * ROW_H, left: colX[c], width: colWidth(c) }}
        >
          {cell?.v ? formatValue(v) : null}
        </div>
      );
    }
  }

  const colHeads: JSX.Element[] = [];
  for (let c = visibleCols.from; c <= visibleCols.to; c += 1) {
    const selected = c >= range.c1 && c <= range.c2;
    colHeads.push(
      <div
        key={c}
        className={`sheet-colhead-cell${selected ? ' in-sel' : ''}`}
        style={{ left: colX[c], width: colWidth(c) }}
        onMouseDown={(e) => onHeaderMouseDown(e, 'col', c)}
      >
        {colName(c)}
        <div
          className="sheet-col-resize"
          onMouseDown={(e) => onResizeMouseDown(e, c)}
          onDoubleClick={(e) => autoFitColumn(e, c)}
        />
      </div>
    );
  }

  const multi = range.r1 !== range.r2 || range.c1 !== range.c2;
  const selBox = {
    left: colX[range.c1]!,
    top: range.r1 * ROW_H,
    width: colX[Math.min(range.c2 + 1, colCount)]! - colX[range.c1]!,
    height: (range.r2 - range.r1 + 1) * ROW_H,
  };
  // Excel-style dashed frames around every range the formula being edited
  // refers to; the one just picked with the mouse marches.
  const pick = refPick.current;
  const picked = pick
    ? formulaRanges('=' + draft.slice(pick.start, pick.start + pick.len))[0]
    : undefined;
  const refBoxes = editing
    ? formulaRanges(draft).map((rg, i) => {
        if (rg.r1 >= rowCount || rg.c1 >= colCount) return null;
        const r2 = rg.r2 < 0 ? rowCount - 1 : Math.min(rg.r2, rowCount - 1);
        const c2 = Math.min(rg.c2, colCount - 1);
        const marching =
          !!picked &&
          picked.r1 === rg.r1 &&
          picked.c1 === rg.c1 &&
          picked.r2 === rg.r2 &&
          picked.c2 === rg.c2;
        return (
          <div
            key={i}
            className={`sheet-ref-box${marching ? ' marching' : ''}`}
            style={{
              left: colX[rg.c1],
              top: rg.r1 * ROW_H,
              width: colX[c2 + 1]! - colX[rg.c1]! + 1,
              height: (r2 - rg.r1 + 1) * ROW_H + 1,
            }}
          />
        );
      })
    : null;

  const activeW = colWidth(sel.a.c);
  const inputW = editing
    ? Math.max(activeW + 1, Math.min(640, Math.ceil(textWidth(draft) + 20)))
    : activeW;

  let inputCls = 'sheet-input';
  if (editing) inputCls += ' editing';
  if (activeCell?.b) inputCls += ' b';
  if (activeCell?.i) inputCls += ' i';
  if (activeCell?.u) inputCls += ' u';
  if (activeCell?.s) inputCls += ' s';
  if (activeCell?.color) inputCls += ` text-${activeCell.color}`;
  // Only while editing: the idle sink sits on top of the cell's own text.
  if (editing && activeCell?.fill) inputCls += ` fill-${activeCell.fill}`;

  return (
    <div className="sheet-view" hidden={!active} ref={rootRef} onBlur={onRootBlur}>
      <div className="sheet-bar">
        <div className="sheet-bar-address">{rangeLabel(range)}</div>
        <input
          ref={barRef}
          className="sheet-bar-input"
          value={barValue}
          spellCheck={false}
          aria-label="儲存格內容"
          onFocus={() => {
            if (!editing) beginEdit('edit');
          }}
          onChange={(e) => {
            if (!editing) setEditing({ mode: 'edit' });
            refPick.current = null;
            setDraft(e.target.value);
          }}
          onKeyDown={onBarKeyDown}
        />
        {summary && (
          <div className="sheet-bar-summary">
            {summary.numbers > 0 && (
              <>
                <span>加總 {formatNumber(summary.sum)}</span>
                <span>平均 {formatNumber(summary.avg)}</span>
              </>
            )}
            <span>計數 {summary.count}</span>
          </div>
        )}
      </div>
      <div className="sheet-scroll" ref={scrollRef} onContextMenu={onContextMenu}>
        <div className="sheet-canvas" style={{ width: ROWHEAD_W + bodyW, height: HEAD_H + bodyH }}>
          <div className="sheet-colhead" style={{ width: ROWHEAD_W + bodyW }}>
            <div className="sheet-corner" onMouseDown={onCornerMouseDown} />
            <div className="sheet-colhead-track">{colHeads}</div>
          </div>
          <div className="sheet-body" style={{ height: bodyH }}>
            <div className="sheet-rowheads">{rowHeads}</div>
            <div
              className="sheet-cells"
              ref={cellsRef}
              style={{ width: bodyW }}
              onMouseDown={onCellsMouseDown}
              onDoubleClick={onCellsDoubleClick}
            >
              {rows}
              {multi && !editing && <div className="sheet-sel-range" style={selBox} />}
              {refBoxes}
              <div
                className="sheet-sel-active"
                style={{
                  left: colX[sel.a.c],
                  top: sel.a.r * ROW_H,
                  width: activeW + 1,
                  height: ROW_H + 1,
                }}
              />
              <input
                ref={inputRef}
                className={inputCls}
                style={{
                  left: colX[sel.a.c],
                  top: sel.a.r * ROW_H,
                  width: inputW,
                  height: ROW_H,
                }}
                value={editing ? draft : ''}
                spellCheck={false}
                aria-label={`儲存格 ${cellKey(sel.a.r, sel.a.c)}`}
                onChange={(e) => {
                  if (!editing) setEditing({ mode: 'enter' });
                  refPick.current = null;
                  setDraft(e.target.value);
                }}
                onCompositionStart={() => {
                  if (!editing) {
                    setDraft('');
                    setEditing({ mode: 'enter' });
                  }
                }}
                onKeyDown={onInputKeyDown}
                onCopy={(e) => {
                  if (editing) return;
                  e.preventDefault();
                  e.clipboardData.setData('text/plain', copySelection());
                }}
                onCut={(e) => {
                  if (editing) return;
                  e.preventDefault();
                  e.clipboardData.setData('text/plain', copySelection());
                  clearContents();
                }}
                onPaste={(e) => {
                  if (editing) return;
                  e.preventDefault();
                  pasteText(e.clipboardData.getData('text/plain'));
                }}
              />
            </div>
          </div>
        </div>
      </div>
      {menu && (
        <SheetMenu
          x={menu.x}
          y={menu.y}
          cell={activeCell}
          onClose={() => {
            setMenu(null);
            focusGrid();
          }}
          onCut={cutToClipboard}
          onCopy={copyToClipboard}
          onPaste={() => pasteFromClipboard()}
          onStyle={toggleStyle}
          onColor={setColor}
          onStructure={insertOrDelete}
          onClearContents={clearContents}
          onClearFormats={clearFormats}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right-click menu: clipboard, text style, colours, rows/columns.
// ---------------------------------------------------------------------------

interface SheetMenuProps {
  x: number;
  y: number;
  cell: Cell | undefined;
  onClose: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onStyle: (flag: StyleFlag) => void;
  onColor: (prop: 'color' | 'fill', color: SheetColor | undefined) => void;
  onStructure: (axis: 'row' | 'col', mode: 'insert' | 'delete') => void;
  onClearContents: () => void;
  onClearFormats: () => void;
}

function SheetMenu(props: SheetMenuProps): JSX.Element {
  const { x, y, cell, onClose } = props;
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
  }, [x, y]);

  useEffect(() => {
    const close = (): void => onClose();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const item = (label: string, fn: () => void, shortcut?: string, checked?: boolean) => (
    <button className="pop-menu-item sheet-menu-item" onClick={run(fn)}>
      <span className="check">{checked ? '✓' : ''}</span>
      <span className="sheet-menu-label">{label}</span>
      {shortcut && <span className="sheet-menu-shortcut">{shortcut}</span>}
    </button>
  );

  const swatches = (prop: 'color' | 'fill') => (
    <div className="sheet-swatches" role="group">
      <button
        className={`sheet-swatch none${!cell?.[prop] ? ' current' : ''}`}
        aria-label="無"
        title="無"
        onClick={run(() => props.onColor(prop, undefined))}
      />
      {SHEET_COLORS.map((col) => (
        <button
          key={col.id}
          className={`sheet-swatch ${prop === 'fill' ? `fill-${col.id}` : `text-${col.id}`}${
            cell?.[prop] === col.id ? ' current' : ''
          }`}
          aria-label={col.label}
          title={col.label}
          onClick={run(() => props.onColor(prop, col.id))}
        >
          {prop === 'color' ? 'A' : null}
        </button>
      ))}
    </div>
  );

  return (
    <div
      ref={ref}
      className="pop-menu sheet-menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {item('剪下', props.onCut, '⌘X')}
      {item('拷貝', props.onCopy, '⌘C')}
      {item('貼上', props.onPaste, '⌘V')}
      <div className="pop-menu-divider" />
      {item('粗體', () => props.onStyle('b'), '⌘B', !!cell?.b)}
      {item('斜體', () => props.onStyle('i'), '⌘I', !!cell?.i)}
      {item('底線', () => props.onStyle('u'), '⌘U', !!cell?.u)}
      {item('刪除線', () => props.onStyle('s'), '⇧⌘S', !!cell?.s)}
      <div className="pop-menu-divider" />
      <div className="sheet-menu-caption">文字顏色</div>
      {swatches('color')}
      <div className="sheet-menu-caption">填滿顏色</div>
      {swatches('fill')}
      <div className="pop-menu-divider" />
      {item('在上方插入列', () => props.onStructure('row', 'insert'))}
      {item('在左側插入欄', () => props.onStructure('col', 'insert'))}
      {item('刪除列', () => props.onStructure('row', 'delete'))}
      {item('刪除欄', () => props.onStructure('col', 'delete'))}
      <div className="pop-menu-divider" />
      {item('清除內容', props.onClearContents, '⌫')}
      {item('清除格式', props.onClearFormats)}
    </div>
  );
}
