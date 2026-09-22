import type { Report } from "../core/types.js";

/**
 * Calibration: does a probability of 0.9 actually mean "right nine times out of ten"?
 *
 * This is the answer to the one honest objection to gating on Jev. Jev cannot
 * return a value outside your schema, but it can return the wrong one inside it.
 * A threshold is only trustworthy if the probabilities are calibrated, and the
 * only way to know is to compare them against cases whose answer you already
 * know. `calibrate` is that comparison.
 *
 * Ground truth comes from the case: `meta.expected[scorerId]`, or `meta.label`
 * for a single-judge suite. Cases without a label are skipped and counted, so a
 * suite that labels nothing says so instead of printing a confident empty table.
 */

export interface Bucket {
  /** Lower edge, e.g. 0.9 for the 0.9–1.0 bucket. */
  from: number;
  to: number;
  count: number;
  /** Mean probability the model gave in this bucket. */
  predicted: number;
  /** Fraction that were actually true. */
  observed: number;
}

export interface Calibration {
  scorerId: string;
  n: number;
  unlabelled: number;
  buckets: Bucket[];
  /** Mean squared error of the probabilities. Lower is better; 0.25 is a coin flip. */
  brier: number;
  /** Largest gap between predicted and observed across populated buckets. */
  maxGap: number;
  /** The lowest threshold at which every prediction above it was correct. */
  safeThreshold: number | null;
}

interface Point {
  probability: number;
  truth: boolean;
}

function groundTruth(
  caseMeta: Readonly<Record<string, unknown>>,
  scorerId: string,
): boolean | undefined {
  const expected = caseMeta.expected;
  if (expected && typeof expected === "object") {
    const v = (expected as Record<string, unknown>)[scorerId];
    if (typeof v === "boolean") return v;
  }
  if (typeof caseMeta.label === "boolean") return caseMeta.label;
  return undefined;
}

export function collectPoints(
  report: Report,
  cases: readonly { id: string; meta: Readonly<Record<string, unknown>> }[],
): Map<string, { points: Point[]; unlabelled: number }> {
  const byScorer = new Map<string, { points: Point[]; unlabelled: number }>();
  const metaById = new Map(cases.map((c) => [c.id, c.meta]));

  for (const caseReport of report.cases) {
    const meta = metaById.get(caseReport.id) ?? {};
    for (const entry of caseReport.scores) {
      if (entry.kind !== "jev" || entry.probability === undefined) continue;
      let bucket = byScorer.get(entry.scorerId);
      if (!bucket) {
        bucket = { points: [], unlabelled: 0 };
        byScorer.set(entry.scorerId, bucket);
      }
      const truth = groundTruth(meta, entry.scorerId);
      if (truth === undefined) bucket.unlabelled += 1;
      else bucket.points.push({ probability: entry.probability, truth });
    }
  }
  return byScorer;
}

export function calibrate(scorerId: string, points: readonly Point[], unlabelled = 0): Calibration {
  const buckets: Bucket[] = Array.from({ length: 10 }, (_, i) => ({
    from: i / 10,
    to: (i + 1) / 10,
    count: 0,
    predicted: 0,
    observed: 0,
  }));

  let brierSum = 0;
  for (const p of points) {
    const index = Math.min(9, Math.max(0, Math.floor(p.probability * 10)));
    const bucket = buckets[index] as Bucket;
    bucket.count += 1;
    bucket.predicted += p.probability;
    bucket.observed += p.truth ? 1 : 0;
    brierSum += (p.probability - (p.truth ? 1 : 0)) ** 2;
  }

  for (const b of buckets) {
    if (b.count === 0) continue;
    b.predicted /= b.count;
    b.observed /= b.count;
  }

  const populated = buckets.filter((b) => b.count > 0);
  const maxGap = populated.reduce((m, b) => Math.max(m, Math.abs(b.predicted - b.observed)), 0);

  // Walk thresholds down from 1.0 and stop at the last one that was still perfect.
  let safeThreshold: number | null = null;
  for (let t = 100; t >= 0; t--) {
    const threshold = t / 100;
    const above = points.filter((p) => p.probability >= threshold);
    if (above.length === 0) continue;
    if (above.every((p) => p.truth)) safeThreshold = threshold;
    else break;
  }

  return {
    scorerId,
    n: points.length,
    unlabelled,
    buckets,
    brier: points.length === 0 ? 0 : brierSum / points.length,
    maxGap,
    safeThreshold,
  };
}

export function renderCalibration(c: Calibration): string {
  if (c.n === 0) {
    return (
      `${c.scorerId}: nothing to calibrate.\n` +
      `  ${c.unlabelled} prediction(s) had no ground truth. Add \`meta: { expected: { "${c.scorerId}": true } }\`\n` +
      "  to the cases whose right answer you already know.\n"
    );
  }

  const lines = [
    `${c.scorerId}  n=${c.n}  brier=${c.brier.toFixed(3)}  max gap=${c.maxGap.toFixed(2)}`,
    "",
    "  probability   n   predicted  observed   gap",
  ];
  for (const b of c.buckets) {
    if (b.count === 0) continue;
    const gap = b.observed - b.predicted;
    const bar = "█".repeat(Math.round(b.observed * 10)).padEnd(10, "·");
    lines.push(
      `  ${b.from.toFixed(1)}–${b.to.toFixed(1)}  ${String(b.count).padStart(4)}` +
        `      ${b.predicted.toFixed(2)}      ${b.observed.toFixed(2)}  ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}  ${bar}`,
    );
  }
  lines.push("");
  lines.push(
    c.safeThreshold === null
      ? "  No threshold was perfect on this data — every cut let a wrong answer through."
      : `  Every prediction at or above ${c.safeThreshold.toFixed(2)} was correct here.`,
  );
  if (c.unlabelled > 0) lines.push(`  (${c.unlabelled} prediction(s) skipped: no ground truth)`);
  lines.push(
    "",
    "  A gap near zero means the probability means what it says. A large positive gap",
    "  means the model is underconfident; negative means it promises more than it delivers.",
    "  Pick your threshold from this table, not from taste — and re-run it when the",
    "  question, the model or the prompt changes.",
  );
  return `${lines.join("\n")}\n`;
}
