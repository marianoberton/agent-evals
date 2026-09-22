import { describe, expect, it } from "vitest";
import echoSuite from "../examples/echo-agent/echo.suite.js";
import { renderMarkdown, runSuite } from "../src/index.js";
import type { Report } from "../src/index.js";
import failingSuite from "./fixtures/failing.suite.js";

/**
 * The invariant: the same suite produces the same report twice. Anything that
 * cannot hold that promise — wall clock, machine load — lives in `runMeta` and
 * in `CaseReport.durationMs`, which is exactly what `agent-evals diff` ignores.
 */
const stable = (r: Report) => ({
  ...r,
  cases: r.cases.map((c) => ({ ...c, durationMs: 0 })),
  runMeta: undefined,
});

describe("determinism", () => {
  it.each([
    ["echo-agent", echoSuite],
    ["buggy-agent", failingSuite],
  ])("%s produces an identical report twice", async (_name, suite) => {
    const a = await runSuite(suite);
    const b = await runSuite(suite);
    expect(stable(a)).toEqual(stable(b));
    expect(renderMarkdown(a)).toBe(renderMarkdown(b));
  });

  it("keeps every non-reproducible value inside runMeta", async () => {
    const report = await runSuite(echoSuite);
    expect(Object.keys(report.runMeta).sort()).toEqual([
      "agentEvalsVersion",
      "cassetteHits",
      "cassetteMisses",
      "cassetteMode",
      "durationMs",
      "includeLlmJudge",
      "startedAt",
    ]);
  });
});
