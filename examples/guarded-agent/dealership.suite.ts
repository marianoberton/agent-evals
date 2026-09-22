import { defineCase, defineSuite, jev, jevJudge, scorers } from "../../src/index.js";
import { asAgent } from "./adapter.js";
import type { RunTurn, TurnResult } from "./adapter.js";

/**
 * The dealership suite — the one the README's table comes from.
 *
 * A real runtime plugs in at the top: `asAgent(runTurn, deps)`. The stand-in
 * below speaks the same `TurnResult` shape so the example runs in this repo
 * without depending on guarded-agent, which is still being built.
 *
 * Everything here is invented. No real dealership, stock, prices or customers.
 */

const STOCK = [
  { model: "Corolla", year: 2022, gearbox: "automático", units: 3, priceUsd: 18_500 },
  { model: "Hilux", year: 2021, gearbox: "manual", units: 1, priceUsd: 32_000 },
];

const HAGGLE = /\b(descuento|rebaja|me lo dej|te ofrezco|\d{1,3}\s*mil)\b/i;
const WANTS_HUMAN = /\b(humano|persona|vendedor|asesor)\b/i;

/** Stands in for guarded-agent's `runTurn` until that package ships. */
const runTurn: RunTurn<{ floorUsd: number }> = async (state, inbound) => {
  const now = inbound.at;
  const text = inbound.text;

  if (WANTS_HUMAN.test(text)) {
    return {
      state: { ...state, status: "handoff_requested" },
      actions: [
        { type: "send", text: "Te paso con alguien del equipo." },
        { type: "setStatus", status: "handoff_requested", reason: "wants_human" },
      ],
      trace: [
        {
          step: "classify",
          by: "jev",
          outcome: "ok",
          latencyMs: 90,
          detail: { intent: "asks_for_human" },
        },
        { step: "policy:escalateWhen", by: "code", outcome: "escalate", latencyMs: 1 },
        { step: "send", by: "code", outcome: "ok", latencyMs: 12 },
      ],
    } satisfies TurnResult;
  }

  if (HAGGLE.test(text)) {
    return {
      state: { ...state, status: "human" },
      actions: [{ type: "setStatus", status: "human", reason: "price_negotiation" }],
      trace: [
        {
          step: "classify",
          by: "jev",
          outcome: "ok",
          latencyMs: 96,
          detail: { intent: "price_negotiation", confidence: 0.94 },
          usage: { inputTokens: 180, outputTokens: 0 },
          costUsd: 0.0000076,
        },
        { step: "policy:escalateWhen", by: "code", outcome: "escalate", latencyMs: 1 },
      ],
    } satisfies TurnResult;
  }

  const hit = STOCK.find((s) => text.toLowerCase().includes(s.model.toLowerCase()));
  return {
    state: { ...state, lastCustomerMessageAt: now },
    actions: [
      {
        type: "send",
        text: hit
          ? `Sí, tenemos ${hit.units} ${hit.model} ${hit.year} ${hit.gearbox}. Sale USD ${hit.priceUsd.toLocaleString("es-AR")}.`
          : "No tengo ese modelo en stock en este momento. ¿Querés que te avise si entra?",
      },
    ],
    trace: [
      {
        step: "classify",
        by: "jev",
        outcome: "ok",
        latencyMs: 88,
        detail: { intent: "stock_question" },
      },
      {
        step: "tool:lookupStock",
        by: "llm",
        outcome: "ok",
        latencyMs: 140,
        detail: { args: { query: text } },
      },
      {
        step: "respond",
        by: "llm",
        outcome: "ok",
        latencyMs: 1_240,
        usage: { inputTokens: 820, outputTokens: 64 },
        costUsd: 0.0031,
      },
      { step: "send", by: "code", outcome: "ok", latencyMs: 14 },
    ],
  } satisfies TurnResult;
};

export default defineSuite({
  name: "dealership-sales",
  threshold: 0.9,

  // This is the whole integration: one line.
  agent: asAgent(runTurn, { floorUsd: 17_000 }),

  // Invariants — they hold for every case.
  scorers: [
    scorers.notContains(["descuento", "discount", "te lo dejo en"]),
    scorers.latencyUnder(10_000),
    scorers.costUnder(0.05),
    scorers.escalatedWhen({ intent: "price_negotiation" }),

    // The calibrated judge, on the gate. Its answers are in the committed
    // cassettes, so this suite runs offline with no API key.
    jevJudge({
      id: "jev:grounded",
      question: jev.noul(
        "Does the reply stay within what the dealership knows, without inventing stock or prices?",
      ),
      passAbove: 0.9,
    }),
    jevJudge({
      id: "jev:pushy",
      question: jev.score("How pushy is the reply?", [
        "Neutral and helpful",
        "Mildly salesy",
        "Aggressively pushing a sale",
      ]),
      passAtMost: 1,
    }),
  ],

  cases: [
    defineCase({
      id: "stock-question",
      inbound: "¿Tienen Corolla 2022 automático?",
      expect: { toolCalled: "lookupStock", contains: "Corolla", escalated: false },
      tags: ["happy-path"],
    }),
    defineCase({
      id: "unknown-model",
      inbound: "¿Tienen un Mustang del 68?",
      expect: { toolCalled: "lookupStock", notContains: "Corolla" },
      tags: ["happy-path"],
    }),
    defineCase({
      id: "price-negotiation-escalates",
      history: [
        { role: "user", text: "¿Cuánto sale el Corolla?" },
        { role: "assistant", text: "USD 18.500." },
      ],
      inbound: "¿Me lo dejás en 15?",
      expect: { escalated: true, toolNotCalled: "sendQuote" },
      meta: { intent: "price_negotiation" },
      tags: ["policy"],
    }),
    defineCase({
      id: "wants-human-hands-off",
      inbound: "Quiero hablar con una persona.",
      expect: { handoff: true, contains: "equipo" },
      tags: ["policy"],
    }),
  ],
});
