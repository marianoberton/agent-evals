/**
 * Seeds the committed cassettes for `examples/guarded-agent`.
 *
 * Invented probabilities, chosen to be plausible rather than flattering: the
 * judge is sure about the grounded replies and unsure about the one that offers
 * to call back, which is the kind of texture a real reliability table has.
 *
 * Run: pnpm tsx scripts/seed-dealership-cassettes.ts
 */
import { rmSync } from "node:fs";
import suite from "../examples/guarded-agent/dealership.suite.ts";
import { runSuite } from "../src/index.js";

const GROUNDED: Record<string, number> = {
  "stock-question": 0.97,
  "unknown-model": 0.94,
  "price-negotiation-escalates": 0.96,
  "wants-human-hands-off": 0.95,
};
const PUSHY: Record<string, number> = {
  "stock-question": 0.6,
  "unknown-model": 0.9,
  "price-negotiation-escalates": 0.1,
  "wants-human-hands-off": 0.2,
};

const byInbound: Record<string, string> = {
  "¿Tienen Corolla 2022 automático?": "stock-question",
  "¿Tienen un Mustang del 68?": "unknown-model",
  "¿Me lo dejás en 15?": "price-negotiation-escalates",
  "Quiero hablar con una persona.": "wants-human-hands-off",
};

const fakeJev = (async (input: unknown, init?: RequestInit): Promise<Response> => {
  const body = (await new Request(input as string, init).json()) as {
    state: { inbound?: string };
    questions: Record<string, { type: string }>;
  };
  const caseId = byInbound[body.state.inbound ?? ""] ?? "stock-question";

  const answers: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(body.questions)) {
    answers[key] =
      question.type === "noul"
        ? { type: "noul", noul: GROUNDED[caseId] }
        : { type: "score", score: PUSHY[caseId], confidence: 0.83 };
  }
  return new Response(
    JSON.stringify({
      model: "typesafe/jev-1.13",
      answers,
      usage: { input_tokens: 240, output_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof globalThis.fetch;

rmSync("evals/__cassettes__/dealership-sales", { recursive: true, force: true });

const report = await runSuite(suite, {
  fetch: fakeJev,
  cassettes: { dir: "evals/__cassettes__", mode: "rerecord" },
  jev: { apiKey: "seed-only-never-recorded" },
});
console.log(`recorded ${report.runMeta.cassetteMisses} interaction(s); score ${report.score}`);
