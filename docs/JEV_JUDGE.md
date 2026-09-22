# The calibrated judge

Most agent evals end with an LLM asked to score a reply from 1 to 5. That number is slow, expensive, and different every time you ask. You cannot gate a deploy on it.

`jevJudge` asks [Jev](https://docs.typesafe.ai) instead — a System One model that takes a `state` and typed `questions` and returns **calibrated probabilities**, in about 100 ms, for cents. `0.91` compares to a threshold. A paragraph does not.

```ts
scorers: [
  jevJudge({
    id: "jev:answers",
    question: jev.noul("Does the reply answer the question without inventing stock or prices?"),
    passAbove: 0.9,
  }),
]
```

## What Jev can and cannot do

**It cannot return a value outside your schema.** Give it three options and it returns one of those three, never a fourth it made up.

**It can return the wrong one of them.** A calibrated model is not an infallible one. Never describe Jev as unable to hallucinate — the honest claim is that it cannot produce an invalid *type*, not that it cannot be wrong.

That is exactly why `agent-evals calibrate` exists: it plots the probabilities against cases whose answer you already know, and gives you a reliability table. Pick `passAbove` from that table, not from taste.

## The three question types

| Builder | Answer | Gate with |
|---|---|---|
| `jev.noul(instructions)` | one number, 0–1: the probability that the answer is yes | `passAbove` |
| `jev.choice(instructions, { key: "what it means" })` | the picked key, the full distribution, a confidence | `passIs`, `minConfidence` |
| `jev.score(instructions, ["level 0", "level 1", …])` | a position on the scale, possibly *between* two levels | `passAtMost`, `passAtLeast` |

A noul has no separate confidence, because the probability **is** the confidence. A choice sometimes comes back without one, and the client falls back to the probability of the picked option.

`score` criteria is an **ordered array**: index 0 is the bottom of the scale. `1.4` means "mostly level 1, leaning 2".

## One request per case

Scorers never call Jev. They *declare* questions in `plan()` and read answers in `score()`. The runner collects every plan for a case, groups them by identical `state`, and issues **one request per group**:

```ts
scorers: [
  jevJudge({ id: "jev:answers", question: jev.noul("…"), passAbove: 0.9 }),
  jevJudge({ id: "jev:pushy",   question: jev.score("…", […]), passAtMost: 1 }),
]
// → ONE http call with two questions, not two calls
```

Each question is scored independently against the state, so batching changes no answer — it only sends the state once instead of twice. In the reference measurements that is around 10× faster and 12× cheaper.

Question keys are namespaced on the wire (`jev_answers__q`) and mapped back before your scorer sees them, so two scorers can both use the key `q` without colliding.

## The state must be reproducible

This is the sharp edge. The cassette key is a hash of the request, so anything in the `state` that changes between runs means the cassette never matches, every run hits the network, and the suite quietly stops being deterministic.

The default builder is therefore latency-free:

```ts
{ history, inbound, reply, toolCalls: [{name, args}], transitions: [type] }
```

A guard walks any custom `state` and **throws** on `latencyMs`, `costUsd`, `tokens`, `trace`, `timestamp`, `seed` and friends, naming the path it found:

```
Scorer "jev:answers" put state.outcome.latencyMs into its Jev state. That value
changes every run, so the cassette would never match…
```

`allowVolatileState: true` opts out. You almost never want it.

## Budget

Jev takes about 64k tokens total, and about 32k for the state plus the longest single question. A long conversation history will blow that, so the client checks before spending and throws `JevBudgetError` naming the offending question.

## Options

| Option | Meaning |
|---|---|
| `question` | built with `jev.noul` / `jev.choice` / `jev.score` |
| `state` | `(outcome, case) => unknown`; defaults to the reproducible builder above |
| `passAbove` / `passAtMost` / `passAtLeast` / `passIs` / `minConfidence` | the gate |
| `soft` | skip instead of failing when the Jev call itself fails |
| `id`, `label`, `weight`, `critical`, `when` | as for any scorer |

## Where the call goes

Default is OpenRouter's Decisions endpoint, since Jev is served there as `typesafe/jev-1.13`:

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
{ "model": "typesafe/jev-1.13", "state": …, "questions": {…}, "zdr": true }
```

Override per suite or per run to point somewhere else — TypeSafe's own API (`https://api.typesafe.ai/v1/systemone`), a Vercel AI Gateway, Cloudflare:

```ts
defineSuite({ …, jev: { baseUrl: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" } })
```

`zdr: true` is on by default: it restricts routing to zero-retention providers, which matters because your customers' messages are in that `state`.

Jev bills **input tokens only** — output is free — so `report.usage.jev.costUsd` is computed from input alone.
