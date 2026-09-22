/**
 * Generates the committed cassettes for `examples/calibration`.
 *
 * The probabilities below are **invented**, chosen to show a realistic, slightly
 * overconfident judge: it is right about most things, and confidently wrong
 * about one. That is what makes the reliability table worth reading — a table
 * where 0.9 is always right teaches nobody how to pick a threshold.
 *
 * Run: pnpm tsx scripts/seed-calibration-cassettes.ts
 *
 * Recording goes through the real client and the real URL, so the cassette keys
 * are exactly what a live run would produce. Only the transport is faked.
 */
import { rmSync } from "node:fs";
import suite from "../examples/calibration/calibrate.suite.ts";
import { runSuite } from "../src/index.js";

/** caseId -> the probability the judge returns. Truth lives in the suite's `meta`. */
const INVENTED: Record<string, number> = {
  "stock-clear": 0.96, // grounded, and sure of it
  "answers-plainly": 0.97, // grounded
  "stock-vague": 0.88, // grounded but hedged, so less sure
  dodges: 0.72, // grounded, though it dodged the question
  "invents-stock": 0.31, // caught the invention
  "invents-price": 0.93, // confidently wrong — the point of the example
};

const fakeJev = (async (input: unknown, init?: RequestInit): Promise<Response> => {
  const body = (await new Request(input as string, init).json()) as {
    state: { inbound?: string; reply?: string[] };
    questions: Record<string, unknown>;
  };
  // Match the case by its canned reply, since the state is all the judge sees.
  const reply = body.state.reply?.[0] ?? "";
  const caseId = Object.keys(INVENTED).find((id) => REPLY_OF[id] === reply) ?? "stock-clear";

  const answers: Record<string, unknown> = {};
  for (const key of Object.keys(body.questions)) {
    answers[key] = { type: "noul", noul: INVENTED[caseId] };
  }
  return new Response(
    JSON.stringify({
      model: "typesafe/jev-1.13",
      answers,
      usage: { input_tokens: 180, output_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof globalThis.fetch;

const REPLY_OF: Record<string, string> = {
  "stock-clear": "Sí, tenemos tres Corolla 2022 automáticos.",
  "stock-vague": "Puede que tengamos algo parecido, habría que fijarse.",
  "invents-stock": "Tenemos catorce unidades del Corolla 2026 en cuatro colores.",
  "invents-price": "Te lo dejo en USD 12.000, precio especial de hoy.",
  "answers-plainly": "El Corolla 2022 automático está en USD 18.500.",
  dodges: "Contame un poco más sobre lo que estás buscando.",
};

const dir = "evals/__cassettes__";
rmSync(`${dir}/calibration`, { recursive: true, force: true });

const report = await runSuite(suite, {
  fetch: fakeJev,
  cassettes: { dir, mode: "rerecord" },
  jev: { apiKey: "seed-only-never-recorded" },
});

console.log(`recorded ${report.runMeta.cassetteMisses} interaction(s) for ${report.suite}`);
console.log(`score ${report.score} — the score is not the point here, the calibration is`);
