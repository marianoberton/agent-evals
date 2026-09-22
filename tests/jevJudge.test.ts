import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineSuite, jev, jevJudge, renderMarkdown, runSuite, scorers } from "../src/index.js";
import type { Agent, JevAnswer } from "../src/index.js";
import { fakeJev } from "./helpers/jevServer.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "agent-evals-jj-"));

const agent: Agent = ({ inbound }) => ({
  outbound: `Sobre "${inbound.text}": tenemos stock.`,
  toolCalls: [{ name: "lookupStock", args: { q: inbound.text } }],
  transitions: [],
  latencyMs: 12,
  costUsd: 0.0002,
});

const suiteWith = (...extra: ReturnType<typeof jevJudge>[]) =>
  defineSuite({
    name: "judged",
    threshold: 0.9,
    agent,
    scorers: [scorers.replied(), ...extra],
    cases: [
      { id: "a", inbound: "¿Tienen Corolla?" },
      { id: "b", inbound: "¿Tienen Hilux?" },
    ],
  });

describe("jevJudge", () => {
  it("puts the probability in the report, not just a tick", async () => {
    const server = fakeJev();
    const report = await runSuite(
      suiteWith(
        jevJudge({
          id: "jev:answers",
          question: jev.noul("¿Responde la pregunta sin inventar stock ni precios?"),
          passAbove: 0.9,
        }),
      ),
      { fetch: server.fetch, cassettes: { mode: "passthrough" }, jev: { apiKey: "t" } },
    );

    const entry = report.cases[0]?.scores.find((s) => s.scorerId === "jev:answers");
    expect(entry?.pass).toBe(true);
    expect(entry?.probability).toBe(0.97);
    expect(entry?.kind).toBe("jev");
    expect(renderMarkdown(report)).toContain("0.97 ✓");
  });

  it("fails below the threshold and shows the number that failed", async () => {
    const server = fakeJev({ answer: () => ({ type: "noul", noul: 0.42 }) });
    const report = await runSuite(
      suiteWith(jevJudge({ id: "jev:answers", question: jev.noul("¿Responde?"), passAbove: 0.9 })),
      { fetch: server.fetch, cassettes: { mode: "passthrough" }, jev: { apiKey: "t" } },
    );
    const entry = report.cases[0]?.scores.find((s) => s.scorerId === "jev:answers");
    expect(entry?.pass).toBe(false);
    expect(entry?.reason).toBe("0.42 < 0.9");
    expect(report.passed).toBe(false);
  });

  it("grades a score question against a ceiling", async () => {
    const answer = (): JevAnswer => ({ type: "score", score: 1.4, confidence: 0.8 });
    const server = fakeJev({ answer });
    const report = await runSuite(
      suiteWith(
        jevJudge({
          id: "jev:pushy",
          question: jev.score("¿Cuán pesada es la respuesta?", [
            "Neutral",
            "Algo vendedora",
            "Agresiva",
          ]),
          passAtMost: 1,
        }),
      ),
      { fetch: server.fetch, cassettes: { mode: "passthrough" }, jev: { apiKey: "t" } },
    );
    const entry = report.cases[0]?.scores.find((s) => s.scorerId === "jev:pushy");
    expect(entry?.pass).toBe(false);
    expect(entry?.reason).toBe("1.40 outside <= 1");
  });

  it("grades a choice question against the allowed picks", async () => {
    const server = fakeJev({
      answer: () => ({
        type: "choice",
        choice: "price_negotiation",
        confidence: 0.93,
        probabilities: { price_negotiation: 0.93, stock_question: 0.07 },
      }),
    });
    const report = await runSuite(
      suiteWith(
        jevJudge({
          id: "jev:intent",
          question: jev.choice("¿Qué quiere el cliente?", {
            stock_question: "Pregunta por disponibilidad",
            price_negotiation: "Empuja por un descuento",
          }),
          passIs: "stock_question",
        }),
      ),
      { fetch: server.fetch, cassettes: { mode: "passthrough" }, jev: { apiKey: "t" } },
    );
    const entry = report.cases[0]?.scores.find((s) => s.scorerId === "jev:intent");
    expect(entry?.pass).toBe(false);
    expect(entry?.reason).toContain('picked "price_negotiation"');
    expect(entry?.probabilities).toEqual({ price_negotiation: 0.93, stock_question: 0.07 });
  });

  it("sends one request per case even with several judges", async () => {
    const server = fakeJev();
    await runSuite(
      suiteWith(
        jevJudge({ id: "jev:answers", question: jev.noul("¿Responde?"), passAbove: 0.9 }),
        jevJudge({ id: "jev:pushy", question: jev.noul("¿Es pesada?"), passAbove: 0.9 }),
      ),
      { fetch: server.fetch, cassettes: { mode: "passthrough" }, jev: { apiKey: "t" } },
    );
    expect(server.calls).toHaveLength(2); // two cases, not four questions
  });

  it("fails the scorer when Jev itself fails, and skips it when soft", async () => {
    const broken = fakeJev({ failFirst: 99, status: 400 });
    const hard = await runSuite(
      suiteWith(jevJudge({ id: "jev:q", question: jev.noul("¿?"), passAbove: 0.5 })),
      { fetch: broken.fetch, cassettes: { mode: "passthrough" }, jev: { apiKey: "t" } },
    );
    expect(hard.cases[0]?.scores.find((s) => s.scorerId === "jev:q")?.pass).toBe(false);

    const soft = await runSuite(
      suiteWith(jevJudge({ id: "jev:q", question: jev.noul("¿?"), passAbove: 0.5, soft: true })),
      { fetch: broken.fetch, cassettes: { mode: "passthrough" }, jev: { apiKey: "t" } },
    );
    expect(soft.cases[0]?.scores.find((s) => s.scorerId === "jev:q")?.pass).toBeNull();
  });

  it("reports Jev usage and cost in the report", async () => {
    const server = fakeJev();
    const report = await runSuite(
      suiteWith(jevJudge({ id: "jev:q", question: jev.noul("¿?"), passAbove: 0.5 })),
      { fetch: server.fetch, cassettes: { mode: "passthrough" }, jev: { apiKey: "t" } },
    );
    expect(report.usage.jev).toMatchObject({ requests: 2, inputTokens: 200, outputTokens: 0 });
    expect(report.usage.jev?.costUsd).toBeGreaterThan(0);
  });
});

describe("the M1 gate", () => {
  it("makes zero network calls on the second run, and reports the same thing", async () => {
    const dir = tmp();
    const server = fakeJev();
    const suite = suiteWith(
      jevJudge({ id: "jev:answers", question: jev.noul("¿Responde?"), passAbove: 0.9 }),
      jevJudge({ id: "jev:pushy", question: jev.noul("¿Es pesada?"), passAbove: 0.5 }),
    );
    const options = {
      fetch: server.fetch,
      cassettes: { dir, mode: "auto" as const },
      jev: { apiKey: "t" },
    };

    const first = await runSuite(suite, options);
    const callsAfterFirst = server.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(first.runMeta.cassetteMisses).toBe(callsAfterFirst);

    const second = await runSuite(suite, options);
    expect(server.calls.length).toBe(callsAfterFirst); // zero new calls
    expect(second.runMeta.cassetteMisses).toBe(0);
    expect(second.runMeta.cassetteHits).toBeGreaterThan(0);

    // And the report is the same one, probabilities included.
    expect(renderMarkdown(first)).toBe(renderMarkdown(second));
  });

  it("keeps latency meaningful under replay instead of collapsing to zero", async () => {
    const dir = tmp();
    const slow = fakeJev();
    const suite = defineSuite({
      name: "latency-under-replay",
      threshold: 1,
      agent: async ({ fetch: cassetteFetch }) => {
        // An agent whose own model call goes through the cassette, and which
        // does not report latency itself.
        await cassetteFetch("https://api.example.com/llm", { method: "POST", body: "{}" });
        return { outbound: "hola" };
      },
      cases: [{ id: "a", inbound: "x" }],
    });
    const options = {
      fetch: (async () => {
        await new Promise((r) => setTimeout(r, 30));
        return new Response('{"text":"hola","usage":{"input_tokens":50,"cost":0.004}}', {
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch,
      cassettes: { dir, mode: "auto" as const },
    };
    void slow;

    const first = await runSuite(suite, options);
    const second = await runSuite(suite, options);

    const a = first.cases[0]?.outcome?.latencyMs ?? 0;
    const b = second.cases[0]?.outcome?.latencyMs ?? 0;
    expect(a).toBeGreaterThanOrEqual(25);
    expect(b).toBe(a); // replayed, not re-measured
    expect(second.cases[0]?.outcome?.costUsd).toBeCloseTo(0.004, 6);
    expect(second.runMeta.cassetteMisses).toBe(0);
  });
});
