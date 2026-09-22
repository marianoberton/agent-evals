# Cassettes

**A suite with cassettes present produces the same report twice. Otherwise it is a bug** — and `tests/determinism.test.ts` says so out loud, by running each suite twice and comparing.

A cassette is a recording of every HTTP call a case made. The first run records; every run after replays. No network, no spend, no flake.

## Using them

Nothing to configure. Pass the `fetch` you were given to whatever makes the model call:

```ts
agent: async ({ history, inbound, fetch }) => {
  const reply = await myProvider.complete({ history, inbound, fetch }); // ← that fetch
  return { outbound: reply.text };
}
```

That `fetch` is the cassette. `jevJudge` is already wired through it.

If your provider does not accept an injected `fetch`, that is the one change you need on its side — the cassette cannot intercept a hard-coded global.

## Modes

| Mode | Hit | Miss |
|---|---|---|
| `auto` *(local default)* | replay | record if there is no tape for the case; **throw** if there is one |
| `replay` *(CI default)* | replay | throw `CassetteMissError` naming the record command |
| `record` | replay | call through and append |
| `rerecord` | ignored | call through, tape rewritten |
| `passthrough` | ignored | call through, nothing written |

Two choices worth knowing about:

**CI is forced to `replay`** whenever `process.env.CI` is set. CI must never spend money, and a half-filled tape silently reaching the network is exactly what breaks "the same report twice" on the machine where it matters most.

**`auto` throws rather than top up.** If a tape exists but is missing one interaction, the prompt changed — you want to know that, not to quietly record the difference and end up with a tape nobody can reproduce.

```bash
agent-evals run evals/*.suite.ts                    # auto locally, replay in CI
agent-evals record evals/dealership.suite.ts        # rerecord everything
agent-evals run --cassettes passthrough             # ignore tapes entirely
```

## What is hashed

```ts
sha256({ method, url, body })   // keys sorted; arrays keep their order
```

Headers never go in, so rotating your key does not invalidate anything. The **URL** does, so switching gateway re-records on purpose: a different provider is a different recording.

Changing a prompt, a question's wording, the model, or the state **invalidates on purpose**. That is the feature. An eval that kept replaying an old answer after you changed the question would be lying to you.

Arrays keep their order because a `score` question's `criteria` is an ordered scale — reordering it is a different question, not the same one.

## The file

`evals/__cassettes__/<suite>/<case>.json`, one file per case, committed to git:

```json
{
  "version": 1,
  "suite": "dealership-sales",
  "case": "price-negotiation-escalates",
  "interactions": [
    {
      "seq": 0,
      "key": "sha256:9f2c1a…",
      "request":  { "method": "POST", "url": "https://openrouter.ai/api/alpha/decisions", "body": {} },
      "response": { "status": 200, "headers": { "content-type": "application/json" }, "body": {} },
      "timing":   { "durationMs": 1840 },
      "usage":    { "inputTokens": 1204, "outputTokens": 88, "costUsd": 0.0041 }
    }
  ]
}
```

Several calls in one case are several interactions. Repeated *identical* calls replay in recorded order, so an agent that calls the same tool twice with the same arguments gets the first response first.

Case ids become filenames through a slug that appends a short hash whenever it had to change the id — so `¿Corolla?` and `Corolla` cannot collide, and no tape is ever named `con.json`, which Windows will not create.

Written to `<file>.tmp` and renamed, so a crash mid-write cannot leave a corrupt tape. A case whose agent threw discards its tape entirely: half a recording is worse than none.

## Why `timing` and `usage` are recorded

This is the part that is easy to get wrong.

If `latencyUnder` measured the wall clock, two runs would differ and the determinism promise would die. Worse, once the network is replayed, wall time is near zero — the scorer would pass everything and catch nothing.

So the cassette records the **real** duration, tokens and cost of the recorded call and replays them. A replayed suite still fails the 20-second turn, and fails it identically every time. The harness only falls back to its own stopwatch when a case made no recorded calls at all.

## Secrets

Before anything is written: `authorization`, `x-api-key`, `cookie` and friends are replaced with `[redacted]`, and bodies are scrubbed for `sk-…` and `Bearer …` patterns.

Still read a new tape before committing it. Redaction catches the shapes it knows; your own fixtures are your responsibility. Cassettes are committed on purpose — they are what makes the suite reproducible for everyone else — so treat them like any other file that goes public.

## When a run misses

```
No recording for https://openrouter.ai/api/alpha/decisions
  key:  sha256:9f2c1a…
  file: evals/__cassettes__/dealership-sales/price-negotiation-escalates.json
  Run: agent-evals record dealership-sales
```

Usually this means a prompt or a question changed, which is working as intended. Re-record, read the diff, commit it.
