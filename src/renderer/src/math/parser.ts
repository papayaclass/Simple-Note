/**
 * Recursive-descent arithmetic parser.
 * Grammar:
 *   expr   = term  (('+'|'-') term)*
 *   term   = factor (('*'|'/') factor)*
 *   factor = ('+'|'-') factor | atom
 *   atom   = number | ident | '(' expr ')'
 * Identifiers accept any Unicode letter/number including CJK.
 */
export type Token =
  | { type: 'num'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: '+' | '-' | '*' | '/' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'eq' };

const IDENT_RE = /^[\p{L}_][\p{L}\p{N}_]*/u;
const NUM_RE = /^\d+(?:\.\d+)?/;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let s = input;
  while (s.length > 0) {
    if (/^\s/.test(s)) {
      s = s.replace(/^\s+/, '');
      continue;
    }
    const num = NUM_RE.exec(s);
    if (num) {
      tokens.push({ type: 'num', value: parseFloat(num[0]) });
      s = s.slice(num[0].length);
      continue;
    }
    const ident = IDENT_RE.exec(s);
    if (ident) {
      tokens.push({ type: 'ident', value: ident[0] });
      s = s.slice(ident[0].length);
      continue;
    }
    const c = s[0]!;
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ type: 'op', value: c });
      s = s.slice(1);
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen' });
      s = s.slice(1);
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen' });
      s = s.slice(1);
      continue;
    }
    if (c === '=') {
      tokens.push({ type: 'eq' });
      s = s.slice(1);
      continue;
    }
    throw new Error(`未知字元: ${c}`);
  }
  return tokens;
}

export class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parseExpr(): Node {
    let node = this.parseTerm();
    while (this.peek()?.type === 'op' && (this.peek() as { value: string }).value.match(/[+-]/)) {
      const op = (this.consume() as { value: '+' | '-' }).value;
      const right = this.parseTerm();
      node = { kind: 'binop', op, left: node, right };
    }
    return node;
  }

  private parseTerm(): Node {
    let node = this.parseFactor();
    while (this.peek()?.type === 'op' && (this.peek() as { value: string }).value.match(/[*/]/)) {
      const op = (this.consume() as { value: '*' | '/' }).value;
      const right = this.parseFactor();
      node = { kind: 'binop', op, left: node, right };
    }
    return node;
  }

  private parseFactor(): Node {
    const t = this.peek();
    if (t?.type === 'op' && (t.value === '+' || t.value === '-')) {
      this.consume();
      return { kind: 'unary', op: t.value, operand: this.parseFactor() };
    }
    return this.parseAtom();
  }

  private parseAtom(): Node {
    const t = this.consume();
    if (!t) throw new Error('語法錯誤');
    if (t.type === 'num') return { kind: 'num', value: t.value };
    if (t.type === 'ident') return { kind: 'ident', name: t.value };
    if (t.type === 'lparen') {
      const e = this.parseExpr();
      const r = this.consume();
      if (r?.type !== 'rparen') throw new Error('缺右括號');
      return e;
    }
    throw new Error('語法錯誤');
  }

  hasMore(): boolean {
    return this.pos < this.tokens.length;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private consume(): Token | undefined {
    return this.tokens[this.pos++];
  }
}

export type Node =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'binop'; op: '+' | '-' | '*' | '/'; left: Node; right: Node }
  | { kind: 'unary'; op: '+' | '-'; operand: Node };

export function evalNode(node: Node, vars: Map<string, number>): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'ident': {
      const v = vars.get(node.name);
      if (v === undefined) throw new Error(`未定義變數: ${node.name}`);
      return v;
    }
    case 'unary':
      return node.op === '+' ? evalNode(node.operand, vars) : -evalNode(node.operand, vars);
    case 'binop': {
      const l = evalNode(node.left, vars);
      const r = evalNode(node.right, vars);
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          if (r === 0) throw new Error('除以零');
          return l / r;
      }
    }
  }
}
