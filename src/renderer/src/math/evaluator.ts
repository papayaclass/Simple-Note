import { evalNode, Parser, tokenize } from './parser';

const CURRENCY_RE = /^\s*(-?\d+(?:\.\d+)?)\s+([A-Za-z]{3})\s*$/;
const ASSIGN_RE = /^\s*([\p{L}_][\p{L}\p{N}_]*)\s*=\s*(.+?)\s*$/u;
const QUERY_RE = /^\s*(.+?)\s*=\s*$/;

export type LineResult =
  | { kind: 'assign'; name: string; value: number }
  | { kind: 'query'; display: string }
  | { kind: 'query-currency'; currency: string; amount: number }
  | { kind: 'error'; message: string }
  | { kind: 'none' };

/**
 * Classify and evaluate one text line. Variable lookups/updates happen against `vars`.
 * Returns the display string for queries, or "none" if the line isn't a math line.
 */
export function evaluateLine(
  line: string,
  vars: Map<string, number>,
  formatNumber: (n: number) => string
): LineResult {
  if (!line.includes('=')) return { kind: 'none' };

  // assignment? must be: ident = <expr>
  const assignMatch = ASSIGN_RE.exec(line);
  if (assignMatch && !line.trim().endsWith('=')) {
    const [, name, rhs] = assignMatch;
    try {
      const tokens = tokenize(rhs!);
      const value = evalNode(new Parser(tokens).parseExpr(), vars);
      vars.set(name!, value);
      return { kind: 'assign', name: name!, value };
    } catch (e) {
      return { kind: 'error', message: (e as Error).message };
    }
  }

  // query? must end with =
  const queryMatch = QUERY_RE.exec(line);
  if (queryMatch) {
    const expr = queryMatch[1]!;
    // currency? "<number> <CCY>"
    const ccy = CURRENCY_RE.exec(expr);
    if (ccy) {
      return { kind: 'query-currency', amount: parseFloat(ccy[1]!), currency: ccy[2]!.toUpperCase() };
    }
    try {
      const tokens = tokenize(expr);
      const value = evalNode(new Parser(tokens).parseExpr(), vars);
      return { kind: 'query', display: formatNumber(value) };
    } catch (e) {
      return { kind: 'error', message: (e as Error).message };
    }
  }

  return { kind: 'none' };
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}
