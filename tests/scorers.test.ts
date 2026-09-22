import { describe, expect, it } from "vitest";
import { z } from "zod";
import { normalizeOutcome, scorers } from "../src/index.js";
import type { Case, OutcomeInput, Score, Scorer, SuiteMeta } from "../src/index.js";

const SUITE: SuiteMeta = { name: "t", threshold: 1 };

const kase = (over: Partial<Case> = {}): Case => ({
  id: "c",
  history: [],
  inbound: { role: "user", text: "hola" },
  expect: {},
  tags: [],
  meta: {},
  weight: 1,
  ...over,
});

const run = (scorer: Scorer, outcome: OutcomeInput, c: Case = kase()): Score =>
  scorer.score({ outcome: normalizeOutcome(outcome), case: c, suite: SUITE }) as Score;

/** Every scorer ships a passing test, a failing test and a skip test. */
describe("toolCalled", () => {
  it("passes when the tool is among the calls", () => {
    const s = run(scorers.toolCalled("lookupStock"), {
      toolCalls: [{ name: "lookupStock", args: {} }],
    });
    expect(s.pass).toBe(true);
  });

  it("fails and names what was called instead", () => {
    const s = run(scorers.toolCalled("lookupStock"), {
      toolCalls: [{ name: "sendQuote", args: {} }],
    });
    expect(s.pass).toBe(false);
    expect(s.reason).toContain("sendQuote");
  });

  it("skips when the agent does not report tool calls", () => {
    expect(run(scorers.toolCalled("x"), { outbound: "hi" }).pass).toBeNull();
  });
});

describe("toolNotCalled", () => {
  it("passes when the tool is absent", () => {
    expect(run(scorers.toolNotCalled("sendQuote"), { toolCalls: [] }).pass).toBe(true);
  });
  it("fails when the tool was called", () => {
    expect(
      run(scorers.toolNotCalled("sendQuote"), { toolCalls: [{ name: "sendQuote", args: {} }] })
        .pass,
    ).toBe(false);
  });
  it("skips when tool calls are not reported", () => {
    expect(run(scorers.toolNotCalled("x"), {}).pass).toBeNull();
  });
});

describe("toolArgs", () => {
  const schema = z.object({ amount: z.number(), currency: z.literal("ARS") });

  it("passes when every call matches", () => {
    const s = run(scorers.toolArgs("registerOffer", schema), {
      toolCalls: [{ name: "registerOffer", args: { amount: 100, currency: "ARS" } }],
    });
    expect(s.pass).toBe(true);
  });

  it("fails and names the offending call", () => {
    const s = run(scorers.toolArgs("registerOffer", schema), {
      toolCalls: [{ name: "registerOffer", args: { amount: "100", currency: "USD" } }],
    });
    expect(s.pass).toBe(false);
    expect(s.reason).toContain("registerOffer(#0)");
  });

  it("skips when tool calls are not reported", () => {
    expect(run(scorers.toolArgs("t", schema), {}).pass).toBeNull();
  });
});

describe("noToolCalled", () => {
  it("passes on an empty list", () => {
    expect(run(scorers.noToolCalled(), { toolCalls: [] }).pass).toBe(true);
  });
  it("fails when any tool ran", () => {
    expect(run(scorers.noToolCalled(), { toolCalls: [{ name: "x", args: {} }] }).pass).toBe(false);
  });
  it("skips when not reported", () => {
    expect(run(scorers.noToolCalled(), {}).pass).toBeNull();
  });
});

describe("escalated", () => {
  it("passes when the agent escalated", () => {
    const s = run(scorers.escalated(), { transitions: [{ type: "escalated", reason: "anger" }] });
    expect(s.pass).toBe(true);
    expect(s.reason).toContain("anger");
  });

  it("fails when it did not", () => {
    expect(run(scorers.escalated(), { transitions: [] }).pass).toBe(false);
  });

  it("supports the negative assertion", () => {
    expect(run(scorers.escalated({ expected: false }), { transitions: [] }).pass).toBe(true);
    expect(
      run(scorers.escalated({ expected: false }), { transitions: [{ type: "escalated" }] }).pass,
    ).toBe(false);
  });

  it("checks the reason when one is required", () => {
    const scorer = scorers.escalated({ reason: "price_negotiation" });
    expect(run(scorer, { transitions: [{ type: "escalated", reason: "anger" }] }).pass).toBe(false);
    expect(
      run(scorer, { transitions: [{ type: "escalated", reason: "price_negotiation" }] }).pass,
    ).toBe(true);
  });

  it("skips when transitions are not reported", () => {
    expect(run(scorers.escalated(), {}).pass).toBeNull();
  });
});

describe("escalatedWhen", () => {
  const scorer = scorers.escalatedWhen({ intent: "price_negotiation" });

  it("applies only to cases whose declared intent matches", () => {
    expect(scorer.when?.(kase({ meta: { intent: "price_negotiation" } }))).toBe(true);
    expect(scorer.when?.(kase({ tags: ["price_negotiation"] }))).toBe(true);
    expect(scorer.when?.(kase({ meta: { intent: "stock_question" } }))).toBe(false);
  });

  it("passes when a matching case escalated", () => {
    const s = run(
      scorer,
      { transitions: [{ type: "escalated" }] },
      kase({ meta: { intent: "price_negotiation" } }),
    );
    expect(s.pass).toBe(true);
  });

  it("fails when a matching case did not escalate", () => {
    const s = run(scorer, { transitions: [] }, kase({ meta: { intent: "price_negotiation" } }));
    expect(s.pass).toBe(false);
  });
});

describe("contains / notContains", () => {
  it("requires every needle by default and reports the missing ones", () => {
    expect(run(scorers.contains(["a", "b"]), { outbound: "a and b" }).pass).toBe(true);
    const s = run(scorers.contains(["a", "b"]), { outbound: "only a" });
    expect(s.pass).toBe(false);
    expect(s.reason).toContain("b");
  });

  it('accepts mode "any"', () => {
    expect(run(scorers.contains(["a", "zz"], { mode: "any" }), { outbound: "a" }).pass).toBe(true);
  });

  it("ignores case and accents unless asked not to", () => {
    expect(run(scorers.contains("descuento"), { outbound: "DESCUENTÓ" }).pass).toBe(true);
    expect(
      run(scorers.contains("descuento", { caseSensitive: true }), { outbound: "DESCUENTO" }).pass,
    ).toBe(false);
  });

  it("notContains fails on any forbidden needle", () => {
    expect(run(scorers.notContains(["descuento"]), { outbound: "sin rebajas" }).pass).toBe(true);
    const s = run(scorers.notContains(["descuento", "discount"]), {
      outbound: "te hago descuento",
    });
    expect(s.pass).toBe(false);
    expect(s.reason).toContain("descuento");
  });
});

describe("matches", () => {
  it("passes and fails on the pattern", () => {
    expect(run(scorers.matches(/USD \d+/), { outbound: "USD 18500" }).pass).toBe(true);
    expect(run(scorers.matches(/USD \d+/), { outbound: "no price" }).pass).toBe(false);
  });

  it("does not carry lastIndex between calls with a /g pattern", () => {
    const scorer = scorers.matches(/a/g);
    expect(run(scorer, { outbound: "a" }).pass).toBe(true);
    expect(run(scorer, { outbound: "a" }).pass).toBe(true);
  });
});

describe("replied", () => {
  it("passes on a non-empty reply and fails on silence", () => {
    expect(run(scorers.replied(), { outbound: "hola" }).pass).toBe(true);
    expect(run(scorers.replied(), { outbound: [] }).pass).toBe(false);
    expect(run(scorers.replied(), { outbound: "   " }).pass).toBe(false);
  });
});

describe("schema", () => {
  const shape = z.object({ ok: z.boolean() });

  it("passes on valid JSON", () => {
    expect(run(scorers.schema(shape), { outbound: '{"ok":true}' }).pass).toBe(true);
  });
  it("fails on invalid JSON", () => {
    expect(run(scorers.schema(shape), { outbound: "not json" }).reason).toContain("not valid JSON");
  });
  it("fails when the shape rejects", () => {
    expect(run(scorers.schema(shape), { outbound: '{"ok":"yes"}' }).pass).toBe(false);
  });
});

describe("budget scorers", () => {
  it("latencyUnder passes, fails and skips", () => {
    expect(run(scorers.latencyUnder(1000), { latencyMs: 500 }).pass).toBe(true);
    const s = run(scorers.latencyUnder(1000), { latencyMs: 20_000 });
    expect(s.pass).toBe(false);
    expect(s.reason).toBe("20.0s > 1.0s");
    expect(run(scorers.latencyUnder(1000), {}).pass).toBeNull();
  });

  it("costUnder passes, fails and skips", () => {
    expect(run(scorers.costUnder(0.05), { costUsd: 0.01 }).pass).toBe(true);
    expect(run(scorers.costUnder(0.05), { costUsd: 0.2 }).pass).toBe(false);
    expect(run(scorers.costUnder(0.05), {}).pass).toBeNull();
  });

  it("tokensUnder sums input and output", () => {
    expect(
      run(scorers.tokensUnder(100), { tokens: { inputTokens: 60, outputTokens: 30 } }).pass,
    ).toBe(true);
    expect(
      run(scorers.tokensUnder(100), { tokens: { inputTokens: 90, outputTokens: 30 } }).pass,
    ).toBe(false);
    expect(run(scorers.tokensUnder(100), {}).pass).toBeNull();
  });

  it("maxTurns passes, fails and skips", () => {
    expect(run(scorers.maxTurns(3), { turns: 2 }).pass).toBe(true);
    expect(run(scorers.maxTurns(3), { turns: 9 }).pass).toBe(false);
    expect(run(scorers.maxTurns(3), {}).pass).toBeNull();
  });

  it("treats the limit as inclusive", () => {
    expect(run(scorers.latencyUnder(1000), { latencyMs: 1000 }).pass).toBe(true);
  });
});
