// Spreadsheet formula engine for Simple Sheet.
//
// Grammar (Excel-flavoured, lowest precedence first):
//   formula    := '=' compare
//   compare    := concat (('=' | '<>' | '<' | '>' | '<=' | '>=') concat)*
//   concat     := additive ('&' additive)*
//   additive   := term (('+' | '-') term)*
//   term       := power (('*' | '/') power)*
//   power      := unary ('^' unary)*
//   unary      := ('-' | '+') unary | postfix
//   postfix    := primary '%'*
//   primary    := NUMBER | STRING | TRUE | FALSE | ref | range | NAME '(' args ')' | '(' compare ')'
//   ref        := $?COL$?ROW          (A1, $B$2)
//   range      := ref ':' ref | COL ':' COL
//
// Cells are addressed by zero-based (row, col). Values flowing through the
// evaluator are numbers, strings, booleans, errors, or null (an empty cell).

export class FormulaError {
  constructor(readonly code: string) {}
}

export type Val = number | string | boolean | FormulaError | null;

const ERR_VALUE = new FormulaError('#VALUE!');
const ERR_DIV0 = new FormulaError('#DIV/0!');
const ERR_NAME = new FormulaError('#NAME?');
const ERR_REF = new FormulaError('#REF!');
const ERR_CIRC = new FormulaError('#CIRC!');
const ERR_PARSE = new FormulaError('#ERROR!');
const ERR_NA = new FormulaError('#N/A');

export const MAX_ROWS = 1_000_000;
export const MAX_COLS = 18_278; // ZZZ

// ---------------------------------------------------------------------------
// A1 helpers
// ---------------------------------------------------------------------------

export function colName(c: number): string {
  let n = c + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function cellKey(r: number, c: number): string {
  return `${colName(c)}${r + 1}`;
}

export function parseCellKey(key: string): { r: number; c: number } | null {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(key);
  if (!m) return null;
  return { r: Number(m[2]) - 1, c: colIndex(m[1]!) };
}

// ---------------------------------------------------------------------------
// Literal typing: what a raw (non-formula) cell entry means.
// ---------------------------------------------------------------------------

const NUMBER_RE = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[+-]?\d+)?$/i;

// "1,234.5" → 1234.5, "50%" → 0.5. Returns null when the text isn't a number.
export function parseNumberLiteral(raw: string): number | null {
  let s = raw.trim();
  if (!s || !/\d/.test(s)) return null;
  let percent = false;
  if (s.endsWith('%')) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  if (!NUMBER_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}

export function literalValue(raw: string): Val {
  if (raw === '') return null;
  if (raw.startsWith("'")) return raw.slice(1);
  const n = parseNumberLiteral(raw);
  if (n !== null) return n;
  const upper = raw.trim().toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  return raw;
}

export function isFormula(raw: string): boolean {
  return raw.length > 1 && raw.startsWith('=');
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Tok =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string };

const OPS = ['<=', '>=', '<>', '+', '-', '*', '/', '^', '&', '=', '<', '>', '(', ')', ',', ':', '%'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // Full-width punctuation typed with a CJK input method.
    const normalized = ch === '，' ? ',' : ch === '（' ? '(' : ch === '）' ? ')' : ch;
    if (/[0-9.]/.test(normalized)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(src.slice(i));
      if (!m) throw ERR_PARSE;
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (normalized === '"') {
      let s = '';
      i += 1;
      for (;;) {
        if (i >= src.length) throw ERR_PARSE;
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        s += src[i];
        i += 1;
      }
      out.push({ t: 'str', v: s });
      continue;
    }
    if (/[A-Za-z_$]/.test(normalized)) {
      const m = /^[A-Za-z_$][A-Za-z0-9_$.]*/.exec(src.slice(i))!;
      out.push({ t: 'name', v: m[0] });
      i += m[0].length;
      continue;
    }
    const rest = normalized + src.slice(i + 1, i + 2);
    const op = OPS.find((o) => rest.startsWith(o));
    if (!op) throw ERR_PARSE;
    out.push({ t: 'op', v: op });
    i += op.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Node =
  | { k: 'lit'; v: Val }
  | { k: 'ref'; r: number; c: number }
  | { k: 'range'; r1: number; c1: number; r2: number; c2: number }
  | { k: 'un'; op: string; a: Node }
  | { k: 'pct'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

const REF_RE = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;
const COL_RE = /^\$?([A-Za-z]{1,3})$/;

function parseRef(name: string): { r: number; c: number } | null {
  const m = REF_RE.exec(name);
  if (!m) return null;
  const r = Number(m[2]) - 1;
  const c = colIndex(m[1]!);
  if (r < 0 || r >= MAX_ROWS || c >= MAX_COLS) return null;
  return { r, c };
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  parse(): Node {
    const n = this.compare();
    if (this.i < this.toks.length) throw ERR_PARSE;
    return n;
  }

  private peekOp(...ops: string[]): string | null {
    const t = this.toks[this.i];
    return t && t.t === 'op' && ops.includes(t.v) ? t.v : null;
  }

  private expectOp(op: string): void {
    if (!this.peekOp(op)) throw ERR_PARSE;
    this.i += 1;
  }

  private binaryLevel(next: () => Node, ops: string[]): Node {
    let a = next();
    for (let op = this.peekOp(...ops); op; op = this.peekOp(...ops)) {
      this.i += 1;
      a = { k: 'bin', op, a, b: next() };
    }
    return a;
  }

  private compare = (): Node =>
    this.binaryLevel(this.concat, ['=', '<>', '<', '>', '<=', '>=']);
  private concat = (): Node => this.binaryLevel(this.additive, ['&']);
  private additive = (): Node => this.binaryLevel(this.term, ['+', '-']);
  private term = (): Node => this.binaryLevel(this.power, ['*', '/']);
  private power = (): Node => this.binaryLevel(this.unary, ['^']);

  private unary = (): Node => {
    const op = this.peekOp('-', '+');
    if (op) {
      this.i += 1;
      return { k: 'un', op, a: this.unary() };
    }
    let n = this.primary();
    while (this.peekOp('%')) {
      this.i += 1;
      n = { k: 'pct', a: n };
    }
    return n;
  };

  private primary(): Node {
    const t = this.toks[this.i];
    if (!t) throw ERR_PARSE;
    this.i += 1;
    if (t.t === 'num') return { k: 'lit', v: t.v };
    if (t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'op') {
      if (t.v !== '(') throw ERR_PARSE;
      const n = this.compare();
      this.expectOp(')');
      return n;
    }
    const name = t.v;
    if (this.peekOp('(')) {
      this.i += 1;
      const args: Node[] = [];
      if (!this.peekOp(')')) {
        for (;;) {
          args.push(this.compare());
          if (this.peekOp(',')) {
            this.i += 1;
            continue;
          }
          break;
        }
      }
      this.expectOp(')');
      return { k: 'call', name: name.toUpperCase(), args };
    }
    // Ranges: A1:B5 or A:C (whole columns).
    if (this.peekOp(':')) {
      const next = this.toks[this.i + 1];
      if (next && next.t === 'name') {
        const a = parseRef(name);
        const b = parseRef(next.v);
        if (a && b) {
          this.i += 2;
          return {
            k: 'range',
            r1: Math.min(a.r, b.r),
            c1: Math.min(a.c, b.c),
            r2: Math.max(a.r, b.r),
            c2: Math.max(a.c, b.c),
          };
        }
        const ca = COL_RE.exec(name);
        const cb = COL_RE.exec(next.v);
        if (ca && cb) {
          this.i += 2;
          const x = colIndex(ca[1]!);
          const y = colIndex(cb[1]!);
          return { k: 'range', r1: 0, c1: Math.min(x, y), r2: -1, c2: Math.max(x, y) };
        }
      }
      throw ERR_PARSE;
    }
    const ref = parseRef(name);
    if (ref) return { k: 'ref', ...ref };
    const upper = name.toUpperCase();
    if (upper === 'TRUE') return { k: 'lit', v: true };
    if (upper === 'FALSE') return { k: 'lit', v: false };
    return { k: 'lit', v: ERR_NAME };
  }
}

const astCache = new Map<string, Node | FormulaError>();

function parseFormula(raw: string): Node | FormulaError {
  const hit = astCache.get(raw);
  if (hit) return hit;
  let result: Node | FormulaError;
  try {
    result = new Parser(tokenize(raw.slice(1))).parse();
  } catch (err) {
    result = err instanceof FormulaError ? err : ERR_PARSE;
  }
  if (astCache.size > 5000) astCache.clear();
  astCache.set(raw, result);
  return result;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface SheetSource {
  // Raw text of the cell at (r, c), '' when empty.
  raw: (r: number, c: number) => string;
  // Last row index holding data (for whole-column ranges).
  lastRow: () => number;
}

interface RangeArg {
  range: Val[];
}
type Arg = Val | RangeArg;

function isRange(a: Arg): a is RangeArg {
  return !!a && typeof a === 'object' && 'range' in a;
}

function toNumber(v: Val): number | FormulaError {
  if (v instanceof FormulaError) return v;
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v.trim() === '') return 0;
  const n = parseNumberLiteral(v);
  return n === null ? ERR_VALUE : n;
}

function toText(v: Val): string | FormulaError {
  if (v instanceof FormulaError) return v;
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumber(v);
  return v;
}

function toBool(v: Val): boolean | FormulaError {
  if (v instanceof FormulaError) return v;
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return ERR_VALUE;
}

// Every value an argument list contributes, flattening ranges.
function flatten(args: Arg[]): Array<{ v: Val; fromRange: boolean }> {
  const out: Array<{ v: Val; fromRange: boolean }> = [];
  for (const a of args) {
    if (isRange(a)) for (const v of a.range) out.push({ v, fromRange: true });
    else out.push({ v: a, fromRange: false });
  }
  return out;
}

// Numbers for SUM/AVERAGE/MIN/MAX: text and booleans inside ranges are
// skipped (Excel semantics); typed-in scalar arguments are coerced.
function numbersOf(args: Arg[]): number[] | FormulaError {
  const nums: number[] = [];
  for (const { v, fromRange } of flatten(args)) {
    if (v instanceof FormulaError) return v;
    if (fromRange) {
      if (typeof v === 'number') nums.push(v);
      continue;
    }
    if (v === null) continue;
    const n = toNumber(v);
    if (n instanceof FormulaError) return n;
    nums.push(n);
  }
  return nums;
}

// COUNTIF-style criterion: ">5", "<>apple", "=3", "蘋果*", 10 …
function makeCriterion(crit: Val): (v: Val) => boolean {
  if (typeof crit === 'number' || typeof crit === 'boolean') {
    return (v) => v === crit || (typeof v === 'string' && parseNumberLiteral(v) === crit);
  }
  const text = crit === null || crit instanceof FormulaError ? '' : crit;
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(text)!;
  const op = m[1] ?? '=';
  const operand = m[2]!;
  const num = parseNumberLiteral(operand);
  if (num !== null) {
    return (v) => {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? parseNumberLiteral(v) : null;
      if (n === null) return op === '<>';
      return compareNums(n, num, op);
    };
  }
  if (operand === '' && (op === '=' || op === '<>')) {
    return (v) => (v === null || v === '') === (op === '=');
  }
  const pattern = new RegExp(
    '^' +
      operand
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/~\*/g, ' ')
        .replace(/~\?/g, '')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')
        .replace(/ /g, '\\*')
        .replace(//g, '\\?') +
      '$',
    'is'
  );
  return (v) => {
    if (v instanceof FormulaError) return false;
    const s = v === null ? '' : typeof v === 'string' ? v : String(toText(v));
    if (op === '=') return pattern.test(s);
    if (op === '<>') return !pattern.test(s);
    return compareText(s, operand, op);
  };
}

function compareNums(a: number, b: number, op: string): boolean {
  switch (op) {
    case '=':
      return a === b;
    case '<>':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    default:
      return a >= b;
  }
}

function compareText(a: string, b: string, op: string): boolean {
  const cmp = a.localeCompare(b, undefined, { sensitivity: 'base' });
  return compareNums(cmp, 0, op);
}

function roundTo(n: number, digits: number, mode: 'round' | 'up' | 'down'): number {
  const f = Math.pow(10, digits);
  const x = Math.abs(n) * f;
  const y =
    mode === 'round'
      ? Math.round(Number(x.toPrecision(15)))
      : mode === 'up'
        ? Math.ceil(Number(x.toPrecision(15)))
        : Math.floor(Number(x.toPrecision(15)));
  return (Math.sign(n) * y) / f;
}

type Fn = (args: Arg[]) => Val;

function scalar(a: Arg | undefined): Val {
  if (a === undefined) return null;
  return isRange(a) ? ERR_VALUE : a;
}

function numArg(a: Arg | undefined): number | FormulaError {
  return toNumber(scalar(a));
}

function conditionalAggregate(args: Arg[], mode: 'count' | 'sum' | 'avg'): Val {
  const target = args[0];
  if (!target || !isRange(target)) return ERR_VALUE;
  const test = makeCriterion(scalar(args[1]));
  const values = args[2] && isRange(args[2]) ? args[2].range : target.range;
  let count = 0;
  let sum = 0;
  target.range.forEach((v, i) => {
    if (!test(v)) return;
    if (mode === 'count') {
      count += 1;
      return;
    }
    const x = values[i];
    if (typeof x === 'number') {
      sum += x;
      count += 1;
    }
  });
  if (mode === 'count') return count;
  if (mode === 'sum') return sum;
  return count === 0 ? ERR_DIV0 : sum / count;
}

const FUNCTIONS: Record<string, Fn> = {
  SUM: (args) => {
    const nums = numbersOf(args);
    return nums instanceof FormulaError ? nums : nums.reduce((s, n) => s + n, 0);
  },
  AVERAGE: (args) => {
    const nums = numbersOf(args);
    if (nums instanceof FormulaError) return nums;
    return nums.length === 0 ? ERR_DIV0 : nums.reduce((s, n) => s + n, 0) / nums.length;
  },
  MIN: (args) => {
    const nums = numbersOf(args);
    if (nums instanceof FormulaError) return nums;
    return nums.length === 0 ? 0 : Math.min(...nums);
  },
  MAX: (args) => {
    const nums = numbersOf(args);
    if (nums instanceof FormulaError) return nums;
    return nums.length === 0 ? 0 : Math.max(...nums);
  },
  MEDIAN: (args) => {
    const nums = numbersOf(args);
    if (nums instanceof FormulaError) return nums;
    if (nums.length === 0) return ERR_NA;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  },
  PRODUCT: (args) => {
    const nums = numbersOf(args);
    return nums instanceof FormulaError ? nums : nums.reduce((s, n) => s * n, 1);
  },
  COUNT: (args) =>
    flatten(args).filter(({ v, fromRange }) =>
      fromRange ? typeof v === 'number' : v !== null && !(toNumber(v) instanceof FormulaError)
    ).length,
  COUNTA: (args) => flatten(args).filter(({ v }) => v !== null && v !== '').length,
  COUNTBLANK: (args) => flatten(args).filter(({ v }) => v === null || v === '').length,
  COUNTIF: (args) => conditionalAggregate(args, 'count'),
  SUMIF: (args) => conditionalAggregate(args, 'sum'),
  AVERAGEIF: (args) => conditionalAggregate(args, 'avg'),
  ROUND: (args) => {
    const n = numArg(args[0]);
    const d = numArg(args[1]);
    if (n instanceof FormulaError) return n;
    if (d instanceof FormulaError) return d;
    return roundTo(n, Math.trunc(d), 'round');
  },
  ROUNDUP: (args) => {
    const n = numArg(args[0]);
    const d = numArg(args[1]);
    if (n instanceof FormulaError) return n;
    if (d instanceof FormulaError) return d;
    return roundTo(n, Math.trunc(d), 'up');
  },
  ROUNDDOWN: (args) => {
    const n = numArg(args[0]);
    const d = numArg(args[1]);
    if (n instanceof FormulaError) return n;
    if (d instanceof FormulaError) return d;
    return roundTo(n, Math.trunc(d), 'down');
  },
  INT: (args) => {
    const n = numArg(args[0]);
    return n instanceof FormulaError ? n : Math.floor(n);
  },
  ABS: (args) => {
    const n = numArg(args[0]);
    return n instanceof FormulaError ? n : Math.abs(n);
  },
  SQRT: (args) => {
    const n = numArg(args[0]);
    if (n instanceof FormulaError) return n;
    return n < 0 ? new FormulaError('#NUM!') : Math.sqrt(n);
  },
  POWER: (args) => {
    const a = numArg(args[0]);
    const b = numArg(args[1]);
    if (a instanceof FormulaError) return a;
    if (b instanceof FormulaError) return b;
    return Math.pow(a, b);
  },
  MOD: (args) => {
    const a = numArg(args[0]);
    const b = numArg(args[1]);
    if (a instanceof FormulaError) return a;
    if (b instanceof FormulaError) return b;
    if (b === 0) return ERR_DIV0;
    return a - b * Math.floor(a / b);
  },
  AND: (args) => {
    for (const { v } of flatten(args)) {
      if (v === null) continue;
      const b = toBool(v);
      if (b instanceof FormulaError) return b;
      if (!b) return false;
    }
    return true;
  },
  OR: (args) => {
    for (const { v } of flatten(args)) {
      if (v === null) continue;
      const b = toBool(v);
      if (b instanceof FormulaError) return b;
      if (b) return true;
    }
    return false;
  },
  NOT: (args) => {
    const b = toBool(scalar(args[0]));
    return b instanceof FormulaError ? b : !b;
  },
  CONCAT: (args) => {
    let s = '';
    for (const { v } of flatten(args)) {
      const t = toText(v);
      if (t instanceof FormulaError) return t;
      s += t;
    }
    return s;
  },
  LEN: (args) => {
    const t = toText(scalar(args[0]));
    return t instanceof FormulaError ? t : [...t].length;
  },
  UPPER: (args) => {
    const t = toText(scalar(args[0]));
    return t instanceof FormulaError ? t : t.toUpperCase();
  },
  LOWER: (args) => {
    const t = toText(scalar(args[0]));
    return t instanceof FormulaError ? t : t.toLowerCase();
  },
  TRIM: (args) => {
    const t = toText(scalar(args[0]));
    return t instanceof FormulaError ? t : t.trim().replace(/\s+/g, ' ');
  },
};
FUNCTIONS.CONCATENATE = FUNCTIONS.CONCAT!;

// Names offered in the formula hint / used to validate input.
export const FUNCTION_NAMES = [...Object.keys(FUNCTIONS), 'IF', 'IFERROR'].sort();

// Evaluates cells lazily with memoisation and cycle detection. Build a new one
// whenever the sheet changes.
export function createEvaluator(src: SheetSource): (r: number, c: number) => Val {
  const memo = new Map<number, Val>();
  const visiting = new Set<number>();

  const cellValue = (r: number, c: number): Val => {
    const id = r * MAX_COLS + c;
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (visiting.has(id)) return ERR_CIRC;
    const raw = src.raw(r, c);
    let v: Val;
    if (isFormula(raw)) {
      visiting.add(id);
      const ast = parseFormula(raw);
      v = ast instanceof FormulaError ? ast : evalNode(ast);
      visiting.delete(id);
      if (v === null) v = 0;
    } else {
      v = literalValue(raw);
    }
    memo.set(id, v);
    return v;
  };

  const rangeValues = (n: Extract<Node, { k: 'range' }>): Val[] => {
    const r2 = n.r2 < 0 ? src.lastRow() : n.r2;
    const out: Val[] = [];
    for (let r = n.r1; r <= r2; r += 1) {
      for (let c = n.c1; c <= n.c2; c += 1) out.push(cellValue(r, c));
    }
    return out;
  };

  const evalArg = (n: Node): Arg => (n.k === 'range' ? { range: rangeValues(n) } : evalNode(n));

  function evalNode(n: Node): Val {
    switch (n.k) {
      case 'lit':
        return n.v;
      case 'ref':
        return cellValue(n.r, n.c);
      case 'range':
        return ERR_VALUE;
      case 'pct': {
        const x = toNumber(evalNode(n.a));
        return x instanceof FormulaError ? x : x / 100;
      }
      case 'un': {
        const x = toNumber(evalNode(n.a));
        if (x instanceof FormulaError) return x;
        return n.op === '-' ? -x : x;
      }
      case 'bin':
        return evalBinary(n.op, evalNode(n.a), evalNode(n.b));
      case 'call': {
        if (n.name === 'IF') {
          const cond = toBool(evalNode(n.args[0] ?? { k: 'lit', v: null }));
          if (cond instanceof FormulaError) return cond;
          const branch = cond ? n.args[1] : n.args[2];
          if (!branch) return cond;
          return evalNode(branch) ?? 0;
        }
        if (n.name === 'IFERROR') {
          const v = n.args[0] ? evalNode(n.args[0]) : null;
          if (v instanceof FormulaError) return n.args[1] ? evalNode(n.args[1]) : '';
          return v;
        }
        const fn = FUNCTIONS[n.name];
        if (!fn) return ERR_NAME;
        return fn(n.args.map(evalArg));
      }
    }
  }

  return cellValue;
}

function evalBinary(op: string, a: Val, b: Val): Val {
  if (a instanceof FormulaError) return a;
  if (b instanceof FormulaError) return b;
  if (op === '&') {
    return `${toText(a) as string}${toText(b) as string}`;
  }
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
    const an = typeof a === 'number' || a === null ? (a ?? 0) : null;
    const bn = typeof b === 'number' || b === null ? (b ?? 0) : null;
    if (an !== null && bn !== null) return compareNums(an, bn, op);
    return compareText(toText(a) as string, toText(b) as string, op);
  }
  const x = toNumber(a);
  const y = toNumber(b);
  if (x instanceof FormulaError) return x;
  if (y instanceof FormulaError) return y;
  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      return y === 0 ? ERR_DIV0 : x / y;
    default: {
      const p = Math.pow(x, y);
      return Number.isFinite(p) ? p : new FormulaError('#NUM!');
    }
  }
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  // Hide binary floating-point noise (0.1 + 0.2 → 0.3).
  return String(Number(n.toPrecision(12)));
}

export function formatValue(v: Val): string {
  if (v === null) return '';
  if (v instanceof FormulaError) return v.code;
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}

// ---------------------------------------------------------------------------
// Reference rewriting (row/column insert & delete, relative paste)
// ---------------------------------------------------------------------------

type RefMap = (
  r: number,
  c: number,
  absR: boolean,
  absC: boolean,
  role: 'single' | 'start' | 'end'
) => { r: number; c: number } | null;

const CELL_OR_RANGE_RE =
  /(?<![A-Za-z0-9_$.])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?(?![A-Za-z0-9_(.])/g;
const COL_RANGE_RE = /(?<![A-Za-z0-9_$.])(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_(.])/g;

function refText(absC: string, c: number, absR: string, r: number): string {
  return `${absC}${colName(c)}${absR}${r + 1}`;
}

// Apply `map` to every reference outside string literals. A reference mapped to
// null turns into #REF!.
function rewriteRefs(
  formula: string,
  map: RefMap,
  mapCol?: (c: number, abs: boolean, role: 'start' | 'end') => number | null
): string {
  if (!isFormula(formula)) return formula;
  return formula
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // string literal
      let s = part.replace(CELL_OR_RANGE_RE, (m, a1, c1, b1, r1, a2, c2, b2, r2) => {
        const s1 = map(Number(r1) - 1, colIndex(c1), !!b1, !!a1, c2 ? 'start' : 'single');
        if (!c2) return s1 ? refText(a1, s1.c, b1, s1.r) : '#REF!';
        const s2 = map(Number(r2) - 1, colIndex(c2), !!b2, !!a2, 'end');
        if (!s1 || !s2 || s2.r < s1.r || s2.c < s1.c) return '#REF!';
        return `${refText(a1, s1.c, b1, s1.r)}:${refText(a2, s2.c, b2, s2.r)}`;
      });
      if (mapCol) {
        s = s.replace(COL_RANGE_RE, (m, a1, c1, a2, c2) => {
          const x = mapCol(colIndex(c1), !!a1, 'start');
          const y = mapCol(colIndex(c2), !!a2, 'end');
          if (x === null || y === null || y < x) return '#REF!';
          return `${a1}${colName(x)}:${a2}${colName(y)}`;
        });
      }
      return s;
    })
    .join('');
}

// Rows/columns were inserted (count > 0) or deleted (count < 0) at `at`.
export function shiftForStructure(
  formula: string,
  axis: 'row' | 'col',
  at: number,
  count: number
): string {
  const move = (i: number, role: 'single' | 'start' | 'end'): number | null => {
    if (count > 0) return i >= at ? i + count : i;
    const removed = -count;
    if (i < at) return i;
    if (i >= at + removed) return i - removed;
    // Inside the deleted band: a lone reference breaks; range ends shrink.
    if (role === 'single') return null;
    return role === 'start' ? at : at - 1;
  };
  return rewriteRefs(
    formula,
    (r, c, _ar, _ac, role) => {
      if (axis === 'row') {
        const nr = move(r, role);
        return nr === null || nr < 0 ? null : { r: nr, c };
      }
      const nc = move(c, role);
      return nc === null || nc < 0 ? null : { r, c: nc };
    },
    axis === 'col' ? (c, _abs, role) => move(c, role) : undefined
  );
}

// Copy/paste: relative references follow the paste offset, $-anchored ones stay.
export function shiftRelative(formula: string, dr: number, dc: number): string {
  return rewriteRefs(
    formula,
    (r, c, absR, absC) => {
      const nr = absR ? r : r + dr;
      const nc = absC ? c : c + dc;
      return nr < 0 || nc < 0 ? null : { r: nr, c: nc };
    },
    (c, abs) => {
      const nc = abs ? c : c + dc;
      return nc < 0 ? null : nc;
    }
  );
}

// Every cell / range a formula refers to (outside string literals), for the
// dashed reference frames drawn while the formula is being edited. Whole
// columns report r2 = -1.
export function formulaRanges(
  formula: string
): Array<{ r1: number; c1: number; r2: number; c2: number }> {
  if (!formula.startsWith('=')) return [];
  const out: Array<{ r1: number; c1: number; r2: number; c2: number }> = [];
  formula.split(/("(?:[^"]|"")*"?)/).forEach((part, i) => {
    if (i % 2 === 1) return;
    for (const m of part.matchAll(CELL_OR_RANGE_RE)) {
      const r1 = Number(m[4]) - 1;
      const c1 = colIndex(m[2]!);
      const r2 = m[6] ? Number(m[8]) - 1 : r1;
      const c2 = m[6] ? colIndex(m[6]) : c1;
      if (r1 < 0 || r2 < 0) continue;
      out.push({
        r1: Math.min(r1, r2),
        c1: Math.min(c1, c2),
        r2: Math.max(r1, r2),
        c2: Math.max(c1, c2),
      });
    }
    for (const m of part.matchAll(COL_RANGE_RE)) {
      const a = colIndex(m[2]!);
      const b = colIndex(m[4]!);
      out.push({ r1: 0, c1: Math.min(a, b), r2: -1, c2: Math.max(a, b) });
    }
  });
  return out;
}
