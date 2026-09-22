# Changelog

## 0.1.0

First release. The whole idea: describe a case, run it against any
`(input) => Promise<Outcome>` agent, get a score you can gate a deploy on.

### Deterministic scorers
`toolCalled`, `toolNotCalled`, `toolArgs`, `noToolCalled`, `escalated`,
`escalatedWhen`, `blocked`, `handoff`, `contains`, `notContains`, `matches`,
`replied`, `schema`, `latencyUnder`, `costUnder`, `tokensUnder`, `maxTurns`.

Each is pure and synchronous, and each has a passing test, a failing test and a
skip test.

### The calibrated judge
`jevJudge` asks Jev — a System One model that returns a probability, not prose —
so a threshold on it is a real gate. Every Jev scorer in a case is merged into
one request. `agent-evals calibrate` plots those probabilities against cases
whose answer you already know, because Jev cannot return a value outside your
schema but can return the wrong one inside it.

### Cassettes
Model calls are recorded once and replayed forever, latency and usage included.
A suite with cassettes present produces the same report twice, and a test
enforces it. CI is forced into strict replay, so it needs no API key.

### The rest
The CLI (`run`, `record`, `diff`, `calibrate`, `validate`), the vitest helpers
(`defineEvals`, `expectAgent`), YAML cases, `llmJudge` behind a flag, and a
composite GitHub Action that comments the table on the pull request.

### Known limits
- `llmJudge` is non-deterministic by nature and off the gate by default.
- YAML cases cannot express `toolArgs`, `matches` or custom scorers; those need
  a TypeScript suite.
- Budget scorers read what the agent reports. An agent that reports nothing gets
  `–`, not a pass.
