import { cellKey, createEvaluator, formatValue, isFormula, parseCellKey } from './formula';

// Simple Sheet (`.ssheet`): the spreadsheet counterpart of `.snote`. Stores raw
// cell entries (formulas included) plus per-cell styling as JSON. A `.csv` file
// opened in the same view is saved back as plain values — formulas become
// their results and styling is dropped (see lossySheetFeatures).
export const SSHEET_EXT = '.ssheet';
export const SSHEET_FORMAT = 'simple-sheet';

export type SheetColor =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'gray';

export const SHEET_COLORS: Array<{ id: SheetColor; label: string }> = [
  { id: 'red', label: '紅色' },
  { id: 'orange', label: '橘色' },
  { id: 'yellow', label: '黃色' },
  { id: 'green', label: '綠色' },
  { id: 'blue', label: '藍色' },
  { id: 'purple', label: '紫色' },
  { id: 'pink', label: '粉紅色' },
  { id: 'gray', label: '灰色' },
];

export interface Cell {
  v?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  color?: SheetColor;
  fill?: SheetColor;
}

export interface SheetData {
  // Keyed by A1 address ("B3").
  cells: Record<string, Cell>;
  // Custom column widths in px, keyed by zero-based column index.
  colWidths: Record<number, number>;
}

interface SsheetFile {
  format: typeof SSHEET_FORMAT;
  version: 1;
  colWidths: Record<string, number>;
  cells: Record<string, Cell>;
}

export const EMPTY_SHEET: SheetData = { cells: {}, colWidths: {} };

export function isSheetPath(path: string | null | undefined): boolean {
  return !!path && /\.(ssheet|csv)$/i.test(path);
}

export function isSsheetPath(path: string | null | undefined): boolean {
  return !!path && path.toLowerCase().endsWith(SSHEET_EXT);
}

export function isCsvPath(path: string | null | undefined): boolean {
  return !!path && path.toLowerCase().endsWith('.csv');
}

export function withSsheetExt(name: string): string {
  return `${name.replace(/\.(ssheet|csv)$/i, '')}${SSHEET_EXT}`;
}

export function withCsvExt(name: string): string {
  return `${name.replace(/\.(ssheet|csv)$/i, '')}.csv`;
}

// Read either payload: Simple Sheet JSON, or anything else as CSV.
export function parseSheetContent(text: string): SheetData {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed) as Partial<SsheetFile>;
      if (data?.format === SSHEET_FORMAT) {
        const cells: Record<string, Cell> = {};
        for (const [key, cell] of Object.entries(data.cells ?? {})) {
          if (parseCellKey(key) && cell && typeof cell === 'object') cells[key] = cell;
        }
        const colWidths: Record<number, number> = {};
        for (const [k, w] of Object.entries(data.colWidths ?? {})) {
          if (typeof w === 'number' && w > 0) colWidths[Number(k)] = w;
        }
        return { cells, colWidths };
      }
    } catch {
      // Not JSON after all — fall through to CSV.
    }
  }
  const cells: Record<string, Cell> = {};
  parseCsv(text).forEach((row, r) =>
    row.forEach((v, c) => {
      if (v !== '') cells[cellKey(r, c)] = { v };
    })
  );
  return { cells, colWidths: {} };
}

export function serializeSsheet(data: SheetData): string {
  const file: SsheetFile = {
    format: SSHEET_FORMAT,
    version: 1,
    colWidths: Object.fromEntries(Object.entries(data.colWidths)),
    cells: data.cells,
  };
  return JSON.stringify(file, null, 2);
}

// The CSV payload: every cell's displayed value (formula results, not formulas)
// across the used range.
export function serializeCsv(data: SheetData): string {
  const { rows, cols } = usedExtent(data.cells);
  if (rows === 0) return '';
  const value = createEvaluator(sheetSource(data.cells));
  const lines: string[] = [];
  for (let r = 0; r < rows; r += 1) {
    const fields: string[] = [];
    for (let c = 0; c < cols; c += 1) fields.push(csvField(formatValue(value(r, c))));
    lines.push(fields.join(','));
  }
  return lines.join('\n') + '\n';
}

export function sheetSource(cells: Record<string, Cell>): {
  raw: (r: number, c: number) => string;
  lastRow: () => number;
} {
  let last: number | null = null;
  return {
    raw: (r, c) => cells[cellKey(r, c)]?.v ?? '',
    lastRow: () => (last ??= usedExtent(cells).rows - 1),
  };
}

// Rows / columns spanned by cells that hold a value.
export function usedExtent(cells: Record<string, Cell>): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const [key, cell] of Object.entries(cells)) {
    if (!cell.v) continue;
    const p = parseCellKey(key);
    if (!p) continue;
    rows = Math.max(rows, p.r + 1);
    cols = Math.max(cols, p.c + 1);
  }
  return { rows, cols };
}

// What a CSV save would throw away.
export function lossySheetFeatures(data: SheetData): string[] {
  const out = new Set<string>();
  for (const cell of Object.values(data.cells)) {
    if (cell.v && isFormula(cell.v)) out.add('公式');
    if (cell.b || cell.i || cell.u || cell.s) out.add('文字樣式');
    if (cell.color) out.add('文字顏色');
    if (cell.fill) out.add('儲存格底色');
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function csvField(v: string): string {
  return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// Comma, semicolon (European Excel) or tab — whichever the first line uses most.
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const outside = firstLine.replace(/"(?:[^"]|"")*"/g, '');
  const counts = [',', ';', '\t'].map((d) => [d, outside.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ',';
}

export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^﻿/, '');
  if (text.trim() === '') return [];
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === d) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// Tab-separated text for the clipboard (what Excel / Numbers paste as a grid).
export function toTsv(rows: string[][]): string {
  return rows
    .map((row) =>
      row.map((v) => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')
    )
    .join('\n');
}
