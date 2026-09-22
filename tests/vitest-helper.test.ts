import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Agent, AgentInput } from "../src/index.js";
import { AgentExpectationError, expectAgent } from "../src/vitest/index.js";

const dealership: Agent = ({ inbound }) => {
  const text = inbound.text.toLowerCase();
  if (/descuento|dej[áa]s en/.test(text)) {
    return {
      outbound: [],
      toolCalls: [],
      transitions: [{ type: "escalated", reason: "price_negotiation" }],
      latencyMs: 9,
      costUsd: 0.0002,
      tokens: { inputTokens: 100, outputTokens: 0 },
    };
  }
  return {
    outbound: "Sí, tenemos Corolla 2022.",
    toolCalls: [{ name: "lookupStock", args: { model: "Corolla", year: 2022 } }],
    transitions: [],
    latencyMs: 14,
    costUsd: 0.0003,
    tokens: { inputTokens: 130, outputTokens: 25 },
  };
};

/** Asserts the expectations failed, and hands the error back to inspect. */
async function failureOf(run: () => Promise<unknown>): Promise<Error> {
  let error: Error | undefined;
  try {
    await run();
  } catch (e) {
    error = e as Error;
  }
  if (!error) throw new Error("expected these expectations to fail, but they passed");
  return error;
}

describe("expectAgent", () => {
  it("reads like the assertion it is", async () => {
    await expectAgent(dealership)
      .given([
        { role: "user", text: "¿Cuánto sale el Corolla?" },
        { role: "assistant", text: "USD 18.500." },
      ])
      .receives("¿Me lo dejás en 15?")
      .toEscalate()
      .toNotCallTool("sendQuote");
  });

  it("runs on await, and resolves to the outcome", async () => {
    const outcome = await expectAgent(dealership).receives("¿Tienen Corolla?").toReply();
    expect(outcome.outbound[0]?.text).toContain("Corolla");
  });

  it("fails with the scorer's own reason, the reply and the tools", async () => {
    const failure = await failureOf(() =>
      expectAgent(dealership)
        .named("stock-question")
        .receives("¿Tienen Corolla?")
        .toEscalate()
        .run(),
    );

    expect(failure).toBeInstanceOf(AgentExpectationError);
    expect(failure.message).toContain('for "stock-question"');
    expect(failure.message).toContain("expected escalated, did not");
    expect(failure.message).toContain("Sí, tenemos Corolla 2022.");
    expect(failure.message).toContain("tools: lookupStock");
  });

  it("counts how many of how many failed", async () => {
    const failure = await failureOf(() =>
      expectAgent(dealership)
        .receives("¿Tienen Corolla?")
        .toEscalate()
        .toCallTool("sendQuote")
        .toReply()
        .run(),
    );
    expect(failure.message).toContain("2 of 3 expectation(s)");
  });

  it("covers the tool assertions", async () => {
    await expectAgent(dealership)
      .receives("¿Tienen Corolla?")
      .toCallTool("lookupStock")
      .toNotCallTool("sendQuote")
      .toCallToolWith("lookupStock", z.object({ model: z.string(), year: z.number() }));

    await expectAgent(dealership).receives("¿Me hacés descuento?").toCallNoTools();
  });

  it("covers the text and budget assertions", async () => {
    await expectAgent(dealership)
      .receives("¿Tienen Corolla?")
      .toContain("Corolla")
      .toNotContain("descuento")
      .toMatch(/Corolla \d{4}/)
      .toRespondUnder(1_000)
      .toCostUnder(0.01)
      .toUseTokensUnder(500);
  });

  it("covers the transition assertions in both polarities", async () => {
    await expectAgent(dealership).receives("¿Tienen Corolla?").toNotEscalate();
    await expectAgent(dealership).receives("¿Me hacés descuento?").toEscalate("price_negotiation");

    const wrongReason = await failureOf(() =>
      expectAgent(dealership).receives("¿Me hacés descuento?").toEscalate("anger").run(),
    );
    expect(wrongReason.message).toContain('expected "anger"');
  });

  it("takes any scorer, including one you wrote", async () => {
    await expectAgent(dealership)
      .receives("¿Tienen Corolla?")
      .toSatisfy({
        id: "custom",
        kind: "deterministic",
        weight: 1,
        score: ({ outcome }) => ({
          pass: outcome.outbound.length === 1,
          weight: 1,
          reason: "exactly one message",
        }),
      });
  });

  it("refuses to pass a test that asserted nothing", async () => {
    // The agent reports no transitions at all, so `toEscalate` can only skip.
    const silent: Agent = () => ({ outbound: "hola" });
    const failure = await failureOf(() => expectAgent(silent).receives("x").toEscalate().run());
    expect(failure.message).toContain("asserted nothing");
  });

  it("refuses to run with no expectations at all", async () => {
    await expect(expectAgent(dealership).receives("x").run()).rejects.toThrow(
      /at least one expectation/,
    );
  });

  it("curries deps, so a real runtime reads the same", async () => {
    const withDeps = (input: AgentInput, deps: { greeting: string }) => ({
      outbound: `${deps.greeting} ${input.inbound.text}`,
    });
    await expectAgent(withDeps, { greeting: "hola" }).receives("mundo").toContain("hola mundo");
  });

  it("carries meta and tags through to conditional scorers", async () => {
    const seen: { meta: unknown; tags: readonly string[] }[] = [];
    const spy: Agent = ({ meta, tags }) => {
      seen.push({ meta, tags });
      return { outbound: "ok" };
    };
    await expectAgent(spy)
      .receives("x")
      .withMeta({ intent: "price_negotiation" })
      .withTags("policy")
      .toReply();
    expect(seen[0]).toEqual({ meta: { intent: "price_negotiation" }, tags: ["policy"] });
  });

  it("reports the case score when asked for a number instead of an assertion", async () => {
    const score = await expectAgent(dealership)
      .receives("¿Tienen Corolla?")
      .toCallTool("lookupStock")
      .toEscalate()
      .score();
    expect(score).toBe(0.5);
  });

  it("accepts a bare string as history", async () => {
    const spy: Agent = ({ history }) => ({ outbound: `${history.length}` });
    await expectAgent(spy).given("hola", "qué tal").receives("x").toContain("2");
  });
});
