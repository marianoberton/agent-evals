import { describe, expect, it } from "vitest";
import { inboundFrom, stateFrom, toOutcome } from "../examples/guarded-agent/adapter.js";
import type { TurnResult } from "../examples/guarded-agent/adapter.js";
import dealership from "../examples/guarded-agent/dealership.suite.js";
import { normalizeOutcome, runSuite } from "../src/index.js";
import type { AgentInput } from "../src/index.js";

const input = (over: Partial<AgentInput> = {}): AgentInput => ({
  suite: "s",
  caseId: "c",
  history: [
    { role: "user", text: "hola" },
    { role: "assistant", text: "¿en qué te ayudo?" },
  ],
  inbound: { role: "user", text: "¿Tienen Corolla?" },
  tags: [],
  meta: {},
  fetch: globalThis.fetch,
  signal: new AbortController().signal,
  seed: 0,
  ...over,
});

const result = (over: Partial<TurnResult> = {}): TurnResult => ({
  state: {
    id: "c",
    status: "agent",
    messages: [],
    lastCustomerMessageAt: null,
    turnsWithoutProgress: 0,
  },
  actions: [],
  trace: [],
  ...over,
});

describe("case → runtime", () => {
  it("invents the timestamps the runtime requires, from a fixed clock", () => {
    const a = stateFrom(input());
    const b = stateFrom(input());
    // A real clock here would change the request every run and miss the cassette.
    expect(a.messages.map((m) => m.at)).toEqual(b.messages.map((m) => m.at));
    expect(a.messages[1]!.at).toBeGreaterThan(a.messages[0]!.at);
    expect(inboundFrom(input()).at).toBe(inboundFrom(input()).at);
  });

  it("points lastCustomerMessageAt at the last user message", () => {
    const state = stateFrom(input());
    expect(state.lastCustomerMessageAt).toBe(state.messages[0]?.at);
  });

  it("collapses roles the runtime does not know about", () => {
    const state = stateFrom(input({ history: [{ role: "system", text: "eres un asistente" }] }));
    expect(state.messages[0]?.role).toBe("assistant");
  });
});

describe("runtime → Outcome", () => {
  it("turns send actions into outbound messages", () => {
    const outcome = normalizeOutcome(
      toOutcome(result({ actions: [{ type: "send", text: "hola" }] })),
    );
    expect(outcome.outbound).toEqual([{ role: "assistant", text: "hola" }]);
  });

  it("keeps the written reply when a template went out instead", () => {
    const outcome = normalizeOutcome(
      toOutcome(
        result({
          actions: [
            {
              type: "sendTemplate",
              template: "reopen",
              pendingText: "sí, tenemos",
              reason: "window",
            },
          ],
        }),
      ),
    );
    expect(outcome.outbound[0]?.text).toBe("sí, tenemos");
  });

  it("reads tool calls out of the trace step naming", () => {
    const outcome = normalizeOutcome(
      toOutcome(
        result({
          trace: [
            {
              step: "tool:lookupStock",
              by: "llm",
              outcome: "ok",
              latencyMs: 140,
              detail: { args: { q: "Corolla" } },
            },
          ],
        }),
      ),
    );
    expect(outcome.toolCalls).toEqual([
      { name: "lookupStock", args: { q: "Corolla" }, ok: true, latencyMs: 140, seq: 0 },
    ]);
  });

  it("carries a policy verdict onto the call it applied to", () => {
    const outcome = normalizeOutcome(
      toOutcome(
        result({
          trace: [{ step: "tool:sendQuote", by: "code", outcome: "block", latencyMs: 2 }],
        }),
      ),
    );
    expect(outcome.toolCalls?.[0]).toMatchObject({
      name: "sendQuote",
      ok: false,
      verdict: "block",
    });
  });

  it("maps each conversation status onto the transition an eval asserts", () => {
    const of = (status: string, reason: string) =>
      normalizeOutcome(
        toOutcome(
          result({
            actions: [{ type: "setStatus", status: status as "human", reason }],
          }),
        ),
      ).transitions;

    expect(of("human", "price_negotiation")).toEqual([
      { type: "escalated", reason: "price_negotiation" },
    ]);
    expect(of("handoff_requested", "wants_human")).toEqual([
      { type: "handoff", reason: "wants_human" },
    ]);
    expect(of("paused", "kill_switch")).toEqual([{ type: "blocked", reason: "kill_switch" }]);
    expect(of("agent", "nothing")).toEqual([]);
  });

  it("reads a pre-check that ended the turn without a model", () => {
    const outcome = normalizeOutcome(
      toOutcome(
        result({
          trace: [{ step: "preCheck", by: "code", outcome: "skipped:paused", latencyMs: 0 }],
        }),
      ),
    );
    expect(outcome.transitions).toEqual([{ type: "skipped", reason: "paused" }]);
  });

  it("sums latency, tokens and cost across the trace", () => {
    const outcome = normalizeOutcome(
      toOutcome(
        result({
          trace: [
            {
              step: "classify",
              by: "jev",
              outcome: "ok",
              latencyMs: 90,
              usage: { inputTokens: 180 },
              costUsd: 0.00001,
            },
            {
              step: "respond",
              by: "llm",
              outcome: "ok",
              latencyMs: 1_200,
              usage: { inputTokens: 800, outputTokens: 60 },
              costUsd: 0.003,
            },
          ],
        }),
      ),
    );
    expect(outcome.latencyMs).toBe(1_290);
    expect(outcome.tokens).toEqual({ inputTokens: 980, outputTokens: 60 });
    expect(outcome.costUsd).toBeCloseTo(0.00301, 6);
    expect(outcome.turns).toBe(1);
  });

  it("leaves a field absent when the runtime never reported it, so scorers skip", () => {
    const outcome = normalizeOutcome(
      toOutcome(result({ trace: [{ step: "send", by: "code", outcome: "ok", latencyMs: 12 }] })),
    );
    expect(outcome.costUsd).toBeUndefined();
    expect(outcome.tokens).toBeUndefined();
    expect(outcome.turns).toBe(0);
  });
});

describe("the dealership suite", () => {
  it("passes, offline, from the committed cassettes", async () => {
    const report = await runSuite(dealership, { cassettes: { mode: "replay" } });
    expect(report.passed).toBe(true);
    expect(report.runMeta.cassetteMisses).toBe(0);
    expect(report.runMeta.cassetteHits).toBe(4);
  });

  it("makes exactly one Jev request per case despite two judges", async () => {
    const report = await runSuite(dealership, { cassettes: { mode: "replay" } });
    expect(report.usage.jev?.requests).toBe(4);
  });

  it("shows a real latency from the trace, not a stopwatch", async () => {
    const report = await runSuite(dealership, { cassettes: { mode: "replay" } });
    const stock = report.cases.find((c) => c.id === "stock-question");
    const escalation = report.cases.find((c) => c.id === "price-negotiation-escalates");
    // The path that calls a model is slow; the one that escalates never does.
    expect(stock?.outcome?.latencyMs).toBeGreaterThan(1_000);
    expect(escalation?.outcome?.latencyMs).toBeLessThan(200);
  });

  it("leaves cost blank where the runtime reported none", async () => {
    const report = await runSuite(dealership, { cassettes: { mode: "replay" } });
    const handoff = report.cases.find((c) => c.id === "wants-human-hands-off");
    expect(handoff?.scores.find((s) => s.group === "cost")?.pass).toBeNull();
  });
});
