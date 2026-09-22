import { describe, expect, it } from "vitest";
import {
  JevBudgetError,
  JevClient,
  JevError,
  NonDeterministicStateError,
  assertDeterministicState,
  assertTokenBudget,
  jev,
  readChoice,
  readNoul,
  readScore,
  resolveJevBatch,
} from "../src/index.js";
import type { JevPlan } from "../src/index.js";
import { fakeJev } from "./helpers/jevServer.js";

const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("question builders", () => {
  it("mirrors the wire format for each primitive", () => {
    expect(jev.noul("¿Responde la pregunta?")).toEqual({
      type: "noul",
      instructions: "¿Responde la pregunta?",
    });
    expect(jev.choice("¿Qué quiere?", { a: "A", b: "B" })).toEqual({
      type: "choice",
      instructions: "¿Qué quiere?",
      criteria: { a: "A", b: "B" },
    });
    // `score` criteria is an ordered array: the index is the level.
    expect(jev.score("¿Cuán pesado?", ["Neutral", "Salesy"]).criteria).toEqual([
      "Neutral",
      "Salesy",
    ]);
  });
});

describe("JevClient", () => {
  it("sends model, state, questions and zdr, and returns the answers", async () => {
    const server = fakeJev();
    const client = new JevClient({ fetch: server.fetch, apiKey: "test", ...noSleep });
    const answers = await client.decide("hola", { q: jev.noul("¿Es un saludo?") });

    expect(answers.q?.noul).toBe(0.97);
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({ state: "hola" });
  });

  it("batches every question of one state into a single request", async () => {
    const server = fakeJev();
    const client = new JevClient({ fetch: server.fetch, apiKey: "test", ...noSleep });
    await client.decide("hola", {
      a: jev.noul("¿Uno?"),
      b: jev.noul("¿Dos?"),
      c: jev.score("¿Tres?", ["bajo", "alto"]),
    });
    expect(server.calls).toHaveLength(1);
    expect(Object.keys(server.calls[0]!.questions)).toEqual(["a", "b", "c"]);
  });

  it("accumulates usage and bills input tokens only", async () => {
    const server = fakeJev();
    const client = new JevClient({
      fetch: server.fetch,
      apiKey: "t",
      inputPricePerMtok: 0.042,
      ...noSleep,
    });
    await client.decide("x", { a: jev.noul("?"), b: jev.noul("?") });
    expect(client.usage).toEqual({ requests: 1, inputTokens: 200, outputTokens: 0 });
    expect(client.costUsd).toBeCloseTo((200 / 1e6) * 0.042, 12);
  });

  it("retries a 429 and then succeeds", async () => {
    const server = fakeJev({ failFirst: 2 });
    const client = new JevClient({ fetch: server.fetch, apiKey: "t", ...noSleep });
    const answers = await client.decide("x", { q: jev.noul("?") });
    expect(answers.q?.noul).toBe(0.97);
  });

  it("gives up after maxRetries and says so", async () => {
    const server = fakeJev({ failFirst: 99 });
    const client = new JevClient({ fetch: server.fetch, apiKey: "t", maxRetries: 2, ...noSleep });
    await expect(client.decide("x", { q: jev.noul("?") })).rejects.toThrow(/after 2 attempts/);
  });

  it("does not retry a non-retryable status", async () => {
    const server = fakeJev({ failFirst: 99, status: 400 });
    const client = new JevClient({ fetch: server.fetch, apiKey: "t", ...noSleep });
    await expect(client.decide("x", { q: jev.noul("?") })).rejects.toThrow(JevError);
  });

  it("defaults to OpenRouter's Decisions endpoint and the pinned model", () => {
    const client = new JevClient({ apiKey: "t" });
    expect(client.baseUrl).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(client.model).toBe("typesafe/jev-1.13");
    expect(client.zdr).toBe(true);
  });
});

describe("answer readers", () => {
  it("reads a noul as a probability", () => {
    expect(readNoul({ type: "noul", noul: 0.91 })).toBe(0.91);
    expect(readNoul(undefined)).toBe(0);
  });

  it("falls back to the picked option's probability when confidence is missing", () => {
    const answer = { type: "choice" as const, choice: "refund", probabilities: { refund: 0.77 } };
    expect(readChoice(answer)).toMatchObject({ choice: "refund", confidence: 0.77 });
  });

  it("prefers an explicit confidence", () => {
    const answer = {
      type: "choice" as const,
      choice: "refund",
      confidence: 0.6,
      probabilities: { refund: 0.77 },
    };
    expect(readChoice(answer).confidence).toBe(0.6);
  });

  it("reads a score as a weighted average that can fall between levels", () => {
    expect(readScore({ type: "score", score: 1.4, confidence: 0.7 })).toMatchObject({
      score: 1.4,
      confidence: 0.7,
    });
  });
});

describe("token budget", () => {
  it("passes for a normal state", () => {
    expect(() => assertTokenBudget("hola", { q: jev.noul("¿?") })).not.toThrow();
  });

  it("refuses to spend on an oversized state", () => {
    const huge = "x".repeat(200_000);
    expect(() => assertTokenBudget(huge, { q: jev.noul("¿?") })).toThrow(JevBudgetError);
  });
});

describe("volatility guard", () => {
  it("accepts a reproducible state", () => {
    expect(() =>
      assertDeterministicState("s", { history: [], reply: ["hola"], toolCalls: [] }),
    ).not.toThrow();
  });

  it.each(["latencyMs", "costUsd", "trace", "timestamp", "seed"])(
    "rejects %s, which would miss the cassette every run",
    (field) => {
      expect(() => assertDeterministicState("s", { reply: "x", [field]: 1 })).toThrow(
        NonDeterministicStateError,
      );
    },
  );

  it("finds it nested, not just at the top level", () => {
    expect(() => assertDeterministicState("s", { a: { b: [{ latencyMs: 4 }] } })).toThrow(
      /a\.b\[0\]\.latencyMs/,
    );
  });
});

describe("batching", () => {
  const plan = (
    state: unknown,
    questions: Record<string, ReturnType<typeof jev.noul>>,
  ): JevPlan => ({
    state,
    questions,
  });

  it("merges scorers that share a state into ONE request", async () => {
    const server = fakeJev();
    const client = new JevClient({ fetch: server.fetch, apiKey: "t", ...noSleep });
    const plans = new Map([
      ["jev:answers", plan({ reply: "hola" }, { q: jev.noul("¿Responde?") })],
      ["jev:pushy", plan({ reply: "hola" }, { q: jev.noul("¿Es pesado?") })],
    ]);
    const answers = await resolveJevBatch(plans, client, server.fetch, new Map());

    expect(server.calls).toHaveLength(1);
    expect(Object.keys(server.calls[0]!.questions)).toHaveLength(2);
    // De-namespaced back: each scorer reads the key it asked for.
    expect(answers.get("jev:answers")?.q?.noul).toBe(0.97);
    expect(answers.get("jev:pushy")?.q?.noul).toBe(0.97);
  });

  it("splits scorers that build different states", async () => {
    const server = fakeJev();
    const client = new JevClient({ fetch: server.fetch, apiKey: "t", ...noSleep });
    const plans = new Map([
      ["a", plan({ reply: "uno" }, { q: jev.noul("?") })],
      ["b", plan({ reply: "dos" }, { q: jev.noul("?") })],
    ]);
    await resolveJevBatch(plans, client, server.fetch, new Map());
    expect(server.calls).toHaveLength(2);
  });

  it("namespaces colliding question keys without losing the mapping", async () => {
    const server = fakeJev();
    const client = new JevClient({ fetch: server.fetch, apiKey: "t", ...noSleep });
    const plans = new Map([
      ["a", plan({ s: 1 }, { same: jev.noul("uno") })],
      ["b", plan({ s: 1 }, { same: jev.noul("dos") })],
    ]);
    const answers = await resolveJevBatch(plans, client, server.fetch, new Map());
    expect(Object.keys(server.calls[0]!.questions).sort()).toEqual(["a__same", "b__same"]);
    expect(answers.get("a")?.same).toBeDefined();
    expect(answers.get("b")?.same).toBeDefined();
  });

  it("builds an identical request regardless of plan insertion order", async () => {
    const run = async (entries: [string, JevPlan][]) => {
      const server = fakeJev();
      const client = new JevClient({ fetch: server.fetch, apiKey: "t", ...noSleep });
      await resolveJevBatch(new Map(entries), client, server.fetch, new Map());
      return JSON.stringify(server.calls[0]);
    };
    const a = plan({ s: 1 }, { q: jev.noul("uno") });
    const b = plan({ s: 1 }, { q: jev.noul("dos") });
    expect(
      await run([
        ["a", a],
        ["b", b],
      ]),
    ).toBe(
      await run([
        ["b", b],
        ["a", a],
      ]),
    );
  });

  it("marks every dependent scorer when the batched call fails", async () => {
    const server = fakeJev({ failFirst: 99, status: 400 });
    const client = new JevClient({ fetch: server.fetch, apiKey: "t", ...noSleep });
    const errors = new Map<string, Error>();
    await resolveJevBatch(
      new Map([
        ["a", plan({ s: 1 }, { q: jev.noul("?") })],
        ["b", plan({ s: 1 }, { q: jev.noul("?") })],
      ]),
      client,
      server.fetch,
      errors,
    );
    expect([...errors.keys()].sort()).toEqual(["a", "b"]);
  });

  it("reports a volatile state as that scorer's error, without killing the batch", async () => {
    const server = fakeJev();
    const client = new JevClient({ fetch: server.fetch, apiKey: "t", ...noSleep });
    const errors = new Map<string, Error>();
    const answers = await resolveJevBatch(
      new Map([
        ["bad", plan({ latencyMs: 12 }, { q: jev.noul("?") })],
        ["good", plan({ reply: "x" }, { q: jev.noul("?") })],
      ]),
      client,
      server.fetch,
      errors,
    );
    expect(errors.get("bad")).toBeInstanceOf(NonDeterministicStateError);
    expect(answers.get("good")?.q).toBeDefined();
  });
});
