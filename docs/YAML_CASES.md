# Cases in YAML

For the people who write cases and do not write TypeScript.

```yaml
# evals/cases/policy.yaml
- id: price-negotiation-escalates
  description: A price push goes to a human; the agent must not haggle.
  tags: [policy]
  meta:
    intent: price_negotiation
  history:
    - role: user
      text: "¿Cuánto sale el Corolla?"
    - role: assistant
      text: "USD 18.500."
  inbound: "¿Me lo dejás en 15?"
  expect:
    escalated: true
    toolNotCalled: sendQuote
    notContains: [descuento, "te lo dejo en"]
```

```ts
import { defineSuite, scorers } from "agent-evals";
import { loadCases } from "agent-evals";

export default defineSuite({
  name: "dealership-sales",
  threshold: 0.9,
  agent: myAgent,
  scorers: [scorers.notContains(["descuento"]), scorers.latencyUnder(10_000)],
  cases: loadCases("evals/cases"),
});
```

`loadCases` returns ordinary `Case` objects. Nothing downstream knows where they came from: the report, `defineEvals`, `diff` and `calibrate` all behave identically.

## The format

One case per file, or a list of them in one file. `loadCases` takes a file or a directory, and walks a directory recursively in sorted order.

| Field | |
|---|---|
| `id` | required, unique across every file loaded together |
| `inbound` | required. A bare string becomes a `user` message |
| `history` | strings or `{role, text}`; `{role, content}` also works |
| `expect` | see below |
| `tags`, `meta` | as in a TypeScript case — `meta` is the declared ground truth |
| `weight`, `skip`, `only`, `timeoutMs`, `description` | as in a TypeScript case |

Inside `expect`: `toolCalled`, `toolNotCalled`, `escalated`, `blocked`, `handoff`, `contains`, `notContains`, `latencyUnder`, `costUnder`, `tokensUnder`, `maxTurns`. The list ones take a string or a list of strings.

## What YAML deliberately cannot do

`toolArgs`, `matches` and `scorers` are **not** available, and the loader says why rather than ignoring them:

```
evals/cases/a.yaml → expect: unknown key(s): matches (a RegExp has no YAML spelling; use a TypeScript suite)
```

A zod schema, a RegExp and a function have no honest YAML spelling. A half-working one — "regex as a string", say — is a trap: it looks like it works until an escape character silently changes the meaning. Those cases belong in a TypeScript suite, and the two kinds mix freely in one `cases` array.

## Errors name the file and the field

A fixture format lives or dies on its error messages:

```
Invalid case file:
  evals/cases/offer.yaml → expect.latencyUnder: Expected number, received string
  evals/cases/offer.yaml → inbound: Required
```

Unknown keys are rejected rather than ignored, so a typo (`expct:`) fails loudly instead of silently dropping the assertion — which would leave a green case that tests nothing.

Two cases with the same id fail and name both files.

## Mixing

```ts
cases: [
  ...loadCases("evals/cases"),
  defineCase({ id: "structured-reply", inbound: "…", expect: { schema: ReplySchema } }),
]
```
