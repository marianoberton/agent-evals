# Writing cases

A case is: the conversation so far, the message that arrives now, and what must and must not happen.

```ts
defineCase({
  id: "price-negotiation-escalates",     // unique, kebab-case; it is the report row and the cassette file
  history: [
    { role: "user", text: "¿Cuánto sale el Corolla?" },
    { role: "assistant", text: "USD 18.500." },
  ],
  inbound: "¿Me lo dejás en 15?",
  expect: { escalated: true, toolNotCalled: "sendQuote" },
  meta: { intent: "price_negotiation" },  // declared ground truth
  tags: ["policy"],
});
```

## Shapes the loader accepts

| Field | Accepts |
|---|---|
| `inbound` | a bare string (becomes a `user` message) or `{ role, text }` |
| `history` | an array of strings or messages; `{ role, content }` works too, so an OpenAI-shaped history pastes in |
| `expect` | omitted entirely when the suite's invariants are all you need |

`defineCase` is optional — `defineSuite` accepts plain case objects and normalises them. Use `defineCase` for standalone case files.

## `expect` is sugar, not a second engine

Every `expect` key desugars into ordinary scorers scoped to that one case:

```ts
expect: { toolCalled: "lookupStock" }
// is exactly
scorers: [scorers.toolCalled("lookupStock")]
```

Which means the report, the YAML loader and the vitest helper all share one mechanism, and anything you can do with a scorer you can do in a case:

```ts
expect: {
  toolCalled: ["lookupStock", "checkAvailability"],   // several
  toolArgs: { tool: "registerOffer", schema: OfferSchema },
  latencyUnder: 30_000,                                // relaxes the suite's limit, for this case
  scorers: [noPhoneNumber],                            // escape hatch
}
```

## Suite scorers vs `expect`

This is the one division that keeps the report readable:

- **Suite `scorers` are invariants.** They must hold for every case: no promised discount, under 10 s, under $0.05, escalate on a price push. A suite scorer that only makes sense for some cases needs a `when`.
- **`expect` carries what is specific to this case.** Which tool, whether it escalates, what the reply must contain.

Put `toolCalled` at suite level and every case that legitimately calls nothing goes red.

## Ground truth lives on the case

`meta` and `tags` are what the case *declares to be true*, independent of the agent. Conditional scorers read them:

```ts
scorers: [scorers.escalatedWhen({ intent: "price_negotiation" })],
cases: [
  defineCase({ id: "haggle", inbound: "¿Me lo dejás en 15?", meta: { intent: "price_negotiation" } }),
  defineCase({ id: "stock",  inbound: "¿Tienen Corolla?",    meta: { intent: "stock_question" } }),
]
```

The first case is graded on escalation; the second renders `–`. Do not point a conditional scorer at `outcome.labels` — that is the agent's own classification, and grading an agent against its own opinion is not an eval.

## Focus and skip

`only: true` on a case wins over everything, as in vitest. `skip: true` drops it. From the CLI, `--only <id>` and `--tag <name>` do the same without editing files.

## Weight

`weight` on a case (default 1) is how much it counts in the suite score, which is a **case-weighted mean** — a case with twelve scorers does not outvote a case with three. Inside a case, `weight` on a scorer is how much that assertion counts toward the case score.

## Fixtures are invented

No real client content: no real names, stock, prices, prompts or logs. Phone numbers are `+549000000xxx`, emails are `@example.com`. Case text may be in Spanish; code, comments, docs and commits are in English.

## When a case fails

The report gives you the reason, the reply and the tool calls without opening anything:

```
✗ near-floor-offer-haggles
    notContains  reply contains forbidden: descuento
    escalated    expected escalated, did not
    reply: Dale, te lo dejo en 17 con descuento.
    tools: sendQuote({"amountUsd":17000})
```

If a case shows `–` in every column, it graded nothing — usually a suite whose invariants all carry a `when` that does not match. That is a bug in the case, not a pass.
