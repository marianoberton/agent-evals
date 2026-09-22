# Running it in CI

The point of the whole library: a number you can put a gate on.

```bash
agent-evals run evals/*.suite.ts --fail-under
```

Exit 0 when the score is at or above the threshold, exit 1 when it is under. Nothing else about the run changes the exit code — a report is always printed and always written.

## The commands

```bash
agent-evals run <suite...>          # run, print a table, write evals/reports/<ts>.json
agent-evals record <suite...>       # re-record every cassette, then run
agent-evals diff <before> <after>   # compare two JSON reports
agent-evals calibrate <suite...>    # Jev probabilities vs labelled outcomes
agent-evals validate <suite...>     # load and check the suites, run nothing
```

`validate` is the cheap one to put first: it loads every suite, catches a duplicate case id or a bad threshold at definition time, and warns about a case that grades nothing — all without calling the agent once.

## Thresholds

| Where | Wins |
|---|---|
| `--threshold 0.95` | over everything |
| `defineSuite({ threshold })` | the default for that suite |
| neither | `1` — a new suite starts strict, and you relax it on purpose |

`--fail-under` controls only the exit code. Without it, a failing suite still prints its table and still writes its report; you just do not get a non-zero exit. That separation is deliberate: you want the report on every run, and the gate only where you mean it.

A `critical: true` scorer fails the suite regardless of the aggregate — for the assertion that has no acceptable failure rate.

## Cassettes in CI

`process.env.CI` forces strict `replay`. CI can never spend money and can never flake on a network hiccup; a missing recording is an error naming the command that fixes it.

That means **cassettes are committed**. Re-record locally when a prompt changes, read the diff, commit it.

```yaml
- run: pnpm agent-evals validate evals/*.suite.ts
- run: pnpm agent-evals run evals/*.suite.ts --fail-under --markdown report.md
```

No API key is needed in CI. That is the point.

## Guarding against regressions

A threshold catches "this got bad". A diff catches "this got worse", which is usually what you actually want on a pull request:

```bash
agent-evals run evals/*.suite.ts --json current.json
agent-evals diff baseline.json current.json --fail-on-regression
```

The diff compares **only** what is reproducible: case scores and per-scorer verdicts. Timings, token counts and `runMeta` are ignored on purpose, or two different machines would report a regression every time.

Regressions are listed first, with the scorer that flipped:

```
dealership-sales  0.93 → 0.78

Regressions (1)
  ✗ price-negotiation-escalates  1.00 → 0.60
      escalated: true → ✗

1 regression(s).
```

Improvements are reported and never block. New and removed cases are listed, never counted as regressions.

## Choosing a Jev threshold

Do not pick `passAbove: 0.9` because it looks like a lot. Label the cases whose answer you already know, then ask:

```bash
agent-evals calibrate evals/dealership.suite.ts
```

```
jev:grounded  n=6  brier=0.176  max gap=0.31

  probability   n   predicted  observed   gap
  0.3–0.4     1      0.31      0.00  -0.31
  0.7–0.8     1      0.72      1.00  +0.28
  0.8–0.9     1      0.88      1.00  +0.12
  0.9–1.0     3      0.95      0.67  -0.29

  Every prediction at or above 0.94 was correct here.
```

Read the last line: on this data, gating at **0.9 would have let a wrong answer through**. The judge said 0.95 and was right two times in three. That is the honest reason `calibrate` exists — Jev cannot return a value outside your schema, but it can return the wrong one inside it.

Ground truth goes on the case:

```ts
{ id: "invents-price", inbound: "¿Me hacés precio?", meta: { expected: { "jev:grounded": false } } }
```

Or `meta: { label: true }` when the suite has a single judge. Cases with no label are skipped and counted, so a suite that labels nothing tells you that instead of printing a confident empty table.

Re-run `calibrate` whenever the question, the model or the prompt changes. A threshold is only as current as the data it came from.

## Reports on disk

`evals/reports/<suite>-<timestamp>.json`, plus `latest.json` next to it — which is what `diff` reads when you give it only one argument. `--json <path>` puts it somewhere else; `--markdown <path>` also writes the PR-pasteable table; `--no-report` writes nothing.

Reports are generated, so `evals/reports/` is in `.gitignore`. Cassettes are not — those are inputs.
