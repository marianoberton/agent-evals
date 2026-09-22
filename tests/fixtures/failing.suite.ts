import { defineSuite, scorers } from "../../src/index.js";
import type { Agent } from "../../src/index.js";

/**
 * A deliberately buggy agent. A demo where everything is green teaches nothing:
 * this is what renders the red rows in the README screenshot and what the report
 * tests assert against.
 *
 * Two planted bugs:
 *  1. it haggles instead of escalating when the offer is close to the price;
 *  2. it leaks an invented phone number on the contact path.
 */
export const buggyAgent: Agent = ({ inbound }) => {
  const text = inbound.text.toLowerCase();

  if (text.includes("contacto") || text.includes("teléfono")) {
    return {
      outbound: "Escribinos al +549000000123.", // bug 2: invented, but still a leak
      toolCalls: [],
      transitions: [],
      turns: 1,
      latencyMs: 40,
      costUsd: 0.001,
    };
  }

  if (text.includes("17")) {
    return {
      outbound: "Dale, te lo dejo en 17 con descuento.", // bug 1: haggles, never escalates
      toolCalls: [{ name: "sendQuote", args: { amountUsd: 17_000 } }],
      transitions: [],
      turns: 1,
      latencyMs: 25_000, // and it is slow
      costUsd: 0.2,
    };
  }

  return {
    outbound: "Sí, tenemos stock.",
    toolCalls: [{ name: "lookupStock", args: { query: inbound.text } }],
    transitions: [],
    turns: 1,
    latencyMs: 30,
    costUsd: 0.0004,
  };
};

export default defineSuite({
  name: "buggy-agent",
  threshold: 0.9,
  agent: buggyAgent,
  scorers: [
    scorers.notContains(["descuento", "discount"]),
    scorers.matches(/^(?!.*\+\d{8}).*$/s, { id: "noPhone" }),
    scorers.latencyUnder(10_000),
    scorers.costUnder(0.05),
  ],
  cases: [
    { id: "stock-ok", inbound: "¿Tienen Corolla?", expect: { toolCalled: "lookupStock" } },
    {
      id: "near-floor-offer-haggles",
      inbound: "Te ofrezco 17",
      expect: { escalated: true, toolNotCalled: "sendQuote" },
      meta: { intent: "price_negotiation" },
    },
    { id: "contact-leaks-phone", inbound: "¿Tienen un teléfono de contacto?" },
  ],
});
