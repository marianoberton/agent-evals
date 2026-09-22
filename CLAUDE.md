Deterministic evaluation harness for LLM agents, with a **calibrated judge (Jev) that can act as a CI gate**. You describe cases (conversation so far, new message, what must and must not happen), run them against any agent function, and get a scored report. Model calls are recorded once and replayed, so the suite is fast, free and reproducible.

Framework-agnostic: the agent under test is `(input) => Promise<Outcome>`. Works with `guarded-agent` out of the box, does not depend on it.

## Thesis (this is the README's first paragraph)

Most agent evals are an LLM grading another LLM on a 1–5 scale. That is not something you gate a deploy on: it is slow, expensive and non-deterministic. Production agents fail in ways that are checkable without a judge (wrong tool, missing escalation, a promised discount, 20 s latency, 4× cost). This library makes those checks first-class. And for the judgments that do need semantics ("is this reply on-brand?", "did it answer the question?"), it uses a **System One decision model (Jev)** that returns a probability instead of prose: cheap, ~100 ms, calibrated, so a threshold on it is a real gate. `llmJudge` stays available, flagged non-deterministic, off the gate by default.

## Non-goals

- Not a prompt playground or a labelling UI.
- Not a tracing backend. It consumes traces, does not store them.
- No hosted service. Files in the repo, report in the PR.

## Stack

- TypeScript, ESM, Node 20+. Deps: `zod`, `yaml`, `picocolors`. Optional peer: `vitest`.
- Jev via the TypeSafe API (`state` + typed `questions` → `noul` / `choice` / `score` with probabilities). Before writing the client, read https://docs.typesafe.ai and install the official skill: `npx skills add typesafe-ai/skills --skill typesafe-ai`. Support a `baseUrl` override so it also runs through OpenRouter / Vercel AI Gateway / Cloudflare.
- Cassettes: a `Cassette` wraps any provider (LLM or Jev). First run records request/response by content hash to `evals/__cassettes__/<suite>/<case>.json`; later runs replay. Changing the prompt or the question invalidates on purpose.

## Core concepts

| Concept | What it is |
|---|---|
| `Case` | history + inbound + expectations + tags |
| `Outcome` | outbound messages, tool calls with args, transitions (`escalated`, `blocked`, `handoff`), latency, tokens, cost, raw trace |
| `Scorer` | `(outcome, case) => Score`, `Score = { pass, weight, reason, probability? }` |
| `Suite` | cases + scorers + threshold + agent |
| `Report` | per-case, per-scorer pass rates, aggregate, diff vs previous run |

## Public API (v0.1)

```ts
import { defineSuite, defineCase, scorers, jev } from "agent-evals";
import { runTurn } from "guarded-agent";

export default defineSuite({
  name: "dealership-sales",
  threshold: 0.9,
  agent: (input) => runTurn(input, deps),
  scorers: [
    scorers.toolCalled("lookupStock"),
    scorers.toolNotCalled("sendQuote"),
    scorers.escalatedWhen({ intent: "price_negotiation" }),
    scorers.notContains(["descuento", "discount"]),
    scorers.latencyUnder(10_000),
    scorers.costUnder(0.05),
    // calibrated judge: a Jev noul over the outbound message, gated at 0.9
    scorers.jevJudge({
      question: jev.noul("Does the reply answer the customer's question without inventing stock or prices?"),
      state: (o, c) => ({ history: c.history, inbound: c.inbound, reply: o.outbound }),
      passAbove: 0.9,
    }),
    scorers.jevJudge({
      question: jev.score("How pushy is the reply?", ["Neutral", "Mildly salesy", "Aggressive"]),
      passAtMost: 1,
    }),
    scorers.llmJudge({ rubric: "...", model: "claude-haiku-4-5" }, { nondeterministic: true }),
  ],
  cases: [
    defineCase({ id: "stock-question", history: [], inbound: "¿Tienen Corolla 2022 automático?",
      expect: { toolCalled: "lookupStock" }, tags: ["happy-path"] }),
    defineCase({ id: "price-negotiation-escalates",
      history: [{ role: "user", text: "¿Cuánto sale el Corolla?" }, { role: "assistant", text: "USD 18.500." }],
      inbound: "¿Me lo dejás en 15?", expect: { escalated: true, toolNotCalled: "sendQuote" }, tags: ["policy"] }),
  ],
});
```

`jevJudge` batches all Jev questions of a case into **one** request (shared state, parallel questions) and records the probabilities in the report, not just pass/fail. Cases can also be YAML (`evals/cases/*.yaml`).

### Vitest helper

```ts
import { expectAgent } from "agent-evals/vitest";
await expectAgent(runTurn, deps).given(history).receives("¿Me lo dejás en 15?").toEscalate().toNotCallTool("sendQuote");
```

### CLI

```
agent-evals run evals/*.suite.ts                 # table + evals/reports/<ts>.json
agent-evals run --threshold 0.95 --fail-under    # CI gate
agent-evals run --include-llm-judge              # opt-in for the non-deterministic one
agent-evals diff evals/reports/latest.json evals/reports/prev.json
agent-evals record evals/dealership.suite.ts     # re-record cassettes (LLM + Jev)
agent-evals calibrate evals/dealership.suite.ts  # Jev probabilities vs labelled outcomes → reliability table
```

## Scorers in v0.1

Deterministic: `toolCalled`, `toolNotCalled`, `toolArgs` (zod), `escalated`, `escalatedWhen`, `blocked`, `contains`, `notContains`, `matches`, `schema`, `latencyUnder`, `costUnder`, `tokensUnder`, `maxTurns`.
Probabilistic, on the gate: `jevJudge` (noul / choice / score, with `passAbove` / `passAtMost` / `passIs`).
Non-deterministic, off the gate: `llmJudge`.

## Report

```
dealership-sales  score 0.93  (threshold 0.90)  ✓
case                          toolCalled  escalatedWhen  notContains  latency  cost   jev:answers  jev:pushy
stock-question                    ✓            –             ✓          ✓       ✓     0.97 ✓       0.2 ✓
price-negotiation-escalates       –            ✓             ✓          ✓       ✗     0.91 ✓       1.4 ✗
```

GitHub Action posts the table, fails under threshold.

## Layout

```
src/core/       types, defineSuite, defineCase, run, report
src/scorers/    one file per scorer; jevJudge.ts
src/jev/        client.ts (state + questions → answers), questions.ts (noul/choice/score builders)
src/cassette/   record, replay, hash
src/vitest/     expectAgent
src/cli/        run, diff, record, calibrate
src/yaml/       loader
examples/echo-agent/   trivial agent, shows the contract
examples/guarded-agent/ the dealership suite
action/         composite GitHub Action
docs/           WRITING_CASES, SCORERS, JEV_JUDGE, CASSETTES, CI
```

## Milestones

| | Deliverable | Done when |
|---|---|---|
| M0 | types, defineSuite/Case, run, 6 deterministic scorers, markdown report | echo-agent passes in tests |
| M1 | Jev client + `jevJudge` (noul, score, choice) + cassette record/replay for LLM and Jev | second run makes zero network calls; jev probabilities appear in the report |
| M2 | CLI (`run`, `diff`, `record`, `calibrate`) + JSON reports | `--fail-under` exits 1; `calibrate` prints a reliability table from labelled cases |
| M3 | Vitest helper | used in guarded-agent's tests |
| M4 | `llmJudge` behind flag + YAML cases + GitHub Action | PR comment shows the table |
| M5 | README (thesis, 20-line example, report screenshot), npm 0.1.0, guarded-agent uses it in CI | `npm i -D agent-evals` works from a clean project |

Build M0 → M5. M0 is the whole idea; if the echo example isn't obvious, fix the API before M1.

## Rules for Claude Code

- Scorers are pure and sync except `jevJudge` and `llmJudge`; both go through the cassette.
- A suite with cassettes present produces the same report twice. Otherwise it's a bug.
- Every scorer ships with a passing test, a failing test, and a line in `docs/SCORERS.md`.
- Never claim Jev "can't hallucinate". It can't return an invalid type; it can return a wrong valid one. That is why `calibrate` exists — say so in the docs.
- No real client data in cases or cassettes. Fixtures are invented and marked as such. Case content may be in Spanish.
- English in code, comments, docs, commits. Conventional commits. One PR per milestone.

## Publication checklist

- [ ] README, cassettes reviewed (no keys, no real data), MIT, `npm publish`.
- [ ] Submit to madewithjev.com and the awesome-jev lists once `jevJudge` is in.