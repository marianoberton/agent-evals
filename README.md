# agent-evals

Most agent evals are an LLM grading another LLM on a 1–5 scale. That is not something you gate a deploy on: it is slow, expensive and non-deterministic. Production agents fail in ways that are checkable without a judge — wrong tool, missing escalation, a promised discount, 20 s latency, 4× cost. **This library makes those checks first-class.** For the judgments that do need semantics ("is this reply on-brand?", "did it answer the question?"), it uses a System One decision model ([Jev](https://docs.typesafe.ai)) that returns a **probability** instead of prose: cheap, ~100 ms, calibrated — so a threshold on it is a real gate. `llmJudge` stays available, flagged non-deterministic, off the gate by default.

Framework-agnostic: the agent under test is `(input) => Promise<Outcome>`. Model calls are recorded once and replayed, so the suite is fast, free and reproducible.

> **Status: M0.** Core contract, runner, 14 deterministic scorers and the report. Jev, cassettes, the CLI's other commands, the vitest helper and the GitHub Action land in M1–M5.

## The 20-line example

```ts
import { defineSuite, defineCase, scorers } from "agent-evals";

export default defineSuite({
  name: "dealership-sales",
  threshold: 0.9,
  agent: myAgent, // any (input) => Promise<Outcome>; see "Plugging in a real agent"

  // Suite scorers are invariants: they run on every case.
  scorers: [
    scorers.notContains(["descuento", "discount"]),
    scorers.latencyUnder(10_000),
    scorers.costUnder(0.05),
    scorers.escalatedWhen({ intent: "price_negotiation" }),
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
agent-evals run evals/dealership.suite.ts --fail-under
```

```
buggy-agent  score 0.64  (threshold 0.90)  ✗ fail

case                      notContains  noPhone  latency  cost       toolCalled  toolNotCalled  escalated  score
stock-ok                  ✓            ✓        30ms ✓   $0.0004 ✓  ✓           –              –          1.00
near-floor-offer-haggles  ✗            ✓        25.0s ✗  $0.2000 ✗  –           ✗              ✗          0.17
contact-leaks-phone       ✓            ✗        40ms ✓   $0.0010 ✓  –           –              –          0.75

Failures
  ✗ near-floor-offer-haggles
      notContains  reply contains forbidden: descuento
      latency      25.0s > 10.0s
      cost         $0.2000 > $0.0500
      escalated    expected escalated, did not
      reply: Dale, te lo dejo en 17 con descuento.
```

A green demo teaches nothing, so the example above is the deliberately buggy agent in `tests/fixtures/`. `examples/echo-agent/` is the green one.

## Quickstart

```bash
pnpm add -D agent-evals
```

```bash
agent-evals run evals/*.suite.ts                  # table + evals/reports/<ts>.json
agent-evals run --threshold 0.95 --fail-under     # CI gate: exit 1 under the threshold
agent-evals run --tag policy                      # only cases with a tag
agent-evals run --only price-negotiation-escalates
```

## The agent contract

The whole integration surface. Anything that matches it can be evaluated.

```ts
type Agent = (input: AgentInput) => Promise<OutcomeInput>;

interface AgentInput {
  history: readonly Message[];   // { role, text }
  inbound: Message;
  caseId: string; suite: string; tags: readonly string[]; meta: Record<string, unknown>;
  fetch: typeof globalThis.fetch; // pass this to your provider and calls are cassetted
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

**Absent means unknown, not false.** A scorer that needs a field the agent never reported returns `pass: null` and renders `–`. It never fails an agent for something the agent did not claim to measure, and it never passes it either.

### Plugging in a real agent

Real runtimes do not have this shape, and they should not have to: the adapter is a
handful of lines and it belongs on **their** side, where the trace vocabulary is known.
[guarded-agent](https://github.com/marianoberton/guarded-agent)'s `runTurn` is
`(state, inbound, deps) => Promise<TurnResult>`, so:

```ts
agent: (input) =>
  runTurn(stateFrom(input.history), { conversationId: input.caseId, text: input.inbound.text, at: 0 }, deps)
    .then(toOutcome), // actions → outbound/transitions, trace → toolCalls/latency/cost
```

This package exports no runtime types to the agent under test. The contract is
structural, which is what makes `npm i -D agent-evals` from a clean project work and
what keeps a zod-4 runtime from colliding with the zod-3 in here.

## Scorers

| Scorer | Asserts |
|---|---|
| `toolCalled(name)` / `toolNotCalled(name)` | the tool is / is not among the calls |
| `toolArgs(tool, schema)` | every call's args satisfy a zod schema |
| `noToolCalled()` | nothing was called — the "it must refuse" assertion |
| `escalated()` / `blocked()` / `handoff()` | the transition happened (`{ expected: false }` inverts it) |
| `escalatedWhen({ intent })` | cases with that declared intent must escalate; others render `–` |
| `contains(needles)` / `notContains(needles)` | the reply does / does not contain them |
| `matches(re)` / `replied()` / `schema(zod)` | pattern, non-empty reply, structured output |
| `latencyUnder` / `costUnder` / `tokensUnder` / `maxTurns` | budgets, read from what the agent reported |

Every one ships with a passing test, a failing test and a skip test. Details in [docs/SCORERS.md](docs/SCORERS.md); writing cases is in [docs/WRITING_CASES.md](docs/WRITING_CASES.md).

## Determinism

**A suite with cassettes present produces the same report twice. Otherwise it is a bug**, and there is a test that says so. Everything that cannot hold that promise — wall clock, machine load — lives in `report.runMeta` and `CaseReport.durationMs`, which `agent-evals diff` ignores.

That is also why budget scorers read `outcome.latencyMs` rather than the harness's stopwatch: from M1 the cassette records and replays the real network time of the recorded run, so a replayed suite still fails a 20-second turn, identically, every time.

## Jev is not infallible

Jev cannot return a value outside your schema — it will never invent a category. It *can* return a wrong value that is inside the schema. That is why `agent-evals calibrate` exists: it plots the probabilities against labelled outcomes so you pick thresholds from a reliability table instead of from taste.

## Non-goals

Not a prompt playground, not a labelling UI, not a tracing backend (it consumes traces, it does not store them), no hosted service. Files in the repo, report in the PR.

## Roadmap

| | Deliverable |
|---|---|
| **M0** ✅ | types, `defineSuite`/`defineCase`, runner, 14 deterministic scorers, markdown + terminal report |
| M1 | Jev client + `jevJudge` + cassette record/replay |
| M2 | CLI `diff` / `record` / `calibrate`, JSON reports |
| M3 | `agent-evals/vitest` helper |
| M4 | `llmJudge` behind a flag, YAML cases, GitHub Action |
| M5 | README polish, npm 0.1.0, [guarded-agent](https://github.com/marianoberton/guarded-agent) using it in CI |

MIT.
