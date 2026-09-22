import { outboundText } from "../core/normalize.js";
import type { Report } from "../core/types.js";
import { columnsOf, entriesByGroup, failuresOf, formatScore, renderCell } from "./cells.js";

const pad = (s: string, width: number): string =>
  s + " ".repeat(Math.max(0, width - [...s].length));

function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = (rows[0] as string[]).map((_, i) =>
    Math.max(...rows.map((r) => [...(r[i] ?? "")].length)),
  );
  const line = (r: string[]) => `| ${r.map((c, i) => pad(c, widths[i] as number)).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(Math.max(3, w))).join(" | ")} |`;
  return [line(rows[0] as string[]), sep, ...rows.slice(1).map(line)].join("\n");
}

/**
 * The artifact. Written so it can be pasted into a PR comment as-is:
 * headline, table, then the failures — never the other way round.
 */
export function renderMarkdown(report: Report): string {
  const columns = columnsOf(report);
  const verdict = report.passed ? "✓" : "✗";
  const head = `**${report.suite}** — score ${formatScore(report.score)} (threshold ${report.threshold.toFixed(2)}) ${verdict}`;

  const header = ["case", ...columns.map((c) => c.label), "score"];
  const rows = report.cases.map((c) => {
    const byGroup = entriesByGroup(c);
    return [
      c.id,
      ...columns.map((col) => renderCell(byGroup.get(col.group) ?? [])),
      formatScore(c.score),
    ];
  });

  const parts = [head, "", table([header, ...rows])];

  const failing = report.cases.filter((c) => failuresOf(c).length > 0 || c.status === "error");
  if (failing.length > 0) {
    parts.push("", "### Failures", "");
    for (const c of failing) {
      parts.push(`**${c.id}**${c.name ? ` — ${c.name}` : ""}`);
      if (c.error) parts.push(`- agent error: \`${c.error.message}\``);
      for (const f of failuresOf(c)) parts.push(`- \`${f.label}\`: ${f.reason}`);
      if (c.outcome) {
        const reply = outboundText(c.outcome).trim();
        if (reply) parts.push(`- reply: ${JSON.stringify(reply.slice(0, 280))}`);
        const calls = c.outcome.toolCalls ?? [];
        if (calls.length > 0) {
          parts.push(
            `- tools: ${calls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join(", ")}`,
          );
        }
      }
      parts.push("");
    }
  }

  // No wall clock here on purpose: this string is the artifact, and the artifact
  // must be byte-identical across two runs of the same suite.
  const graded = report.cases.filter((c) => c.status !== "skipped").length;
  parts.push("", `${graded} case(s), ${report.scorers.length} scorer(s)`);
  return `${parts.join("\n").trimEnd()}\n`;
}
