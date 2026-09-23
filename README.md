# agent-evals

A test runner for LLM agents that produces a number you can gate a deploy on.

[![CI](https://github.com/marianoberton/agent-evals/actions/workflows/ci.yml/badge.svg)](https://github.com/marianoberton/agent-evals/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-evals.svg)](https://www.npmjs.com/package/agent-evals)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Most agent evals ask one LLM to grade another on a 1–5 scale. You cannot gate a deploy on that number. It is slow, it costs money every run, and asking the same question twice gives you two answers.

The failures that actually reach production are not matters of taste. The agent called the wrong tool. It kept haggling instead of handing the conversation to a human. It promised a discount it had no authority to give. It took 25 seconds. It cost forty times what that reply should cost. Every one of those is checkable with a rule, and a rule runs in a millisecond for free.

This library makes those checks first-class. For the judgments that genuinely need semantics — *is this reply on-brand, did it actually answer the question* — it asks [Jev](https://docs.typesafe.ai), a System One model that returns a **calibrated probability** instead of prose. `0.91` compares against a threshold. A paragraph does not.

## What it catches

A sales agent for a car dealership, with three bugs planted in it:

```
$ agent-evals run evals/buggy.suite.ts --fail-under

buggy-agent  score 0.64  (threshold 0.90)  ✗ fail

case                      notContains  noPhone  latency  cost       toolCalled  toolNotCalled  escalated  score
stock-ok                  ✓            ✓        30ms ✓   $0.0004 ✓  ✓           –              –          1.00
near-floor-offer-haggles  ✗            ✓        25.0s ✗  $0.2000 ✗  –           ✗              ✗          0.17
contact-leaks-phone       ✓            ✗        40ms ✓   $0.0010 ✓  –           –              –          0.75

Failures
  ✗ near-floor-offer-haggles
      notContains    reply contains forbidden: descuento
      latency        25.0s > 10.0s
      cost           $0.2000 > $0.0500
      toolNotCalled  sendQuote must not be called
      escalated      expected escalated, did not
      reply: Dale, te lo dejo en 17 con descuento.

  ✗ contact-leaks-phone
      noPhone        reply does not match /^(?!.*\+\d{8}).*$/
      reply: Escribinos al +549000000123.

3 case(s) in 8ms

$ echo $?
1
```

One message, five distinct production failures, no opinion required to find any of them. Exit code 1, so CI stops there.

Those `–` cells matter as much as the crosses, and the next section explains why.

## Writing a suite

```ts
import { defineSuite, defineCase, scorers, jev, jevJudge } from "agent-evals";

export default defineSuite({
  name: "dealership-sales",
  threshold: 0.9,
  agent: myAgent,

  // Invariants: these run on every case.
  scorers: [
    scorers.notContains(["descuento", "discount"]),
    scorers.latencyUnder(10_000),
    scorers.costUnder(0.05),
    scorers.escalatedWhen({ intent: "price_negotiation" }),
    jevJudge({
      question: jev.noul("Does the reply stay within what the dealership knows?"),
      passAbove: 0.94,
    }),
  ],

  cases: [
    defineCase({
      id: "stock-question",
      inbound: "¿Tienen Corolla 2022 automático?",
      expect: { toolCalled: "lookupStock", escalated: false },
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
  ],
});
```

The agent under test is `(input) => Promise<Outcome>`. No framework, no base class, no decorators. If your runtime does not have that shape, you write a ten-line adapter on your side: [`examples/guarded-agent/adapter.ts`](examples/guarded-agent/adapter.ts) is a complete worked one against a runtime whose entry point shares no field at all with `Outcome`.

## Design notes

The interesting decisions, and the traps behind them.

### An absent field means *unknown*, never *false*

`Score.pass` is `boolean | null`. The third state is the one that does the work.

An agent that never reports tool calls has not told you it called none. If `toolNotCalled("sendQuote")` returned `false` there, the eval would be inventing evidence: the suite goes green, the assertion was never made, and you find out in production. So the scorer returns `null`, which leaves both sides of the ratio and renders `–`.

```ts
export function didTransition(outcome: Outcome, type: TransitionType): boolean | null {
  if (outcome.transitions === undefined) return null;   // the agent never said
  return outcome.transitions.some((t) => t.type === type);
}
```

The same state also covers "this scorer does not apply to this case". `escalatedWhen({ intent: "price_negotiation" })` grades only the cases that declare that intent; the rest render `–` and are neither helped nor hurt.

A case where *every* scorer skipped fails, in both the CLI and the vitest helper. A green test that asserted nothing is worse than a red one.

### Cassettes replay timing and cost, not just responses

Model calls are recorded once and replayed forever, which is the ordinary part. The non-obvious part is what else goes on the tape.

If `latencyUnder(10_000)` measured the wall clock, two runs of the same suite would disagree and the determinism promise would be dead. Worse: once the network is replayed, wall-clock time is near zero, so the scorer would pass everything and catch nothing. A latency check that always passes is more dangerous than no latency check, because you believe it.

So the cassette records the **real** duration, token count and cost of each recorded call, and replays those:

```json
"timing": { "durationMs": 1840 },
"usage":  { "inputTokens": 1204, "outputTokens": 88, "costUsd": 0.0041 }
```

A replayed suite still fails a 25-second turn, and fails it identically every time. That is the load-bearing decision in the whole recording layer.

CI is forced into strict replay whenever `process.env.CI` is set: it can never spend money, and never flake on someone else's outage.

### The judge cannot see anything that changes between runs

The cassette key is a hash of the request. So a scorer that puts `latencyMs` into the state it sends the judge re-hashes on every run, misses the tape on every run, and quietly turns a deterministic suite back into a non-deterministic one. Nothing fails. The bill just goes up.

`state: (outcome) => outcome` is the obvious thing to write, and it is the trap. A guard walks the state and refuses:

```
Scorer "jev:grounded" put state.outcome.latencyMs into its Jev state. That value
changes every run, so the cassette would never match and the suite would stop
being reproducible. Drop it, or pass { allowVolatileState: true } if you really
mean it.
```

An error, not a warning. A warning in a CI log is a warning nobody reads.

### One HTTP request per case, by construction

Scorers never call the judge. They *declare* questions in `plan()` and read answers in `score()`:

```ts
plan(outcome, kase) {
  return { state: build(outcome, kase), questions: { q: question } };
}
```

That indirection lets the runner collect every judge in a case, group them by identical state, and issue one request per group. Two judges on the same reply become one call carrying two questions instead of two calls each re-sending the conversation. In the reference measurements that is roughly ten times faster and twelve times cheaper, and it falls out of the architecture rather than out of a cache.

Question keys are namespaced on the wire and mapped back before a scorer sees them, so two scorers can both use the key `q`. Plans are iterated in sorted order, so the request body — and therefore the cassette key — is identical regardless of which scorer finished planning first.

### Do not trust a threshold you have not measured

Jev cannot return a value outside your schema. Give it three options and it returns one of those three. It **can** return the wrong one of the three, and any honest case for gating on a model's probability has to deal with that.

So label the cases whose answer you already know, and ask:

```
$ agent-evals calibrate evals/grounded.suite.ts

jev:grounded  n=6  brier=0.176  max gap=0.31

  probability   n   predicted  observed   gap
  0.3–0.4     1      0.31      0.00  -0.31  ··········
  0.7–0.8     1      0.72      1.00  +0.28  ██████████
  0.8–0.9     1      0.88      1.00  +0.12  ██████████
  0.9–1.0     3      0.95      0.67  -0.29  ███████···

  Every prediction at or above 0.94 was correct here.
```

Read the 0.9–1.0 row: the judge promised 0.95 and delivered 0.67. Gating at 0.90 on this data **would have let a wrong answer through**. The safe cut was 0.94.

That is why the suite above uses `passAbove: 0.94` and not the round number. Re-run `calibrate` whenever the question, the model or the prompt changes, because a threshold is only as current as the data behind it.

## Using it

```bash
npm i -D agent-evals
```

```bash
agent-evals validate evals/*.suite.ts            # load and check, run nothing
agent-evals run      evals/*.suite.ts --fail-under
agent-evals record   evals/*.suite.ts            # re-record the cassettes
agent-evals diff     baseline.json latest.json --fail-on-regression
agent-evals calibrate evals/*.suite.ts
```

`--fail-under` gates on *is bad*; `diff --fail-on-regression` gates on *got worse*, which is usually what you want on a pull request. The diff compares only what is reproducible — case scores and per-scorer verdicts — because including timings means two machines disagree and the gate gets switched off within a fortnight.

**As vitest tests**, which is how most people will want them:

```ts
import { defineEvals } from "agent-evals/vitest";
import suite from "./dealership.suite.js";

defineEvals(suite);   // one `it` per case, plus one for the threshold
```

Same runner, same watch mode, same reporter, same CI job as everything else. Or assert inline, next to the unit tests for the code you are fixing:

```ts
await expectAgent(runTurn, deps)
  .given(history)
  .receives("¿Me lo dejás en 15?")
  .toEscalate()
  .toNotCallTool("sendQuote");
```

`expectAgent` throws a plain `Error`, so it needs no test framework at all and works under jest or `node:test`.

**In CI:**

```yaml
- uses: marianoberton/agent-evals/action@v0
  with:
    suites: evals/*.suite.ts
    baseline: evals/baseline.json
```

Runs the suites, fails the job under the threshold, and posts the report as one pull-request comment that it edits in place on each push. No API key: the cassettes replay.

**Cases in YAML**, for the people who write them and do not write TypeScript:

```yaml
id: price-negotiation-escalates
tags: [policy]
meta: { intent: price_negotiation }
inbound: "¿Me lo dejás en 15?"
expect:
  escalated: true
  toolNotCalled: sendQuote
```

`loadCases("evals/cases")` returns ordinary `Case` objects, so nothing downstream can tell them apart, and the two kinds mix in one array. `toolArgs`, `matches` and custom scorers are deliberately *not* expressible in YAML: a zod schema, a RegExp and a function have no honest YAML spelling, and a half-working one is a trap. The loader says exactly that instead of ignoring the key.

## The scorers

| | |
|---|---|
| **Tools** | `toolCalled` · `toolNotCalled` · `toolArgs` (zod) · `noToolCalled` |
| **Transitions** | `escalated` · `blocked` · `handoff` · `escalatedWhen({ intent })` |
| **Reply** | `contains` · `notContains` · `matches` · `replied` · `schema` |
| **Budgets** | `latencyUnder` · `costUnder` · `tokensUnder` · `maxTurns` |
| **Judges** | `jevJudge` (calibrated, on the gate) · `llmJudge` (**off** the gate) |

Nineteen in all. Every one ships with a passing test, a failing test and a skip test, because the skip path is the one that silently turns a suite green.

`llmJudge` exists, and `kind: "llm"` means it does not run at all without `--include-llm-judge`. That default is the library's argument expressed as a flag.

Writing your own is a function:

```ts
export const noPhoneNumber: Scorer = {
  id: "noPhone",
  kind: "deterministic",
  weight: 1,
  score({ outcome }) {
    const found = outcome.outbound.map((m) => m.text).join("\n").match(/\+\d{8,}/);
    return found
      ? fail({ reason: `reply leaks a phone number: ${found[0]}`, value: found[0] })
      : pass({ reason: "no phone number in the reply" });
  },
};
```

Deterministic scorers must be pure and synchronous. Returning a Promise from one is a runtime error, not a warning.

## How it fits together

```
case ─▶ agent ─▶ Outcome ─┬─▶ sync scorers ──────────────┐
                          │                              ├─▶ case score ─▶ suite score ─▶ gate
                          ├─▶ plan() ─▶ ONE Jev request ─┤
                          └─▶ llmJudge (opt-in) ─────────┘
                                   │
                              all HTTP through the cassette
```

```
src/core/       types, define, run, score, expect, normalize
src/scorers/    one file per family; jevJudge, llmJudge
src/jev/        client (ported from a working Python one), questions, batching
src/cassette/   canonical hashing, record/replay store, redaction
src/cli/        diff, calibrate, suite loading
src/vitest/     defineEvals, expectAgent
src/yaml/       case loader with file:field errors
```

292 tests across 21 files, 92.8% statements. Roughly as much test and example code as source. Three runtime dependencies: `zod`, `yaml`, `picocolors`.

Five examples run in CI **offline, with no API key**: a passing agent, a deliberately broken one that must stay broken, a YAML suite, a calibration suite, and a full dealership suite with two Jev judges replaying from committed cassettes.

## What this is not

Not a prompt playground. Not a labelling UI. Not a tracing backend — it consumes traces, it does not store them. No hosted service, no account, no dashboard. Files in your repo, report in your pull request.

Honest limits:

- `llmJudge` is non-deterministic by nature. It is shipped, documented as such, and off the gate.
- Budget scorers read what the agent reports. An agent that reports nothing gets `–`, not a pass.
- Cassettes are committed, which means re-recording after a prompt change is a diff you have to read. That is a feature, and it is also work.
- YAML cases cannot express a zod schema, a RegExp or a custom scorer. Those need a TypeScript suite.

## Related

[guarded-agent](https://github.com/marianoberton/guarded-agent) — a runtime for conversational agents that run inside a real operation, where deterministic gates handle policy, a System One model handles bounded decisions, and the LLM only writes. It is the reference consumer of this library.

## Documentation

[Writing cases](docs/WRITING_CASES.md) · [Scorers](docs/SCORERS.md) · [The calibrated judge](docs/JEV_JUDGE.md) · [Cassettes](docs/CASSETTES.md) · [Vitest](docs/VITEST.md) · [YAML cases](docs/YAML_CASES.md) · [CI](docs/CI.md)

## License

MIT © [Mariano Berton](https://github.com/marianoberton)
