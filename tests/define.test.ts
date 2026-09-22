import { describe, expect, it } from "vitest";
import {
  SuiteDefinitionError,
  defineCase,
  defineSuite,
  scorers,
  scorersFor,
} from "../src/index.js";
import type { Agent } from "../src/index.js";

const agent: Agent = () => ({ outbound: "ok" });

describe("defineCase", () => {
  it("normalises inbound and history", () => {
    const c = defineCase({
      id: "a",
      history: ["hola", { role: "assistant", content: "hi" }],
      inbound: "¿precio?",
    });
    expect(c.history).toEqual([
      { role: "user", text: "hola" },
      { role: "assistant", text: "hi" },
    ]);
    expect(c.inbound).toEqual({ role: "user", text: "¿precio?" });
  });

  it("fills the defaults a report relies on", () => {
    const c = defineCase({ id: "a", inbound: "x" });
    expect(c).toMatchObject({ tags: [], meta: {}, expect: {}, weight: 1 });
  });

  it("rejects an empty id", () => {
    expect(() => defineCase({ id: "", inbound: "x" })).toThrow(SuiteDefinitionError);
  });
});

describe("defineSuite", () => {
  it("accepts raw case objects as well as defineCase results", () => {
    const suite = defineSuite({
      name: "t",
      agent,
      cases: [{ id: "a", inbound: "x" }, defineCase({ id: "b", inbound: "y" })],
    });
    expect(suite.cases.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("defaults the threshold to 1, so a new suite starts strict", () => {
    expect(defineSuite({ name: "t", agent, cases: [{ id: "a", inbound: "x" }] }).threshold).toBe(1);
  });

  it("rejects a duplicate case id at definition time", () => {
    expect(() =>
      defineSuite({
        name: "t",
        agent,
        cases: [
          { id: "a", inbound: "x" },
          { id: "a", inbound: "y" },
        ],
      }),
    ).toThrow(/duplicate case id "a"/);
  });

  it("rejects a duplicate scorer id and says how to fix it", () => {
    expect(() =>
      defineSuite({
        name: "t",
        agent,
        scorers: [scorers.latencyUnder(1000), scorers.latencyUnder(1000)],
        cases: [{ id: "a", inbound: "x" }],
      }),
    ).toThrow(/Pass \{ id \}/);
  });

  it("rejects a threshold outside [0, 1] and an empty suite", () => {
    expect(() =>
      defineSuite({ name: "t", agent, threshold: 90, cases: [{ id: "a", inbound: "x" }] }),
    ).toThrow(/threshold must be in \[0, 1\]/);
    expect(() => defineSuite({ name: "t", agent, cases: [] })).toThrow(/no cases/);
  });
});

describe("expect desugaring", () => {
  const suite = defineSuite({
    name: "t",
    agent,
    scorers: [scorers.latencyUnder(1000), scorers.notContains("descuento")],
    cases: [
      defineCase({
        id: "a",
        inbound: "x",
        expect: { toolCalled: ["a", "b"], escalated: true, latencyUnder: 30_000 },
      }),
    ],
  });
  const c = suite.cases[0]!;

  it("turns every expect key into ordinary scorers", () => {
    const ids = scorersFor(suite, c).map((s) => s.id);
    expect(ids).toContain("toolCalled:a");
    expect(ids).toContain("toolCalled:b");
    expect(ids).toContain("escalated");
  });

  it("lets a case override a suite-level scorer of the same id instead of adding a column", () => {
    const found = scorersFor(suite, c).filter((s) => s.group === "latency");
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe("latency");
  });

  it("keeps suite scorers that the case did not override", () => {
    expect(scorersFor(suite, c).map((s) => s.id)).toContain("notContains:descuento");
  });

  it("filters out scorers whose `when` does not match the case", () => {
    const conditional = defineSuite({
      name: "t",
      agent,
      scorers: [scorers.escalatedWhen({ intent: "price_negotiation" })],
      cases: [
        defineCase({ id: "match", inbound: "x", meta: { intent: "price_negotiation" } }),
        defineCase({ id: "other", inbound: "x", meta: { intent: "stock_question" } }),
      ],
    });
    expect(scorersFor(conditional, conditional.cases[0]!)).toHaveLength(1);
    expect(scorersFor(conditional, conditional.cases[1]!)).toHaveLength(0);
  });
});
