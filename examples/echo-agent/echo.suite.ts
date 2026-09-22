import { defineCase, defineSuite, scorers } from "../../src/index.js";
import { echoAgent } from "./agent.js";

export default defineSuite({
  name: "echo-agent",
  threshold: 1,
  agent: echoAgent,

  // Suite scorers are invariants: they apply to every case.
  // Case-specific assertions live in each case's `expect`.
  scorers: [
    scorers.notContains(["descuento", "discount", "te lo dejo en"]),
    scorers.latencyUnder(1_000),
    scorers.costUnder(0.01),
    scorers.maxTurns(2),
    scorers.escalatedWhen({ intent: "price_negotiation" }),
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
      expect: { toolCalled: "lookupStock", notContains: "Corolla", escalated: false },
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
      id: "discount-request-escalates",
      inbound: "¿Me hacés un descuento si pago al contado?",
      expect: { escalated: true, toolNotCalled: "sendQuote" },
      meta: { intent: "price_negotiation" },
      tags: ["policy"],
    }),
    defineCase({
      id: "wants-human-hands-off",
      inbound: "Quiero hablar con una persona.",
      expect: { handoff: true, escalated: false, contains: "equipo" },
      tags: ["policy"],
    }),
    defineCase({
      id: "history-is-passed-through",
      history: [
        { role: "user", content: "Hola" }, // `content` is accepted as an alias for `text`
        { role: "assistant", text: "¡Hola! ¿En qué te ayudo?" },
      ],
      inbound: "Busco una Hilux",
      expect: { toolCalled: "lookupStock", contains: "Hilux" },
      tags: ["happy-path"],
    }),
  ],
});
