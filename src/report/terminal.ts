import pc from "picocolors";
import { outboundText } from "../core/normalize.js";
import type { Report } from "../core/types.js";
import {
  CROSS,
  TICK,
  columnsOf,
  entriesByGroup,
  failuresOf,
  formatScore,
  renderCell,
} from "./cells.js";

// Built rather than written as a literal: an ESC byte inside a regex source is a
// control character, which linters reject and reviewers cannot see.
const ANSI = new RegExp(`${String.fromCharCode(27)}\[[0-9;]*m`, "g");

/** Printable width, so colour codes do not push the columns out of alignment. */
const width = (s: string): number => [...s.replace(ANSI, "")].length;
const pad = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - width(s)));

const paint = (cell: string): string => {
  if (cell.includes(TICK)) return pc.green(cell);
  if (cell.includes(CROSS)) return pc.red(cell);
  if (cell.includes("‼")) return pc.yellow(cell);
  return pc.dim(cell);
};

export function renderTerminal(report: Report): string {
  const columns = columnsOf(report);
  const header = ["case", ...columns.map((c) => c.label), "score"];
  const raw = report.cases.map((c) => {
    const byGroup = entriesByGroup(c);
    return [
      c.id,
      ...columns.map((col) => renderCell(byGroup.get(col.group) ?? [])),
      formatScore(c.score),
    ];
  });

  const widths = header.map((h, i) => Math.max(width(h), ...raw.map((r) => width(r[i] ?? ""))));

  const verdict = report.passed ? pc.green(`${TICK} pass`) : pc.red(`${CROSS} fail`);
  const score = report.passed
    ? pc.green(formatScore(report.score))
    : pc.red(formatScore(report.score));
  const lines: string[] = [
    "",
    `${pc.bold(report.suite)}  score ${score}  (threshold ${report.threshold.toFixed(2)})  ${verdict}`,
    "",
    pc.dim(header.map((h, i) => pad(h, widths[i] as number)).join("  ")),
  ];

  for (const [i, row] of raw.entries()) {
    const c = report.cases[i];
    const cells = row.map((cell, j) =>
      j === 0 ? pad(cell, widths[j] as number) : pad(paint(cell), widths[j] as number),
    );
    lines.push(cells.join("  ").trimEnd());
    if (c && c.status === "error") lines.push(pc.red(`    ! ${c.error?.message ?? "agent error"}`));
  }

  const failing = report.cases.filter((c) => failuresOf(c).length > 0);
  if (failing.length > 0) {
    lines.push("", pc.bold("Failures"));
    for (const c of failing) {
      lines.push(`  ${pc.red(CROSS)} ${pc.bold(c.id)}`);
      for (const f of failuresOf(c)) lines.push(`      ${pc.dim(f.label)}  ${f.reason}`);
      if (c.outcome) {
        const reply = outboundText(c.outcome).trim().replace(/\s+/g, " ");
        if (reply) lines.push(pc.dim(`      reply: ${reply.slice(0, 160)}`));
      }
    }
  }

  lines.push("", pc.dim(`${report.cases.length} case(s) in ${report.runMeta.durationMs}ms`), "");
  return lines.join("\n");
}
