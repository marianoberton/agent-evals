import { describe, expect, it } from "vitest";
import { caseScore, meetsThreshold, suiteScore } from "../src/index.js";
import type { CaseReport, Score, ScoreEntry } from "../src/index.js";

const s = (pass: boolean | null, weight = 1): Score => ({ pass, weight, reason: "" });

const entry = (pass: boolean | null, critical = false): ScoreEntry => ({
  pass,
  weight: 1,
  reason: "",
  scorerId: "x",
  group: "x",
  label: "x",
  kind: "deterministic",
  critical,
});

const caseOf = (over: Partial<CaseReport>): CaseReport => ({
  id: "c",
  tags: [],
  status: "ok",
  score: 1,
  weight: 1,
  scores: [],
  durationMs: 0,
  ...over,
});

describe("caseScore", () => {
  it("is the weighted pass rate", () => {
    expect(caseScore([s(true), s(false)])).toBe(0.5);
    expect(caseScore([s(true, 3), s(false, 1)])).toBe(0.75);
  });

  it("leaves skips out of both sides of the ratio", () => {
    expect(caseScore([s(true), s(null), s(null)])).toBe(1);
    expect(caseScore([s(false), s(null)])).toBe(0);
  });

  it("is null when every scorer skipped", () => {
    expect(caseScore([s(null), s(null)])).toBeNull();
    expect(caseScore([])).toBeNull();
  });
});

describe("suiteScore", () => {
  it("is a case-weighted mean, so a case with many scorers does not outvote one with few", () => {
    const wide = caseOf({ id: "wide", score: 1, scores: Array(12).fill(entry(true)) });
    const narrow = caseOf({ id: "narrow", score: 0, scores: [entry(false)] });
    expect(suiteScore([wide, narrow])).toBe(0.5);
  });

  it("honours case weight", () => {
    expect(suiteScore([caseOf({ score: 1, weight: 3 }), caseOf({ score: 0, weight: 1 })])).toBe(
      0.75,
    );
  });

  it("scores a crashed agent as zero, not as a skip", () => {
    expect(suiteScore([caseOf({ score: 1 }), caseOf({ status: "error", score: 0 })])).toBe(0.5);
  });

  it("drops all-skip cases from the aggregate", () => {
    expect(suiteScore([caseOf({ score: 1 }), caseOf({ score: null })])).toBe(1);
  });

  it("is null when nothing was graded", () => {
    expect(suiteScore([])).toBeNull();
  });
});

describe("meetsThreshold", () => {
  it("passes at exactly the threshold despite float noise", () => {
    // 0.9 as 9 passes of 10 lands on 0.8999999999999999 without rounding.
    const cases = Array.from({ length: 10 }, (_, i) =>
      caseOf({ id: `c${i}`, score: i < 9 ? 1 : 0 }),
    );
    expect(suiteScore(cases)).toBe(0.9);
    expect(meetsThreshold(suiteScore(cases), 0.9, cases)).toBe(true);
  });

  it("fails under the threshold", () => {
    expect(meetsThreshold(0.89, 0.9, [])).toBe(false);
  });

  it("fails on a critical failure regardless of the aggregate", () => {
    const cases = [caseOf({ score: 1, scores: [entry(false, true), entry(true)] })];
    expect(meetsThreshold(1, 0.5, cases)).toBe(false);
  });

  it("does not pass a suite that graded nothing", () => {
    expect(meetsThreshold(null, 0, [])).toBe(false);
  });
});
