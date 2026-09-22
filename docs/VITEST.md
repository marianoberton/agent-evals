# Evals as tests

Two ways to run evals through vitest, for two different moments.

## `defineEvals` — a whole suite as tests

```ts
// evals/dealership.evals.test.ts
import { defineEvals } from "agent-evals/vitest";
import suite from "./dealership.suite.js";

defineEvals(suite);
```

That is the file. You get one `it` per case inside a `describe` named after the suite, plus one more that asserts the suite cleared its threshold:

```
✓ dealership-sales > stock-question
✗ dealership-sales > price-negotiation-escalates
✓ dealership-sales > scores at or above 0.90
```

Same runner, same watch mode, same reporter, same CI job as every other test you have. A failing eval reads like a failing assertion, with the scorer's own reason and the reply that caused it:

```
2 of 5 expectation(s) failed:
  ✗ escalated: expected escalated, did not
  ✗ notContains: reply contains forbidden: descuento
  reply: "Dale, te lo dejo en 17 con descuento."
```

Three details worth knowing:

- **The suite runs once**, in a promise shared by every generated test. Running it per `it` would call the agent N times and make the cases interfere through the cassette cursors.
- **`skip` and `only` on a case** become `it.skip` and `it.only`.
- **A case where every scorer skipped fails**, rather than passing. A green test that asserted nothing is worse than a red one.

`defineEvals(suite, { gate: false })` drops the threshold test, for a suite you are still growing. Any `RunOptions` you pass goes to the run: `{ tags: ["policy"] }`, `{ cassettes: { mode: "replay" } }`, and so on.

## `expectAgent` — one assertion, inline

When a whole suite file is more ceremony than the question deserves:

```ts
import { expectAgent } from "agent-evals";

it("escalates instead of haggling", async () => {
  await expectAgent(runTurn, deps)
    .given([
      { role: "user", text: "¿Cuánto sale el Corolla?" },
      { role: "assistant", text: "USD 18.500." },
    ])
    .receives("¿Me lo dejás en 15?")
    .toEscalate()
    .toNotCallTool("sendQuote");
});
```

The `await` is what runs it. Forget it and the assertion silently never happens — the usual failure mode of any fluent builder, and worth a lint rule in your own repo if you use this a lot. `.run()` does the same thing explicitly when you prefer to see it.

The second argument is curried, so a runtime whose entry point takes dependencies reads the same as a bare function.

**It needs no test framework.** `expectAgent` throws a plain `Error`, so it works under jest, `node:test`, or anything else — which is why it is exported from the package root as well as from `agent-evals/vitest`. `defineEvals` genuinely needs vitest's `describe`/`it`, so it lives only behind the subpath.

### What you can assert

| | |
|---|---|
| tools | `.toCallTool(name)` `.toNotCallTool(name)` `.toCallToolWith(name, schema)` `.toCallNoTools()` |
| transitions | `.toEscalate(reason?)` `.toNotEscalate()` `.toBlock()` `.toHandOff()` |
| text | `.toReply()` `.toContain(...)` `.toNotContain(...)` `.toMatch(re)` |
| budgets | `.toRespondUnder(ms)` `.toCostUnder(usd)` `.toUseTokensUnder(n)` |
| anything | `.toSatisfy(scorer)` — including `jevJudge` |

Setup: `.given(...history)`, `.receives(inbound)`, `.named(id)`, `.withMeta({})`, `.withTags(...)`, `.withTimeout(ms)`, `.withFetch(f)`.

`.score()` returns the case score instead of asserting, for a test that wants the number.

These are the same scorer factories a suite uses, so a rule never means one thing in a suite and another in a test.

## Which one

`defineEvals` for the suite you keep and grow — it is the thing CI gates on and the thing `calibrate` and `diff` read. `expectAgent` for the one-off assertion you write while fixing a bug, next to the unit tests for the same code.
