import { describe, expect, it } from "vitest";
import {
  calibrate,
  collectPoints,
  diffReports,
  renderCalibration,
  renderDiff,
} from "../src/index.js";
import type { CaseReport, Report, ScoreEntry } from "../src/index.js";

const entry = (over: Partial<ScoreEntry>): ScoreEntry => ({
  pass: true,
  weight: 1,
  reason: "",
  scorerId: "s",
  group: "s",
  label: "s",
  kind: "deterministic",
  critical: false,
  ...over,
});

const caseOf = (id: string, score: number | null, scores: ScoreEntry[] = []): CaseReport => ({
  id,
  tags: [],
  status: "ok",
  score,
  weight: 1,
  scores,
  durationMs: 1,
});

const reportOf = (cases: CaseReport[], score: number | null): Report => ({
  version: 1,
  suite: "s",
  threshold: 0.9,
  score,
  passed: (score ?? 0) >= 0.9,
  cases,
  scorers: [],
  usage: {},
  runMeta: {
    startedAt: "2026-09-22T00:00:00.000Z",
    durationMs: 1,
    includeLlmJudge: false,
    agentEvalsVersion: "test",
    cassetteMode: "replay",
    cassetteHits: 0,
    cassetteMisses: 0,
  },
});

describe("diff", () => {
  it("finds a case that got worse and names the scorer that flipped", () => {
    const before = reportOf([caseOf("a", 1, [entry({ scorerId: "escalated", pass: true })])], 1);
    const after = reportOf([caseOf("a", 0, [entry({ scorerId: "escalated", pass: false })])], 0);

    const diff = diffReports(before, after);
    expect(diff.regressions).toHaveLength(1);
    expect(diff.regressions[0]).toMatchObject({ id: "a", before: 1, after: 0 });
    expect(diff.regressions[0]?.flipped).toEqual([
      { scorerId: "escalated", from: true, to: false },
    ]);
  });

  it("reports an improvement without treating it as a problem", () => {
    const diff = diffReports(reportOf([caseOf("a", 0)], 0), reportOf([caseOf("a", 1)], 1));
    expect(diff.improvements.map((c) => c.id)).toEqual(["a"]);
    expect(diff.regressions).toHaveLength(0);
  });

  it("tracks cases that appeared or disappeared", () => {
    const diff = diffReports(reportOf([caseOf("gone", 1)], 1), reportOf([caseOf("fresh", 1)], 1));
    expect(diff.cases.map((c) => [c.id, c.change]).sort()).toEqual([
      ["fresh", "new"],
      ["gone", "removed"],
    ]);
  });

  it("ignores timings, so two machines do not disagree", () => {
    const a = reportOf([caseOf("x", 1)], 1);
    const b: Report = {
      ...reportOf([{ ...caseOf("x", 1), durationMs: 9999 }], 1),
      runMeta: { ...a.runMeta, durationMs: 4242, startedAt: "2027-01-01T00:00:00.000Z" },
    };
    expect(diffReports(a, b).regressions).toHaveLength(0);
  });

  it("leads with regressions and says so when there are none", () => {
    const clean = renderDiff(
      diffReports(reportOf([caseOf("a", 1)], 1), reportOf([caseOf("a", 1)], 1)),
    );
    expect(clean).toContain("No regressions");

    const broken = renderDiff(
      diffReports(reportOf([caseOf("a", 1)], 1), reportOf([caseOf("a", 0)], 0)),
    );
    expect(broken.indexOf("Regressions")).toBeLessThan(broken.indexOf("1 regression"));
  });
});

describe("calibrate", () => {
  const points = (spec: [number, boolean][]) =>
    spec.map(([probability, truth]) => ({ probability, truth }));

  it("buckets predictions and measures the gap between promise and reality", () => {
    // Says 0.9, is right 1 in 2. That is an overconfident model.
    const c = calibrate(
      "jev:q",
      points([
        [0.95, true],
        [0.92, false],
      ]),
    );
    const bucket = c.buckets.find((b) => b.from === 0.9);
    expect(bucket).toMatchObject({ count: 2 });
    expect(bucket?.observed).toBe(0.5);
    expect(c.maxGap).toBeCloseTo(0.435, 2);
  });

  it("scores a perfectly calibrated set near zero and a coin flip near 0.25", () => {
    const perfect = calibrate(
      "s",
      points([
        [1, true],
        [0, false],
        [1, true],
      ]),
    );
    expect(perfect.brier).toBe(0);
    const coinflip = calibrate(
      "s",
      points([
        [0.5, true],
        [0.5, false],
      ]),
    );
    expect(coinflip.brier).toBe(0.25);
  });

  it("finds the lowest threshold that was still perfect", () => {
    const c = calibrate(
      "s",
      points([
        [0.95, true],
        [0.91, true],
        [0.7, false],
        [0.2, false],
      ]),
    );
    expect(c.safeThreshold).not.toBeNull();
    expect(c.safeThreshold).toBeGreaterThan(0.7);
    expect(c.safeThreshold).toBeLessThanOrEqual(0.91);
  });

  it("reports no safe threshold when even the top prediction was wrong", () => {
    expect(calibrate("s", points([[0.99, false]])).safeThreshold).toBeNull();
  });

  it("says what to do instead of printing a confident empty table", () => {
    const out = renderCalibration(calibrate("jev:answers", [], 12));
    expect(out).toContain("nothing to calibrate");
    expect(out).toContain('meta: { expected: { "jev:answers": true } }');
  });

  it("explains what the gap means, because a threshold is the whole point", () => {
    const out = renderCalibration(
      calibrate(
        "s",
        points([
          [0.9, true],
          [0.9, true],
        ]),
      ),
    );
    expect(out).toContain("brier=");
    expect(out).toMatch(/Pick your threshold from this table/);
  });
});

describe("collectPoints", () => {
  const jevEntry = (scorerId: string, probability: number) =>
    entry({ scorerId, probability, kind: "jev" });

  it("reads ground truth from the case, keyed by scorer", () => {
    const report = reportOf([caseOf("a", 1, [jevEntry("jev:q", 0.9)])], 1);
    const cases = [{ id: "a", meta: { expected: { "jev:q": true } } }];
    const collected = collectPoints(report, cases);
    expect(collected.get("jev:q")?.points).toEqual([{ probability: 0.9, truth: true }]);
  });

  it("accepts a single `label` for a one-judge suite", () => {
    const report = reportOf([caseOf("a", 1, [jevEntry("jev:q", 0.3)])], 1);
    const collected = collectPoints(report, [{ id: "a", meta: { label: false } }]);
    expect(collected.get("jev:q")?.points).toEqual([{ probability: 0.3, truth: false }]);
  });

  it("counts unlabelled predictions instead of guessing at them", () => {
    const report = reportOf([caseOf("a", 1, [jevEntry("jev:q", 0.9)])], 1);
    const collected = collectPoints(report, [{ id: "a", meta: {} }]);
    expect(collected.get("jev:q")).toEqual({ points: [], unlabelled: 1 });
  });

  it("ignores deterministic scorers, which have no probability to calibrate", () => {
    const report = reportOf([caseOf("a", 1, [entry({ scorerId: "escalated" })])], 1);
    expect(collectPoints(report, [{ id: "a", meta: { label: true } }]).size).toBe(0);
  });
});
