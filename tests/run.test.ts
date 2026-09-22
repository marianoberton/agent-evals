import { describe, expect, it } from "vitest";
import { defineCase, defineSuite, runSuite, scorers, selectCases } from "../src/index.js";
import type { Agent, Case, Scorer } from "../src/index.js";

const ok: Agent = ({ inbound }) => ({
  outbound: `echo: ${inbound.text}`,
  toolCalls: [],
  transitions: [],
  latencyMs: 5,
});

const suiteOf = (agent: Agent, extra: Scorer[] = []) =>
  defineSuite({
    name: "t",
    threshold: 1,
    agent,
    scorers: [scorers.replied(), ...extra],
    cases: [
      { id: "a", inbound: "one" },
      { id: "b", inbound: "two" },
    ],
  });

describe("runSuite", () => {
  it("runs every case and scores them", async () => {
    const report = await runSuite(suiteOf(ok));
    expect(report.cases.map((c) => c.id)).toEqual(["a", "b"]);
    expect(report.score).toBe(1);
    expect(report.passed).toBe(true);
  });

  it("passes history and inbound through to the agent", async () => {
    let seen: { history: number; inbound: string } | undefined;
    const spy: Agent = ({ history, inbound }) => {
      seen = { history: history.length, inbound: inbound.text };
      return { outbound: "ok" };
    };
    await runSuite(
      defineSuite({
        name: "t",
        agent: spy,
        cases: [
          defineCase({
            id: "a",
            history: [{ role: "user", text: "prev" }],
            inbound: "now",
          }),
        ],
      }),
    );
    expect(seen).toEqual({ history: 1, inbound: "now" });
  });

  it("gives a crashing agent a full row of failures, not a hole", async () => {
    const boom: Agent = () => {
      throw new Error("kaboom");
    };
    const report = await runSuite(suiteOf(boom));
    expect(report.cases[0]?.status).toBe("error");
    expect(report.cases[0]?.score).toBe(0);
    expect(report.cases[0]?.scores).toHaveLength(1);
    expect(report.cases[0]?.scores[0]?.reason).toContain("kaboom");
    expect(report.score).toBe(0);
    expect(report.passed).toBe(false);
  });

  it("aborts a hanging agent and reports the timeout", async () => {
    const hang: Agent = ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    const report = await runSuite(
      defineSuite({ name: "t", agent: hang, timeoutMs: 30, cases: [{ id: "a", inbound: "x" }] }),
    );
    expect(report.cases[0]?.status).toBe("error");
    expect(report.cases[0]?.error?.message).toMatch(/within 30ms/);
  });

  it("produces an identical report at any concurrency", async () => {
    const jittery: Agent = async ({ inbound }) => {
      await new Promise((r) => setTimeout(r, inbound.text.length % 7));
      return { outbound: inbound.text, latencyMs: 1 };
    };
    const suite = defineSuite({
      name: "t",
      agent: jittery,
      scorers: [scorers.replied()],
      cases: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, inbound: "x".repeat(i + 1) })),
    });
    const strip = (r: Awaited<ReturnType<typeof runSuite>>) => ({
      ...r,
      cases: r.cases.map((c) => ({ ...c, durationMs: 0 })),
      runMeta: null,
    });
    const one = await runSuite(suite, { concurrency: 1 });
    const many = await runSuite(suite, { concurrency: 8 });
    expect(strip(one)).toEqual(strip(many));
  });

  it("refuses a deterministic scorer that returns a Promise", async () => {
    const asyncScorer: Scorer = {
      id: "bad",
      kind: "deterministic",
      weight: 1,
      score: async () => ({ pass: true, weight: 1, reason: "" }),
    };
    const report = await runSuite(suiteOf(ok, [asyncScorer]));
    const entry = report.cases[0]?.scores.find((s) => s.scorerId === "bad");
    expect(entry?.pass).toBe(false);
    expect(entry?.reason).toMatch(/deterministic but returned a Promise/);
  });

  it("catches a scorer that throws without losing the rest of the row", async () => {
    const boom: Scorer = {
      id: "boom",
      kind: "deterministic",
      weight: 1,
      score: () => {
        throw new Error("scorer broke");
      },
    };
    const report = await runSuite(suiteOf(ok, [boom]));
    const scores = report.cases[0]?.scores ?? [];
    expect(scores).toHaveLength(2);
    expect(scores.find((s) => s.scorerId === "boom")?.error).toBe("scorer broke");
    expect(scores.find((s) => s.scorerId === "replied")?.pass).toBe(true);
  });

  it("keeps the llm judge off the gate unless asked", async () => {
    const judge: Scorer = {
      id: "llmJudge",
      kind: "llm",
      weight: 1,
      score: async () => ({ pass: false, weight: 1, reason: "nope" }),
    };
    const off = await runSuite(suiteOf(ok, [judge]));
    expect(off.cases[0]?.scores.map((s) => s.scorerId)).toEqual(["replied"]);
    expect(off.passed).toBe(true);

    const on = await runSuite(suiteOf(ok, [judge]), { includeLlmJudge: true });
    expect(on.cases[0]?.scores.map((s) => s.scorerId)).toEqual(["replied", "llmJudge"]);
    expect(on.passed).toBe(false);
  });

  it("fills latency only when the agent did not report it", async () => {
    const silent: Agent = () => ({ outbound: "x" });
    const report = await runSuite(
      defineSuite({ name: "t", agent: silent, cases: [{ id: "a", inbound: "x" }] }),
    );
    expect(report.cases[0]?.outcome?.latencyMs).toBeTypeOf("number");

    const loud = await runSuite(
      defineSuite({
        name: "t",
        agent: () => ({ outbound: "x", latencyMs: 4242 }),
        cases: [{ id: "a", inbound: "x" }],
      }),
    );
    expect(loud.cases[0]?.outcome?.latencyMs).toBe(4242);
  });

  it("honours the threshold override", async () => {
    const half: Agent = ({ inbound }) => ({ outbound: inbound.text === "one" ? "hi" : "" });
    const suite = suiteOf(half);
    expect((await runSuite(suite)).passed).toBe(false);
    expect((await runSuite(suite, { threshold: 0.5 })).passed).toBe(true);
  });

  it("summarises per column, not per scorer instance", async () => {
    const suite = defineSuite({
      name: "t",
      agent: ok,
      cases: [
        { id: "a", inbound: "x", expect: { contains: "echo" } },
        { id: "b", inbound: "y", expect: { contains: "nope" } },
      ],
    });
    const report = await runSuite(suite);
    const contains = report.scorers.find((s) => s.group === "contains");
    expect(contains).toMatchObject({ passed: 1, failed: 1, skipped: 0, rate: 0.5 });
  });
});

describe("selectCases", () => {
  const cases: Case[] = [
    defineCase({ id: "a", inbound: "x", tags: ["happy"] }),
    defineCase({ id: "b", inbound: "x", tags: ["policy"] }),
    defineCase({ id: "c", inbound: "x", tags: ["policy"], skip: true }),
  ];

  it("drops skipped cases", () => {
    expect(selectCases(cases, {}).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("filters by tag and by id", () => {
    expect(selectCases(cases, { tags: ["policy"] }).map((c) => c.id)).toEqual(["b"]);
    expect(selectCases(cases, { only: ["a"] }).map((c) => c.id)).toEqual(["a"]);
  });

  it("lets an only-flagged case win over everything", () => {
    const focused = [...cases, defineCase({ id: "d", inbound: "x", only: true })];
    expect(selectCases(focused, {}).map((c) => c.id)).toEqual(["d"]);
  });
});
