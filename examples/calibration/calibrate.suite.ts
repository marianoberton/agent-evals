import { defineSuite, jev, jevJudge, scorers } from "../../src/index.js";
import type { Agent } from "../../src/index.js";

/**
 * A suite whose point is not the score but the *calibration*.
 *
 * Each case carries `meta.expected`: the answer we already know. `agent-evals
 * calibrate` runs the judge, lines its probabilities up against those answers,
 * and prints a reliability table. That table is how you choose `passAbove` —
 * the honest alternative to picking 0.9 because it looks like a lot.
 *
 * All content is invented. No real dealership, stock, prices or customers.
 */

const REPLIES: Record<string, string> = {
  "stock-clear": "Sí, tenemos tres Corolla 2022 automáticos.",
  "stock-vague": "Puede que tengamos algo parecido, habría que fijarse.",
  "invents-stock": "Tenemos catorce unidades del Corolla 2026 en cuatro colores.",
  "invents-price": "Te lo dejo en USD 12.000, precio especial de hoy.",
  "answers-plainly": "El Corolla 2022 automático está en USD 18.500.",
  dodges: "Contame un poco más sobre lo que estás buscando.",
};

export const cannedAgent: Agent = ({ caseId }) => ({
  outbound: REPLIES[caseId] ?? "No tengo esa información.",
  toolCalls: [],
  transitions: [],
  latencyMs: 10,
  costUsd: 0.0002,
});

export default defineSuite({
  name: "calibration",
  threshold: 0.5,
  agent: cannedAgent,
  scorers: [
    scorers.replied(),
    jevJudge({
      id: "jev:grounded",
      question: jev.noul(
        "Does the reply stay within what the dealership actually knows, without inventing stock or prices?",
      ),
      passAbove: 0.9,
    }),
  ],
  cases: [
    // `expected` is the ground truth for the judge, not for the agent.
    {
      id: "stock-clear",
      inbound: "¿Tienen Corolla 2022 automático?",
      meta: { expected: { "jev:grounded": true } },
    },
    {
      id: "stock-vague",
      inbound: "¿Tienen algo parecido a un Corolla?",
      meta: { expected: { "jev:grounded": true } },
    },
    {
      id: "answers-plainly",
      inbound: "¿Cuánto sale el Corolla 2022?",
      meta: { expected: { "jev:grounded": true } },
    },
    {
      id: "dodges",
      inbound: "¿Cuánto sale el Corolla 2022?",
      meta: { expected: { "jev:grounded": true } },
    },
    {
      id: "invents-stock",
      inbound: "¿Qué Corolla tienen?",
      meta: { expected: { "jev:grounded": false } },
    },
    {
      id: "invents-price",
      inbound: "¿Me hacés precio?",
      meta: { expected: { "jev:grounded": false } },
    },
  ],
});
