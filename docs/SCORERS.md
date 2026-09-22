# Scorers

A scorer is a pure function from an `Outcome` and a `Case` to a `Score`:

```ts
interface Score {
  pass: boolean | null;   // null = not applicable to this case
  weight: number;
  reason: string;         // readable in a report without opening the case file
  value?: string | number | boolean;
  probability?: number;   // Jev only
}
```

## The three states

`pass: true` and `pass: false` are the obvious ones. **`pass: null` is the one that matters.**

It means "this assertion does not apply here" and it leaves *both* sides of the ratio: it neither helps nor hurts the score, and it renders as `–`. Two things produce it:

1. **The agent did not report the field.** `escalated()` against an agent whose `Outcome` has no `transitions` returns `null`, not `false`. An agent that reports nothing must not be silently credited with "it did not escalate".
2. **`when(case)` returned false.** `escalatedWhen({ intent: "price_negotiation" })` only applies to cases whose declared intent matches; every other case gets `–`.

## Columns

Scorers are grouped into report columns by `group`, which defaults to the part of the `id` before the first `:`. Three different `contains` assertions across a suite are **one** column, not three; the cell shows `✓ 2/2` when a case has several of them, and the per-scorer detail goes in the failures block.

`id` is what makes a scorer unique within a suite. A case-level scorer with the same `id` as a suite-level one **replaces** it. Budget scorers deliberately use their group as their id (`latency`, not `latency:1000`), so `expect: { latencyUnder: 30_000 }` relaxes the suite's limit for one slow case instead of stacking a second, contradictory limit on it.

## Built-ins

### Tools

| Scorer | Passes when | Fails when | Skips when |
|---|---|---|---|
| `toolCalled(name, opts?)` | `name` is among the calls | it is not — the reason names what was called instead | the agent does not report `toolCalls` |
| `toolNotCalled(name, opts?)` | `name` is absent | it was called | idem |
| `toolArgs(tool, schema, opts?)` | every call to `tool` satisfies `schema.parse` | any call is rejected — the reason names `tool(#seq)` and the first line of the error | idem |
| `noToolCalled(opts?)` | no tool ran at all | any tool ran | idem |

`schema` is anything with a throwing `parse`, so a zod schema drops straight in.

### Transitions

| Scorer | Notes |
|---|---|
| `escalated(opts?)` | `{ expected: false }` inverts the assertion; `{ reason: "price_negotiation" }` also checks the transition's reason |
| `blocked(opts?)`, `handoff(opts?)` | same shape |
| `escalatedWhen({ intent \| tag \| meta })` | conditional: applies only to matching cases, others render `–` |

`escalatedWhen` reads the case's **declared ground truth** (`case.meta.intent`, `case.tags`), never the agent's own classifier output. An eval that trusts the agent's label to decide what the agent should have done is grading itself.

All three polarities share one id per transition type, so `expect: { escalated: false }` on a case overrides a suite-level `escalated()` rather than contradicting it.

### Text

| Scorer | Notes |
|---|---|
| `contains(needles, opts?)` | **all** needles by default; `{ mode: "any" }` requires one. The reason lists the missing ones |
| `notContains(needles, opts?)` | **none** of them may appear. The reason lists the ones found |
| `matches(re, opts?)` | a fresh regex is built per call, so a `/g` pattern never carries `lastIndex` between cases |
| `replied(opts?)` | the reply is non-empty after trimming |
| `schema(shape, opts?)` | the reply parses as JSON (`{ parse: "raw" }` skips that) and satisfies `shape` |

Matching folds case and diacritics by default, so `notContains("descuento")` also catches `DESCUENTÓ`. Pass `{ caseSensitive: true }` to turn that off.

### The calibrated judge

| Scorer | Notes |
|---|---|
| `jevJudge({ question, passAbove })` | a `noul`: pass when the probability clears the threshold |
| `jevJudge({ question, passAtMost })` | a `score`: pass when the level is at or below |
| `jevJudge({ question, passIs })` | a `choice`: pass when the pick is one of these |

`kind: "jev"`, so it may be async — its I/O goes through the cassette, never a bare
`fetch`. Every Jev scorer of a case is merged into one request. Full detail, including
the reproducibility rules for `state`, in [JEV_JUDGE.md](JEV_JUDGE.md).

### Budgets

| Scorer | Reads | Limit |
|---|---|---|
| `latencyUnder(ms)` | `outcome.latencyMs` | inclusive |
| `costUnder(usd)` | `outcome.costUsd` | inclusive |
| `tokensUnder(n)` | `outcome.tokens.inputTokens + outputTokens` | inclusive |
| `maxTurns(n)` | `outcome.turns` — model round-trips in the tool loop | inclusive |

Budget scorers read what the **agent reported**, never the harness's wall clock. From M1 the cassette records and replays the real network time and usage of the recorded run, which is what lets a replayed suite still fail a 20-second turn and fail identically twice. An agent that reports nothing gets `–`, not a free pass.

## Options

Every factory takes an options object:

```ts
{
  id?: string;        // override the report column and the identity used for overriding
  weight?: number;    // default 1
  critical?: boolean; // a failure fails the suite regardless of the aggregate score
}
```

## Writing your own

```ts
import { pass, fail, skip } from "agent-evals";
import type { Scorer } from "agent-evals";

export const noPhoneNumber: Scorer = {
  id: "noPhone",
  kind: "deterministic",
  weight: 1,
  score({ outcome }) {
    const text = outcome.outbound.map((m) => m.text).join("\n");
    const found = text.match(/\+\d{8,}/);
    return found
      ? fail({ reason: `reply leaks a phone number: ${found[0]}`, value: found[0] })
      : pass({ reason: "no phone number in the reply" });
  },
};
```

Rules, enforced at run time:

- **Deterministic scorers are pure and synchronous.** Returning a Promise from `kind: "deterministic"` is an error, not a warning.
- Only `kind: "jev"` and `kind: "llm"` may be async, and they get their I/O through the cassette — never a bare `fetch`.
- A scorer that throws fails its own cell with a `‼` and leaves the rest of the row intact.
- Every scorer ships with a passing test, a failing test, a skip test and a line in this file.
