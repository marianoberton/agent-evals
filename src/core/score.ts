import type { CaseReport, Score, ScoreEntry, Scorer } from "./types.js";

/** Rounded before comparison so 0.8999999999999999 never fails a 0.9 gate. */
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

const EPSILON = 1e-9;

export interface ScoreInit {
  reason: string;
  weight?: number;
  value?: string | number | boolean;
  probability?: number;
  probabilities?: Readonly<Record<string, number>>;
  confidence?: number;
}

const make = (verdict: boolean | null, init: ScoreInit): Score => ({
  ...init,
  pass: verdict,
  weight: init.weight ?? 1,
});

export const pass = (init: ScoreInit): Score => make(true, init);
export const fail = (init: ScoreInit): Score => make(false, init);

/**
 * Not applicable to this case. Renders `–` and leaves both sides of the ratio.
 * Use it when the field a scorer needs was never reported by the agent — never
 * to hide a real failure.
 */
export const skip = (init: ScoreInit): Score => make(null, init);

export const errored = (reason: string, error: string, weight = 1): Score => ({
  pass: false,
  weight,
  reason,
  error,
});

export function toEntry(scorer: Scorer, score: Score): ScoreEntry {
  const group = scorer.group ?? scorer.id.split(":")[0] ?? scorer.id;
  return {
    ...score,
    scorerId: scorer.id,
    group,
    label: scorer.label ?? group,
    kind: scorer.kind,
    critical: scorer.critical ?? false,
  };
}

/**
 * Weighted pass rate over the applicable scorers of one case.
 * `null` when every scorer skipped — that case leaves the aggregate entirely.
 */
export function caseScore(scores: readonly Score[]): number | null {
  let num = 0;
  let den = 0;
  for (const s of scores) {
    if (s.pass === null) continue;
    den += s.weight;
    if (s.pass) num += s.weight;
  }
  return den === 0 ? null : round6(num / den);
}

/**
 * Case-weighted mean of the case scores (macro), not a scorer-weighted mean
 * (micro): a case with twelve scorers must not outvote a case with three.
 * `case.weight` is the deliberate override.
 */
export function suiteScore(cases: readonly CaseReport[]): number | null {
  let num = 0;
  let den = 0;
  for (const c of cases) {
    if (c.status === "skipped") continue;
    const s = c.status === "error" ? 0 : c.score;
    if (s === null) continue;
    num += s * c.weight;
    den += c.weight;
  }
  return den === 0 ? null : round6(num / den);
}

export function hasCriticalFailure(cases: readonly CaseReport[]): boolean {
  return cases.some((c) => c.scores.some((s) => s.critical && s.pass === false));
}

export function meetsThreshold(
  score: number | null,
  threshold: number,
  cases: readonly CaseReport[],
): boolean {
  if (score === null) return false;
  if (hasCriticalFailure(cases)) return false;
  return score + EPSILON >= threshold;
}
