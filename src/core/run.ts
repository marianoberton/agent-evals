import { type Cassette, CassetteStore } from "../cassette/store.js";
import { resolveJevBatch } from "../jev/batch.js";
import { JevClient } from "../jev/client.js";
import { scorersFor } from "./expect.js";
import { hash32, normalizeOutcome } from "./normalize.js";
import { caseScore, errored, meetsThreshold, suiteScore, toEntry } from "./score.js";
import type {
  Case,
  CaseReport,
  JevAnswer,
  JevPlan,
  Outcome,
  Report,
  RunOptions,
  Score,
  ScoreEntry,
  Scorer,
  ScorerSummary,
  Suite,
} from "./types.js";

export const VERSION = "0.1.0-dev";

export class AgentTimeoutError extends Error {
  override name = "AgentTimeoutError";
  constructor(ms: number) {
    super(`agent did not finish within ${ms}ms`);
  }
}

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

const isThenable = (v: unknown): v is Promise<Score> =>
  typeof (v as { then?: unknown })?.then === "function";

/** `only` flags win over everything, as in vitest; then explicit ids, then tags. */
export function selectCases(cases: readonly Case[], opts: RunOptions): Case[] {
  const focused = cases.filter((c) => c.only);
  let out = focused.length > 0 ? focused : cases.filter((c) => !c.skip);
  if (opts.only?.length) {
    const wanted = new Set<string>(opts.only);
    out = out.filter((c) => wanted.has(c.id));
  }
  if (opts.tags?.length) {
    const wanted = new Set(opts.tags);
    out = out.filter((c) => c.tags.some((t) => wanted.has(t)));
  }
  return out;
}

/** Bounded concurrency that writes into a pre-sized array, so order never depends on timing. */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
}

interface RunContext {
  jev: JevClient;
  store: CassetteStore;
}

async function runCase(
  suite: Suite,
  kase: Case,
  opts: RunOptions,
  threshold: number,
  ctx: RunContext,
): Promise<CaseReport> {
  const startedAt = performance.now();
  opts.events?.onCaseStart?.(kase);
  const cassette: Cassette = ctx.store.openCase(kase.id);

  const active = scorersFor(suite, kase).filter(
    (s) => s.kind !== "llm" || opts.includeLlmJudge === true,
  );

  const timeoutMs = kase.timeoutMs ?? suite.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AgentTimeoutError(timeoutMs)), timeoutMs);
  const onOuterAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let outcome: Outcome | undefined;
  let agentError: Error | undefined;
  const wallStart = performance.now();
  try {
    outcome = normalizeOutcome(
      await suite.agent({
        suite: suite.name,
        caseId: kase.id,
        history: kase.history,
        inbound: kase.inbound,
        tags: kase.tags,
        meta: kase.meta,
        fetch: cassette.fetch,
        signal: controller.signal,
        seed: hash32(`${suite.name}/${kase.id}`),
      }),
    );
  } catch (err) {
    agentError = controller.signal.aborted
      ? asError(controller.signal.reason ?? err)
      : asError(err);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }

  // A crashing agent scores 0 with a full row of ✗ — loudly worse than a wrong one,
  // never a hole in the table.
  if (!outcome || agentError) {
    cassette.close(false); // a crash must never leave half a tape behind
    const err = agentError ?? new Error("agent returned nothing");
    const scores: ScoreEntry[] = active.map((s) =>
      toEntry(s, errored(`agent error: ${err.message}`, err.message, s.weight)),
    );
    const report: CaseReport = {
      id: kase.id,
      name: kase.name,
      tags: kase.tags,
      status: "error",
      score: 0,
      weight: kase.weight,
      scores,
      error: { message: err.message, stack: err.stack },
      durationMs: performance.now() - startedAt,
    };
    opts.events?.onCaseEnd?.(report);
    return report;
  }

  // The harness fills only what the agent did not report — and it fills it from
  // the cassette, not from the wall clock. On replay those are the numbers of the
  // recorded run, which is what keeps `latencyUnder` both meaningful and
  // byte-identical across two runs of the same suite.
  const localMs = Math.round(performance.now() - wallStart);
  const replayed = cassette.hits > 0 || cassette.misses > 0;
  const enriched: Outcome = {
    ...outcome,
    latencyMs: outcome.latencyMs ?? (replayed ? Math.round(cassette.replayedMs) : localMs),
    ...(outcome.costUsd === undefined && cassette.costUsd > 0 ? { costUsd: cassette.costUsd } : {}),
    ...(outcome.tokens === undefined && cassette.tokens.inputTokens > 0
      ? { tokens: cassette.tokens }
      : {}),
  };

  // Phase 2 — plan. Pure and sync: scorers declare Jev questions, nobody calls out.
  const plans = new Map<string, JevPlan>();
  const planErrors = new Map<string, Error>();
  const allowVolatile = new Set<string>();
  for (const scorer of active) {
    if (!scorer.plan) continue;
    if ((scorer as { allowVolatileState?: boolean }).allowVolatileState)
      allowVolatile.add(scorer.id);
    try {
      const plan = scorer.plan(enriched, kase);
      if (plan) plans.set(scorer.id, plan);
    } catch (e) {
      planErrors.set(scorer.id, asError(e));
    }
  }

  // Phase 3 — resolve. One Jev request per distinct state, through the cassette.
  const answers: Map<string, Record<string, JevAnswer>> = await resolveJevBatch(
    plans,
    ctx.jev,
    cassette.fetch,
    planErrors,
    { allowVolatile },
  );

  const ctxBase = {
    outcome: enriched,
    case: kase,
    suite: { name: suite.name, threshold },
  };

  const entries: ScoreEntry[] = new Array(active.length);
  const pending: Promise<void>[] = [];

  active.forEach((scorer: Scorer, index: number) => {
    try {
      const scorerAnswers = answers.get(scorer.id);
      const scorerError = planErrors.get(scorer.id);
      const result = scorer.score({
        ...ctxBase,
        ...(scorerAnswers ? { answers: scorerAnswers } : {}),
        ...(scorerError ? { planError: scorerError } : {}),
      });
      if (isThenable(result)) {
        if (scorer.kind === "deterministic") {
          throw new Error(
            `Scorer "${scorer.id}" is declared deterministic but returned a Promise. Deterministic scorers must be pure and synchronous.`,
          );
        }
        pending.push(
          result.then(
            (s) => {
              entries[index] = toEntry(scorer, s);
            },
            (e: unknown) => {
              const err = asError(e);
              entries[index] = toEntry(
                scorer,
                errored(`scorer threw: ${err.message}`, err.message, scorer.weight),
              );
            },
          ),
        );
      } else {
        entries[index] = toEntry(scorer, result);
      }
    } catch (e) {
      const err = asError(e);
      entries[index] = toEntry(
        scorer,
        errored(`scorer threw: ${err.message}`, err.message, scorer.weight),
      );
    }
  });

  await Promise.all(pending);
  cassette.close(true);

  const report: CaseReport = {
    id: kase.id,
    name: kase.name,
    tags: kase.tags,
    status: "ok",
    score: caseScore(entries),
    weight: kase.weight,
    scores: entries,
    outcome: enriched,
    durationMs: performance.now() - startedAt,
  };
  opts.events?.onCaseEnd?.(report);
  return report;
}

function summarize(cases: readonly CaseReport[]): ScorerSummary[] {
  const acc = new Map<
    string,
    { s: ScorerSummary; passed: number; failed: number; skipped: number }
  >();
  const order: string[] = [];
  for (const c of cases) {
    for (const e of c.scores) {
      let row = acc.get(e.group);
      if (!row) {
        row = {
          s: {
            group: e.group,
            label: e.label,
            kind: e.kind,
            passed: 0,
            failed: 0,
            skipped: 0,
            rate: null,
          },
          passed: 0,
          failed: 0,
          skipped: 0,
        };
        acc.set(e.group, row);
        order.push(e.group);
      }
      if (e.pass === null) row.skipped++;
      else if (e.pass) row.passed++;
      else row.failed++;
    }
  }
  return order.map((id) => {
    const row = acc.get(id) as NonNullable<ReturnType<typeof acc.get>>;
    const graded = row.passed + row.failed;
    return {
      ...row.s,
      passed: row.passed,
      failed: row.failed,
      skipped: row.skipped,
      rate: graded === 0 ? null : Math.round((row.passed / graded) * 1e6) / 1e6,
    };
  });
}

export async function runSuite<Ids extends string>(
  suite: Suite<Ids>,
  options: RunOptions<Ids> = {},
): Promise<Report> {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const threshold = options.threshold ?? suite.threshold;
  const selected = selectCases(suite.cases, options as RunOptions);

  const ctx: RunContext = {
    jev: new JevClient({ ...suite.jev, ...options.jev }),
    store: new CassetteStore(
      suite.name,
      { ...suite.cassettes, ...options.cassettes },
      options.fetch ?? globalThis.fetch,
    ),
  };

  // Pre-sized by declaration index: the report is identical at any concurrency.
  const reports = new Array<CaseReport>(selected.length);
  await mapWithConcurrency(
    selected,
    options.concurrency ?? suite.concurrency ?? 4,
    async (kase, i) => {
      reports[i] = await runCase(suite as Suite, kase, options as RunOptions, threshold, ctx);
    },
  );

  const cases = reports.filter(Boolean);
  const score = suiteScore(cases);

  return {
    version: 1,
    suite: suite.name,
    threshold,
    score,
    passed: meetsThreshold(score, threshold, cases),
    cases,
    scorers: summarize(cases),
    usage: {
      ...(ctx.jev.usage.requests > 0
        ? {
            jev: {
              requests: ctx.jev.usage.requests,
              inputTokens: ctx.jev.usage.inputTokens,
              outputTokens: ctx.jev.usage.outputTokens,
              costUsd: ctx.jev.costUsd,
            },
          }
        : {}),
    },
    runMeta: {
      startedAt,
      durationMs: Math.round(performance.now() - t0),
      includeLlmJudge: options.includeLlmJudge === true,
      agentEvalsVersion: VERSION,
      cassetteMode: ctx.store.mode,
      cassetteHits: ctx.store.hits,
      cassetteMisses: ctx.store.misses,
    },
  };
}
