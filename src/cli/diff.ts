import type { Report } from "../core/types.js";

export type Change = "regression" | "improvement" | "new" | "removed" | "unchanged";

export interface CaseDiff {
  id: string;
  change: Change;
  before: number | null;
  after: number | null;
  /** Scorers that flipped, so you see *what* broke, not just that something did. */
  flipped: { scorerId: string; from: boolean | null; to: boolean | null }[];
}

export interface ReportDiff {
  suite: string;
  scoreBefore: number | null;
  scoreAfter: number | null;
  cases: CaseDiff[];
  regressions: CaseDiff[];
  improvements: CaseDiff[];
}

const verdictOf = (report: Report, caseId: string) =>
  new Map(
    (report.cases.find((c) => c.id === caseId)?.scores ?? []).map((s) => [s.scorerId, s.pass]),
  );

/**
 * Compares two runs on what is reproducible only: case scores and per-scorer
 * verdicts. Timings, token counts and `runMeta` are deliberately ignored — they
 * differ between machines and would report a regression every time.
 */
export function diffReports(before: Report, after: Report): ReportDiff {
  const ids = [...new Set([...after.cases.map((c) => c.id), ...before.cases.map((c) => c.id)])];

  const cases: CaseDiff[] = ids.map((id) => {
    const a = before.cases.find((c) => c.id === id);
    const b = after.cases.find((c) => c.id === id);

    if (!a) return { id, change: "new", before: null, after: b?.score ?? null, flipped: [] };
    if (!b) return { id, change: "removed", before: a.score, after: null, flipped: [] };

    const wasVerdicts = verdictOf(before, id);
    const nowVerdicts = verdictOf(after, id);
    const flipped: CaseDiff["flipped"] = [];
    for (const [scorerId, to] of nowVerdicts) {
      const from = wasVerdicts.get(scorerId) ?? null;
      if (from !== to) flipped.push({ scorerId, from, to });
    }

    const change: Change =
      (b.score ?? 0) < (a.score ?? 0)
        ? "regression"
        : (b.score ?? 0) > (a.score ?? 0)
          ? "improvement"
          : "unchanged";

    return { id, change, before: a.score, after: b.score, flipped };
  });

  return {
    suite: after.suite,
    scoreBefore: before.score,
    scoreAfter: after.score,
    cases,
    regressions: cases.filter((c) => c.change === "regression"),
    improvements: cases.filter((c) => c.change === "improvement"),
  };
}

const fmt = (n: number | null): string => (n === null ? "–" : n.toFixed(2));

/** Regressions first, always: that is the thing you opened the diff to find. */
export function renderDiff(diff: ReportDiff): string {
  const arrow = (c: CaseDiff) => `${fmt(c.before)} → ${fmt(c.after)}`;
  const lines: string[] = [`${diff.suite}  ${fmt(diff.scoreBefore)} → ${fmt(diff.scoreAfter)}`, ""];

  if (diff.regressions.length > 0) {
    lines.push(`Regressions (${diff.regressions.length})`);
    for (const c of diff.regressions) {
      lines.push(`  ✗ ${c.id}  ${arrow(c)}`);
      for (const f of c.flipped.filter((f) => f.to === false)) {
        lines.push(`      ${f.scorerId}: ${f.from === null ? "–" : f.from} → ✗`);
      }
    }
    lines.push("");
  }

  if (diff.improvements.length > 0) {
    lines.push(`Improvements (${diff.improvements.length})`);
    for (const c of diff.improvements) lines.push(`  ✓ ${c.id}  ${arrow(c)}`);
    lines.push("");
  }

  const other = diff.cases.filter((c) => c.change === "new" || c.change === "removed");
  for (const c of other) lines.push(`  ${c.change === "new" ? "+" : "-"} ${c.id}  ${arrow(c)}`);
  if (other.length > 0) lines.push("");

  const unchanged = diff.cases.filter((c) => c.change === "unchanged").length;
  lines.push(
    diff.regressions.length === 0
      ? `No regressions. ${unchanged} case(s) unchanged.`
      : `${diff.regressions.length} regression(s).`,
  );
  return `${lines.join("\n")}\n`;
}
