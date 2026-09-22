import { describe, expect, it } from "vitest";
import echoSuite from "../examples/echo-agent/echo.suite.js";
import { columnsOf, renderCell, renderMarkdown, renderTerminal, runSuite } from "../src/index.js";
import type { ScoreEntry } from "../src/index.js";
import failingSuite from "./fixtures/failing.suite.js";

const entry = (over: Partial<ScoreEntry>): ScoreEntry => ({
  pass: true,
  weight: 1,
  reason: "",
  scorerId: "x",
  group: "x",
  label: "x",
  kind: "deterministic",
  critical: false,
  ...over,
});

describe("renderCell", () => {
  it("renders a dash when the scorer did not apply", () => {
    expect(renderCell([])).toBe("–");
    expect(renderCell([entry({ pass: null })])).toBe("–");
  });

  it("renders a bare mark when there is no value", () => {
    expect(renderCell([entry({ pass: true })])).toBe("✓");
    expect(renderCell([entry({ pass: false })])).toBe("✗");
  });

  it("puts the measured value before the mark for budget columns", () => {
    expect(renderCell([entry({ group: "latency", value: 1234 })])).toBe("1.2s ✓");
    expect(renderCell([entry({ group: "cost", value: 0.031, pass: false })])).toBe("$0.0310 ✗");
    expect(renderCell([entry({ group: "tokens", value: 2400 })])).toBe("2.4k ✓");
  });

  it("shows the probability, because that is the payload of a Jev column", () => {
    expect(renderCell([entry({ kind: "jev", probability: 0.9712 })])).toBe("0.97 ✓");
  });

  it("collapses several scorers of one group and shows the ratio", () => {
    expect(renderCell([entry({}), entry({})])).toBe("✓ 2/2");
    expect(renderCell([entry({}), entry({ pass: false })])).toBe("✗ 1/2");
  });

  it("flags a scorer that threw", () => {
    expect(renderCell([entry({ pass: false, error: "boom" })])).toBe("‼");
  });
});

describe("report structure", () => {
  it("has one column per assertion family, not one per scorer", async () => {
    const report = await runSuite(echoSuite);
    const labels = columnsOf(report).map((c) => c.label);
    expect(labels).toEqual([
      "notContains",
      "latency",
      "cost",
      "turns",
      "toolCalled",
      "escalated",
      "contains",
      "escalatedWhen",
      "toolNotCalled",
      "handoff",
    ]);
    // Three different `contains` assertions across the suite, still one column.
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("renderMarkdown", () => {
  it("leads with the headline, then the table, then the failures", async () => {
    const report = await runSuite(failingSuite);
    const md = renderMarkdown(report);
    expect(md.indexOf("**buggy-agent**")).toBe(0);
    expect(md.indexOf("| case")).toBeLessThan(md.indexOf("### Failures"));
    expect(md).toContain("score 0.6");
    expect(md).toContain("descuento");
  });

  it("is stable enough to paste into a PR", async () => {
    const report = await runSuite(failingSuite);
    expect(renderMarkdown(report)).toMatchSnapshot();
  });
});

describe("renderTerminal", () => {
  it("renders the failing suite without throwing and names the failures", async () => {
    const report = await runSuite(failingSuite);
    const out = renderTerminal(report);
    expect(out).toContain("buggy-agent");
    expect(out).toContain("Failures");
    expect(out).toContain("near-floor-offer-haggles");
  });
});
