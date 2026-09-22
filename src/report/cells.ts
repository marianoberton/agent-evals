import type { CaseReport, Report, ScoreEntry } from "../core/types.js";

export const TICK = "✓";
export const CROSS = "✗";
export const DASH = "–";
export const BANG = "‼";

const UNIT: Record<string, (n: number) => string> = {
  latency: (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`),
  cost: (n) => `$${n.toFixed(4)}`,
  tokens: (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)),
  turns: (n) => String(n),
};

function formatValue(entry: ScoreEntry): string | undefined {
  if (entry.probability !== undefined) return entry.probability.toFixed(2);
  const v = entry.value;
  if (typeof v !== "number") return undefined;
  return UNIT[entry.group]?.(v);
}

/**
 * One cell: the aggregate of every scorer of a group that ran on this case.
 *
 * Grouping is what keeps the table readable — three `contains` assertions across
 * three cases are one column, not three. All of a group must pass for the cell
 * to be green; the per-scorer detail lives in the failures block.
 *
 * The value is the payload and the mark is only the verdict, which is why a
 * budget cell reads `1.2s ✓` and a Jev cell reads `0.91 ✓`.
 */
export function renderCell(entries: readonly ScoreEntry[]): string {
  if (entries.length === 0) return DASH;
  if (entries.some((e) => e.error !== undefined)) return BANG;
  const graded = entries.filter((e) => e.pass !== null);
  if (graded.length === 0) return DASH;
  const failed = graded.filter((e) => !e.pass);
  const mark = failed.length === 0 ? TICK : CROSS;
  const shown = failed[0] ?? graded[0];
  const value = shown === undefined ? undefined : formatValue(shown);
  const suffix = graded.length > 1 ? ` ${graded.length - failed.length}/${graded.length}` : "";
  return value === undefined ? `${mark}${suffix}` : `${value} ${mark}${suffix}`;
}

/** Column order: first appearance, which is suite-declaration order then `expect` order. */
export function columnsOf(report: Report): { group: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const c of report.cases) {
    for (const e of c.scores) if (!seen.has(e.group)) seen.set(e.group, e.label);
  }
  return [...seen].map(([group, label]) => ({ group, label }));
}

/** Every entry of a case, bucketed by column. */
export function entriesByGroup(c: CaseReport): Map<string, ScoreEntry[]> {
  const out = new Map<string, ScoreEntry[]>();
  for (const e of c.scores) {
    const bucket = out.get(e.group);
    if (bucket) bucket.push(e);
    else out.set(e.group, [e]);
  }
  return out;
}

export const formatScore = (n: number | null): string => (n === null ? DASH : n.toFixed(2));

export function failuresOf(c: CaseReport): ScoreEntry[] {
  return c.scores.filter((e) => e.pass === false);
}
