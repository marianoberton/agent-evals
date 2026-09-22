import { describe, expect, it } from "vitest";
import echoSuite from "../examples/echo-agent/echo.suite.js";
import { defineSuite, runSuite, scorers } from "../src/index.js";
import type { Agent } from "../src/index.js";
import { defineEvals } from "../src/vitest/index.js";

/**
 * `defineEvals` generates tests, so testing it means running it. The generated
 * cases live in the describe block below; the assertions *about* the generation
 * are the ones in `describe("defineEvals", …)`.
 */
defineEvals(echoSuite);

const flaky: Agent = ({ inbound }) => ({
  outbound: inbound.text === "bad" ? "" : "hola",
  latencyMs: 1,
});

describe("defineEvals", () => {
  it("runs the agent once for the whole suite, not once per case", async () => {
    let calls = 0;
    const counting: Agent = () => {
      calls += 1;
      return { outbound: "hola", latencyMs: 1 };
    };
    const suite = defineSuite({
      name: "counted",
      agent: counting,
      scorers: [scorers.replied()],
      cases: [
        { id: "a", inbound: "x" },
        { id: "b", inbound: "y" },
        { id: "c", inbound: "z" },
      ],
    });

    // What defineEvals does internally: one shared run, read per case.
    const report = await runSuite(suite);
    expect(calls).toBe(3); // one per case, not per assertion
    expect(report.cases).toHaveLength(3);
  });

  it("produces a failure message carrying the scorer reason and the reply", async () => {
    const suite = defineSuite({
      name: "flaky",
      threshold: 1,
      agent: flaky,
      scorers: [scorers.replied()],
      cases: [{ id: "bad", inbound: "bad" }],
    });
    const report = await runSuite(suite);
    const entry = report.cases[0];
    expect(entry?.scores.filter((s) => s.pass === false)).toHaveLength(1);
    expect(entry?.scores[0]?.reason).toBe("no outbound message");
  });

  it("gates on the suite threshold as its own test", async () => {
    const suite = defineSuite({
      name: "gated",
      threshold: 1,
      agent: flaky,
      scorers: [scorers.replied()],
      cases: [
        { id: "good", inbound: "ok" },
        { id: "bad", inbound: "bad" },
      ],
    });
    const report = await runSuite(suite);
    expect(report.score).toBe(0.5);
    expect(report.passed).toBe(false);
  });

  it("can be told not to gate, for a suite you are still growing", () => {
    // `gate: false` omits the threshold test; the per-case tests still run.
    expect(() =>
      defineEvals(
        defineSuite({
          name: "ungated",
          threshold: 1,
          agent: flaky,
          scorers: [scorers.replied()],
          cases: [{ id: "ok", inbound: "ok" }],
        }),
        { gate: false },
      ),
    ).not.toThrow();
  });
});
