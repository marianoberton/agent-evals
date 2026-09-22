# agent-evals

[![CI](https://github.com/marianoberton/agent-evals/actions/workflows/ci.yml/badge.svg)](https://github.com/marianoberton/agent-evals/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agent-evals.svg)](https://www.npmjs.com/package/agent-evals)

Most agent evals are an LLM grading another LLM on a 1–5 scale. That is not something you gate a deploy on: it is slow, expensive and non-deterministic. Production agents fail in ways that are checkable without a judge — wrong tool, missing escalation, a promised discount, 20 s latency, 4× cost. **This library makes those checks first-class.** For the judgments that do need semantics ("is this reply on-brand?", "did it answer the question?"), it uses a System One decision model ([Jev](https://docs.typesafe.ai)) that returns a **probability** instead of prose: cheap, ~100 ms, calibrated — so a threshold on it is a real gate. `llmJudge` stays available, flagged non-deterministic, off the gate by default.

Framework-agnostic: the agent under test is `(input) => Promise<Outcome>`. Model calls are recorded once and replayed, so the suite is fast, free and reproducible.

```bash
npm i -D agent-evals
```

## The 20-line example

```ts
import { defineSuite, defineCase, scorers, jev, jevJudge } from "agent-evals";

export default defineSuite({
  name: "dealership-sales",
  threshold: 0.9,
  agent: myAgent,

  // Suite scorers are invariants: they run on every case.
  scorers: [
    scorers.notContains(["descuento", "discount"]),
    scorers.latencyUnder(10_000),
    scorers.costUnder(0.05),
    scorers.escalatedWhen({ intent: "price_negotiation" }),
    jevJudge({
      id: "jev:grounded",
      question: jev.noul("Does the reply stay within what the dealership knows?"),
      passAbove: 0.9,
    }),
  ],

  cases: [
    defineCase({
      id: "stock-question",
      inbound: "¿Tienen Corolla 2022 automático?",
      expect: { toolCalled: "lookupStock", escalated: false },
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
  ],
});
```

```
$ agent-evals run evals/dealership.suite.ts --fail-under

dealership-sales  score 1.00  (threshold 0.90)  ✓ pass

case                         notContains  latency  cost       jev:grounded  jev:pushy  toolCalled  escalated  contains  escalatedWhen  handoff  score
stock-question               ✓            1.5s ✓   $0.0031 ✓  0.97 ✓        0.60 ✓     ✓           ✓          ✓         –              –        1.00
unknown-model                ✓ 2/2        1.5s ✓   $0.0031 ✓  0.94 ✓        0.90 ✓     ✓           –          –         –              –        1.00
price-negotiation-escalates  ✓            97ms ✓   $0.0000 ✓  0.96 ✓        0.10 ✓     –           ✓          –         ✓              –        1.00
wants-human-hands-off        ✓            103ms ✓  –          0.95 ✓        0.20 ✓     –           –          ✓         –              ✓        1.00
```

Two things to notice. The latency is **real** — 1.5 s on the path that calls a model, 97 ms on the one that escalates without calling anything — replayed from the cassette, not measured with a stopwatch. And `cost` is `–` on the last row, because that path reported none: an absent field means *unknown*, never *zero*.

A green demo teaches nothing, so here is the deliberately buggy agent from `tests/fixtures/`:

```
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
      escalated      expected escalated, did not
      reply: Dale, te lo dejo en 17 con descuento.
```

One message, four distinct production failures, none of them requiring an opinion.

## Quickstart

```bash
agent-evals validate evals/*.suite.ts            # load and check, run nothing
agent-evals run evals/*.suite.ts --fail-under    # the CI gate: exit 1 under the threshold
agent-evals record evals/*.suite.ts              # re-record the cassettes
agent-evals diff baseline.json latest.json --fail-on-regression
agent-evals calibrate evals/*.suite.ts           # Jev probabilities vs known answers
```

Also `--tag`, `--only`, `--threshold`, `--concurrency`, `--cassettes <mode>`, `--markdown report.md`. See [docs/CI.md](docs/CI.md).

## The agent contract

The whole integration surface. Anything matching it can be evaluated.

```ts
type Agent = (input: AgentInput) => Promise<OutcomeInput>;

interface AgentInput {
  history: readonly Message[];   // { role, text }
  inbound: Message;
  caseId: string; suite: string; tags: readonly string[]; meta: Record<string, unknown>;
  fetch: typeof globalThis.fetch; // pass this to your provider and calls are taped
  signal: AbortSignal; seed: number;
}

interface Outcome {
  outbound: readonly Message[];           // the only required field
  toolCalls?: readonly ToolCall[];        // { name, args, result?, ok?, verdict?, seq }
  transitions?: readonly Transition[];    // escalated | blocked | handoff | skipped, with a reason
  turns?: number; latencyMs?: number; tokens?: Usage; costUsd?: number;
  labels?: Record<string, string | number | boolean>;
  trace?: unknown;
}
```

**Absent means unknown, not false.** A scorer that needs a field the agent never reported returns `pass: null` and renders `–`. It never fails an agent for something it did not claim to measure, and never passes it either.

### Plugging in a real agent

Real runtimes do not have this shape, and should not have to. The adapter is a handful of lines and belongs on **their** side, where the trace vocabulary is known. [`examples/guarded-agent/adapter.ts`](examples/guarded-agent/adapter.ts) is a complete worked one against a runtime whose entry point is `runTurn(state, inbound, deps) => TurnResult` — not one field in common with `Outcome`:

```ts
agent: asAgent(runTurn, deps)   // stateFrom + inboundFrom in, toOutcome out
```

This package exports no runtime types to the agent under test. The contract is structural, which is what makes `npm i -D agent-evals` work from a clean project and keeps a zod-4 runtime from colliding with the zod-3 in here.

## Scorers

| Scorer | Asserts |
|---|---|
| `toolCalled(name)` / `toolNotCalled(name)` | the tool is / is not among the calls |
| `toolArgs(tool, schema)` | every call's args satisfy a zod schema |
| `noToolCalled()` | nothing was called — the "it must refuse" assertion |
| `escalated()` / `blocked()` / `handoff()` | the transition happened (`{ expected: false }` inverts it) |
| `escalatedWhen({ intent })` | cases with that declared intent must escalate; others render `–` |
| `contains` / `notContains` / `matches` / `replied` / `schema` | the reply |
| `latencyUnder` / `costUnder` / `tokensUnder` / `maxTurns` | budgets, from what the agent reported |
| `jevJudge({ question, passAbove })` | a calibrated probability clears a threshold |
| `llmJudge({ rubric })` | an LLM's opinion — **off the gate** unless `--include-llm-judge` |

Every one ships with a passing test, a failing test and a skip test.

[docs/SCORERS.md](docs/SCORERS.md) · [docs/WRITING_CASES.md](docs/WRITING_CASES.md) · [docs/JEV_JUDGE.md](docs/JEV_JUDGE.md) · [docs/CASSETTES.md](docs/CASSETTES.md) · [docs/VITEST.md](docs/VITEST.md) · [docs/YAML_CASES.md](docs/YAML_CASES.md) · [docs/CI.md](docs/CI.md)

## Evals are tests

A suite becomes vitest tests in one line — same runner, same watch mode, same CI job:

```ts
import { defineEvals } from "agent-evals/vitest";
import suite from "./dealership.suite.js";

defineEvals(suite);   // one `it` per case, plus one for the threshold
```

Or assert inline, next to the unit tests for the same code:

```ts
await expectAgent(runTurn, deps)
  .given(history)
  .receives("¿Me lo dejás en 15?")
  .toEscalate()
  .toNotCallTool("sendQuote");
```

`expectAgent` throws a plain `Error`, so it needs no test framework and works under jest or `node:test`.

## Cases in YAML

For the people who write cases and do not write TypeScript:

```yaml
id: price-negotiation-escalates
tags: [policy]
meta: { intent: price_negotiation }
inbound: "¿Me lo dejás en 15?"
expect:
  escalated: true
  toolNotCalled: sendQuote
```

```ts
cases: loadCases("evals/cases")
```

They become ordinary `Case` objects, so nothing downstream can tell them apart, and the two kinds mix in one array.

## Determinism

**A suite with cassettes present produces the same report twice. Otherwise it is a bug**, and there is a test that says so. Everything that cannot hold that promise — wall clock, machine load — lives in `report.runMeta` and `CaseReport.durationMs`, which `agent-evals diff` ignores.

Pass the `fetch` you are given to your provider and every model call is taped:

```ts
agent: async ({ history, inbound, fetch }) => myProvider.complete({ history, inbound, fetch })
```

The first run records to `evals/__cassettes__/<suite>/<case>.json`; every run after makes zero network calls. CI is forced into strict replay, so it can never spend money or flake.

That is also why budget scorers read `outcome.latencyMs` rather than the harness's stopwatch: the cassette records and replays the real network time of the recorded run, so a replayed suite still fails a 20-second turn, identically, every time.

## Jev is not infallible

Jev cannot return a value outside your schema — it will never invent a category. It *can* return a wrong value that is inside the schema. So do not pick a threshold because it looks like a lot; label the cases whose answer you already know and ask:

```
$ agent-evals calibrate examples/calibration/calibrate.suite.ts

jev:grounded  n=6  brier=0.176  max gap=0.31

  probability   n   predicted  observed   gap
  0.3–0.4     1      0.31      0.00  -0.31
  0.7–0.8     1      0.72      1.00  +0.28
  0.8–0.9     1      0.88      1.00  +0.12
  0.9–1.0     3      0.95      0.67  -0.29

  Every prediction at or above 0.94 was correct here.
```

Read the last line. On this data, gating at 0.9 **would have let a wrong answer through** — the judge said 0.95 and was right two times in three.

## In CI

```yaml
- uses: marianoberton/agent-evals/action@v0
  with:
    suites: evals/*.suite.ts
    baseline: evals/baseline.json   # optional: also fail on a regression
```

Runs the suites, fails the job under the threshold, and posts the table as a single pull-request comment it edits in place on every push. **No API key needed**: cassettes replay because `CI` is set.

## Non-goals

Not a prompt playground, not a labelling UI, not a tracing backend (it consumes traces, it does not store them), no hosted service. Files in the repo, report in the PR.

## Related

[guarded-agent](https://github.com/marianoberton/guarded-agent) — a runtime for conversational agents that run inside a real operation, and the reference consumer of this library.

MIT.
