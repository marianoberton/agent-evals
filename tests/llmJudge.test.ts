import { describe, expect, it } from "vitest";
import { defineSuite, llmJudge, parseVerdict, runSuite, scorers } from "../src/index.js";
import type { Agent } from "../src/index.js";

const agent: Agent = ({ inbound }) => ({
  outbound: `Sobre "${inbound.text}": tenemos stock.`,
  toolCalls: [],
  transitions: [],
  latencyMs: 10,
});

/** A fake chat-completions endpoint, in the shape OpenRouter and friends return. */
function fakeLlm(content: string, status = 200) {
  const state = { calls: 0, bodies: [] as unknown[] };
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    state.calls += 1;
    state.bodies.push(await new Request(input as string, init).json());
    if (status !== 200) return new Response("{}", { status });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, state };
}

const suiteWith = (scorer: ReturnType<typeof llmJudge>, threshold = 1) =>
  defineSuite({
    name: "judged-by-llm",
    threshold,
    agent,
    scorers: [scorers.replied(), scorer],
    cases: [{ id: "a", inbound: "¿Tienen Corolla?" }],
  });

describe("parseVerdict", () => {
  it("reads clean JSON", () => {
    expect(parseVerdict('{"score":0.9,"reason":"on brand"}')).toEqual({
      score: 0.9,
      reason: "on brand",
    });
  });

  it("digs the JSON out of the prose models wrap it in", () => {
    const wrapped =
      'Sure! Here is my assessment:\n\n{"score": 0.4, "reason": "vague"}\n\nHope that helps.';
    expect(parseVerdict(wrapped)).toEqual({ score: 0.4, reason: "vague" });
  });

  it("clamps a score outside 0–1 rather than trusting it", () => {
    expect(parseVerdict('{"score": 7}')?.score).toBe(1);
    expect(parseVerdict('{"score": -3}')?.score).toBe(0);
  });

  it("gives up on anything without a usable score", () => {
    expect(parseVerdict("looks good to me!")).toBeUndefined();
    expect(parseVerdict('{"reason":"no score here"}')).toBeUndefined();
    expect(parseVerdict('{"score":"high"}')).toBeUndefined();
    expect(parseVerdict("{broken")).toBeUndefined();
  });
});

describe("llmJudge", () => {
  it("is off the gate unless you opt in", async () => {
    const llm = fakeLlm('{"score":0,"reason":"terrible"}');
    const suite = suiteWith(llmJudge({ rubric: "Is the reply on brand?" }));

    const off = await runSuite(suite, { fetch: llm.fetch, cassettes: { mode: "passthrough" } });
    expect(llm.state.calls).toBe(0); // it did not even run
    expect(off.cases[0]?.scores.map((s) => s.scorerId)).toEqual(["replied"]);
    expect(off.passed).toBe(true);

    const on = await runSuite(suite, {
      fetch: llm.fetch,
      cassettes: { mode: "passthrough" },
      includeLlmJudge: true,
    });
    expect(llm.state.calls).toBe(1);
    expect(on.passed).toBe(false);
  });

  it("passes above the threshold and reports the score as a probability", async () => {
    const llm = fakeLlm('{"score":0.91,"reason":"answers the question"}');
    const report = await runSuite(
      suiteWith(llmJudge({ rubric: "Does it answer?", passAbove: 0.7 })),
      { fetch: llm.fetch, cassettes: { mode: "passthrough" }, includeLlmJudge: true },
    );
    const entry = report.cases[0]?.scores.find((s) => s.scorerId === "llmJudge");
    expect(entry?.pass).toBe(true);
    expect(entry?.probability).toBe(0.91);
    expect(entry?.reason).toBe("answers the question");
    expect(entry?.kind).toBe("llm");
  });

  it("sends the rubric and a reproducible state, with sampling off", async () => {
    const llm = fakeLlm('{"score":1}');
    await runSuite(suiteWith(llmJudge({ rubric: "Stay on brand." })), {
      fetch: llm.fetch,
      cassettes: { mode: "passthrough" },
      includeLlmJudge: true,
    });
    const body = llm.state.bodies[0] as {
      temperature: number;
      messages: { role: string; content: string }[];
    };
    expect(body.temperature).toBe(0);
    expect(body.messages[0]?.content).toContain("Stay on brand.");
    const state = JSON.parse(body.messages[1]?.content ?? "{}");
    expect(state).toHaveProperty("reply");
    // Same rule as jevJudge: nothing in here may change between runs.
    for (const volatile of ["latencyMs", "costUsd", "trace", "tokens"]) {
      expect(state).not.toHaveProperty(volatile);
    }
  });

  it("skips rather than failing when the judge is unreachable", async () => {
    const llm = fakeLlm("", 500);
    const report = await runSuite(suiteWith(llmJudge({ rubric: "x" })), {
      fetch: llm.fetch,
      cassettes: { mode: "passthrough" },
      includeLlmJudge: true,
    });
    const entry = report.cases[0]?.scores.find((s) => s.scorerId === "llmJudge");
    expect(entry?.pass).toBeNull();
    expect(entry?.reason).toContain("HTTP 500");
  });

  it("fails instead when told not to be soft", async () => {
    const llm = fakeLlm("", 500);
    const report = await runSuite(suiteWith(llmJudge({ rubric: "x", soft: false })), {
      fetch: llm.fetch,
      cassettes: { mode: "passthrough" },
      includeLlmJudge: true,
    });
    expect(report.cases[0]?.scores.find((s) => s.scorerId === "llmJudge")?.pass).toBe(false);
  });

  it("skips when the model answered with prose instead of a verdict", async () => {
    const llm = fakeLlm("Honestly it depends on what you mean by on-brand.");
    const report = await runSuite(suiteWith(llmJudge({ rubric: "x" })), {
      fetch: llm.fetch,
      cassettes: { mode: "passthrough" },
      includeLlmJudge: true,
    });
    const entry = report.cases[0]?.scores.find((s) => s.scorerId === "llmJudge");
    expect(entry?.pass).toBeNull();
    expect(entry?.reason).toContain("no usable verdict");
  });

  it("goes through the cassette, so a recorded verdict replays", async () => {
    const dir = `${process.env.TEMP ?? "/tmp"}/ae-llm-${Date.now()}`;
    const llm = fakeLlm('{"score":0.8,"reason":"fine"}');
    const suite = suiteWith(llmJudge({ rubric: "x", passAbove: 0.5 }));
    const options = {
      fetch: llm.fetch,
      cassettes: { dir, mode: "auto" as const },
      includeLlmJudge: true,
    };

    await runSuite(suite, options);
    expect(llm.state.calls).toBe(1);
    const second = await runSuite(suite, options);
    expect(llm.state.calls).toBe(1); // replayed, not re-asked
    expect(second.cases[0]?.scores.find((s) => s.scorerId === "llmJudge")?.probability).toBe(0.8);
  });
});
