import { describe, expect, it } from "vitest";
import suite from "../examples/echo-agent/echo.suite.js";
import { runSuite } from "../src/index.js";

/** The M0 gate: the example the README shows must pass, with nothing mocked. */
describe("examples/echo-agent", () => {
  it("passes its own suite", async () => {
    const report = await runSuite(suite);
    expect(report.score).toBe(1);
    expect(report.passed).toBe(true);
  });

  it("grades every case with at least one scorer", async () => {
    const report = await runSuite(suite);
    for (const c of report.cases) {
      expect(c.status).toBe("ok");
      expect(c.score, `case ${c.id} graded nothing`).not.toBeNull();
    }
  });

  it("escalates on a price push and keeps sendQuote out of it", async () => {
    const report = await runSuite(suite, { only: ["price-negotiation-escalates"] });
    const c = report.cases[0]!;
    expect(c.outcome?.transitions).toEqual([{ type: "escalated", reason: "price_negotiation" }]);
    expect(c.outcome?.toolCalls).toEqual([]);
  });

  it("filters by tag", async () => {
    const report = await runSuite(suite, { tags: ["policy"] });
    expect(report.cases.map((c) => c.id)).toEqual([
      "price-negotiation-escalates",
      "discount-request-escalates",
      "wants-human-hands-off",
    ]);
  });
});
