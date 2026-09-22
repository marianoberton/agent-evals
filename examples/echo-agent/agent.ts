import type { Agent } from "../../src/index.js";

/**
 * Invented stock for a fictional dealership. No real data, ever.
 */
const STOCK = [
  { model: "Corolla", year: 2022, gearbox: "automático", units: 3, priceUsd: 18_500 },
  { model: "Hilux", year: 2021, gearbox: "manual", units: 1, priceUsd: 32_000 },
];

const HAGGLING = /\b(descuento|discount|rebaja|me lo dej|te ofrezco|\d{1,3}\s*mil)\b/i;
const WANTS_HUMAN = /\b(humano|persona|vendedor|asesor)\b/i;

/**
 * A rules-based agent: no LLM, no network, ~40 lines. It exists to show the
 * contract. If this file does not read as obvious, the API is wrong.
 */
export const echoAgent: Agent = ({ inbound }) => {
  const text = inbound.text;

  if (WANTS_HUMAN.test(text)) {
    return {
      outbound: "Te paso con alguien del equipo.",
      toolCalls: [],
      transitions: [{ type: "handoff", reason: "wants_human", to: "sales" }],
      labels: { intent: "asks_for_human" },
      turns: 1,
      latencyMs: 8,
      costUsd: 0.0001,
      tokens: { inputTokens: 90, outputTokens: 12 },
    };
  }

  // A price push never gets answered by the agent: it escalates, silently.
  if (HAGGLING.test(text)) {
    return {
      outbound: [],
      toolCalls: [],
      transitions: [{ type: "escalated", reason: "price_negotiation" }],
      labels: { intent: "price_negotiation" },
      turns: 1,
      latencyMs: 11,
      costUsd: 0.0002,
      tokens: { inputTokens: 120, outputTokens: 0 },
    };
  }

  const hit = STOCK.find((s) => text.toLowerCase().includes(s.model.toLowerCase()));
  return {
    outbound: hit
      ? `Sí, tenemos ${hit.units} ${hit.model} ${hit.year} ${hit.gearbox}.`
      : "No tengo ese modelo en stock en este momento.",
    toolCalls: [{ name: "lookupStock", args: { query: text }, result: hit ?? null, ok: true }],
    transitions: [],
    labels: { intent: hit ? "stock_question" : "other" },
    turns: 1,
    latencyMs: 15,
    costUsd: 0.0003,
    tokens: { inputTokens: 140, outputTokens: 30 },
  };
};
