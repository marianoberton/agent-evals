import type { JevAnswer, JevQuestion } from "../../src/index.js";

export interface FakeJevOptions {
  /** Answer for a question, by the *original* key the scorer used. */
  answer?: (key: string, question: JevQuestion, state: unknown) => JevAnswer;
  /** Fail the first N calls, to exercise retries. */
  failFirst?: number;
  status?: number;
  latencyMs?: number;
}

export interface FakeJev {
  fetch: typeof globalThis.fetch;
  /** Every request body Jev received. One entry per HTTP call, which is the point. */
  readonly calls: { state: unknown; questions: Record<string, JevQuestion> }[];
}

const defaultAnswer = (_key: string, question: JevQuestion): JevAnswer => {
  if (question.type === "noul") return { type: "noul", noul: 0.97 };
  if (question.type === "score") {
    return { type: "score", score: 0.4, confidence: 0.8, legend: [...question.criteria] };
  }
  const first = Object.keys(question.criteria)[0] ?? "other";
  return { type: "choice", choice: first, confidence: 0.88, probabilities: { [first]: 0.88 } };
};

/**
 * A fake Decisions endpoint. Speaks the real wire format, so the client is
 * exercised end to end and the cassettes recorded against it are shaped exactly
 * like the real ones.
 */
export function fakeJev(options: FakeJevOptions = {}): FakeJev {
  const calls: FakeJev["calls"] = [];
  let remainingFailures = options.failFirst ?? 0;

  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as string, init);
    const body = (await request.json()) as {
      state: unknown;
      questions: Record<string, JevQuestion>;
    };

    if (remainingFailures > 0) {
      remainingFailures -= 1;
      return new Response('{"error":"rate limited"}', {
        status: options.status ?? 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    }

    calls.push(body);
    const answers: Record<string, JevAnswer> = {};
    let inputTokens = 0;
    for (const [wire, question] of Object.entries(body.questions)) {
      // The wire key is `<scorerId>__<originalKey>`; the fake answers by original.
      const original = wire.includes("__") ? wire.slice(wire.indexOf("__") + 2) : wire;
      answers[wire] = (options.answer ?? defaultAnswer)(original, question, body.state);
      inputTokens += 100;
    }
    return new Response(
      JSON.stringify({
        model: "typesafe/jev-1.13",
        answers,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchImpl, calls };
}

/** A fake LLM endpoint, for exercising cassettes on the agent's own calls. */
export function fakeLlm(reply = "hola"): { fetch: typeof globalThis.fetch; calls: number } {
  const state = { calls: 0 };
  const fetchImpl = (async (): Promise<Response> => {
    state.calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return new Response(
      JSON.stringify({ text: reply, usage: { input_tokens: 120, output_tokens: 20, cost: 0.003 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch: fetchImpl,
    get calls() {
      return state.calls;
    },
  };
}
