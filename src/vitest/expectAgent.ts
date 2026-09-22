import { normalizeMessage, normalizeMessages, normalizeOutcome } from "../core/normalize.js";
import { caseScore } from "../core/score.js";
import type {
  Agent,
  AgentInput,
  ArgsSchema,
  Case,
  Message,
  MessageInput,
  Outcome,
  Score,
  Scorer,
} from "../core/types.js";
import { scorers as builtIn } from "../scorers/index.js";

/**
 * The one-liner form, for when a whole suite file is more ceremony than the
 * assertion deserves:
 *
 * ```ts
 * await expectAgent(runTurn, deps)
 *   .given(history)
 *   .receives("¿Me lo dejás en 15?")
 *   .toEscalate()
 *   .toNotCallTool("sendQuote");
 * ```
 *
 * Same scorers as a suite, same reasons in the failure message. It is a
 * convenience over `runSuite`, never a second way of deciding what passes.
 */

export class AgentExpectationError extends Error {
  override name = "AgentExpectationError";
}

interface Pending {
  scorer: Scorer;
}

const nothing = (): never => {
  throw new AgentExpectationError("expectAgent(...) needs at least one expectation");
};

class AgentExpectation implements PromiseLike<Outcome> {
  private history: Message[] = [];
  private inbound: Message = { role: "user", text: "" };
  private readonly pending: Pending[] = [];
  private caseId = "expectAgent";
  private meta: Record<string, unknown> = {};
  private tags: string[] = [];
  private timeoutMs = 30_000;
  private fetchImpl: typeof globalThis.fetch = globalThis.fetch;

  constructor(private readonly agent: Agent) {}

  /* ── the situation ──────────────────────────────────────────────────── */

  given(...history: (MessageInput | readonly MessageInput[])[]): this {
    const flat = history.flat() as MessageInput[];
    this.history = normalizeMessages(flat);
    return this;
  }

  receives(inbound: string | MessageInput): this {
    this.inbound = normalizeMessage(inbound, "user");
    return this;
  }

  /** Declared ground truth, for conditional scorers. */
  withMeta(meta: Record<string, unknown>): this {
    this.meta = meta;
    return this;
  }

  withTags(...tags: string[]): this {
    this.tags = tags;
    return this;
  }

  named(id: string): this {
    this.caseId = id;
    return this;
  }

  withTimeout(ms: number): this {
    this.timeoutMs = ms;
    return this;
  }

  /** Inject a fetch — a cassette, or a stub. */
  withFetch(fetchImpl: typeof globalThis.fetch): this {
    this.fetchImpl = fetchImpl;
    return this;
  }

  /* ── expectations ───────────────────────────────────────────────────── */

  private add(scorer: Scorer): this {
    this.pending.push({ scorer });
    return this;
  }

  toCallTool(name: string): this {
    return this.add(builtIn.toolCalled(name));
  }
  toNotCallTool(name: string): this {
    return this.add(builtIn.toolNotCalled(name));
  }
  toCallToolWith(name: string, schema: ArgsSchema): this {
    return this.add(builtIn.toolArgs(name, schema));
  }
  toCallNoTools(): this {
    return this.add(builtIn.noToolCalled());
  }

  toEscalate(reason?: string): this {
    return this.add(builtIn.escalated(reason === undefined ? {} : { reason }));
  }
  toNotEscalate(): this {
    return this.add(builtIn.escalated({ expected: false }));
  }
  toBlock(): this {
    return this.add(builtIn.blocked());
  }
  toHandOff(): this {
    return this.add(builtIn.handoff());
  }

  toReply(): this {
    return this.add(builtIn.replied());
  }
  toContain(...needles: string[]): this {
    return this.add(builtIn.contains(needles));
  }
  toNotContain(...needles: string[]): this {
    return this.add(builtIn.notContains(needles));
  }
  toMatch(pattern: RegExp): this {
    return this.add(builtIn.matches(pattern));
  }

  toCostUnder(usd: number): this {
    return this.add(builtIn.costUnder(usd));
  }
  toRespondUnder(ms: number): this {
    return this.add(builtIn.latencyUnder(ms));
  }
  toUseTokensUnder(n: number): this {
    return this.add(builtIn.tokensUnder(n));
  }

  /** Any scorer, including `jevJudge`. */
  toSatisfy(scorer: Scorer): this {
    return this.add(scorer);
  }

  /* ── execution ──────────────────────────────────────────────────────── */

  private toCase(): Case {
    return {
      id: this.caseId,
      history: this.history,
      inbound: this.inbound,
      expect: {},
      tags: this.tags,
      meta: this.meta,
      weight: 1,
    };
  }

  /**
   * Runs the agent and asserts. `await` triggers it, so a forgotten `await` in a
   * test is the usual failure mode — the assertion silently never runs.
   */
  async run(): Promise<Outcome> {
    if (this.pending.length === 0) nothing();

    const kase = this.toCase();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const input: AgentInput = {
      suite: "expectAgent",
      caseId: kase.id,
      history: kase.history,
      inbound: kase.inbound,
      tags: kase.tags,
      meta: kase.meta,
      fetch: this.fetchImpl,
      signal: controller.signal,
      seed: 0,
    };

    let outcome: Outcome;
    try {
      outcome = normalizeOutcome(await this.agent(input));
    } finally {
      clearTimeout(timer);
    }

    const results: { scorer: Scorer; score: Score }[] = [];
    for (const { scorer } of this.pending) {
      const ctx = { outcome, case: kase, suite: { name: "expectAgent", threshold: 1 } };
      results.push({ scorer, score: (await scorer.score(ctx)) as Score });
    }

    const failed = results.filter((r) => r.score.pass === false);
    const skipped = results.filter((r) => r.score.pass === null);

    if (failed.length > 0) {
      const lines = failed.map((r) => `  ✗ ${r.scorer.label ?? r.scorer.id}: ${r.score.reason}`);
      const reply = outcome.outbound
        .map((m) => m.text)
        .join("\n")
        .trim();
      throw new AgentExpectationError(
        [
          `Agent did not meet ${failed.length} of ${results.length} expectation(s) for "${kase.id}":`,
          ...lines,
          reply ? `  reply: ${JSON.stringify(reply.slice(0, 280))}` : "  reply: (none)",
          ...(outcome.toolCalls
            ? [`  tools: ${outcome.toolCalls.map((t) => t.name).join(", ") || "(none)"}`]
            : []),
        ].join("\n"),
      );
    }

    // A silent skip would let a whole test pass while asserting nothing.
    if (skipped.length === results.length) {
      const why = skipped
        .map((r) => `  – ${r.scorer.label ?? r.scorer.id}: ${r.score.reason}`)
        .join("\n");
      throw new AgentExpectationError(
        `Every expectation for "${kase.id}" was skipped, so this test asserted nothing:\n${why}`,
      );
    }

    return outcome;
  }

  /** `caseScore` of the expectations, for a test that wants the number. */
  async score(): Promise<number | null> {
    const kase = this.toCase();
    const outcome = normalizeOutcome(
      await this.agent({
        suite: "expectAgent",
        caseId: kase.id,
        history: kase.history,
        inbound: kase.inbound,
        tags: kase.tags,
        meta: kase.meta,
        fetch: this.fetchImpl,
        signal: new AbortController().signal,
        seed: 0,
      }),
    );
    const scores: Score[] = [];
    for (const { scorer } of this.pending) {
      scores.push(
        (await scorer.score({
          outcome,
          case: kase,
          suite: { name: "expectAgent", threshold: 1 },
        })) as Score,
      );
    }
    return caseScore(scores);
  }

  /**
   * The thenable is the API: it is what lets
   * `await expectAgent(agent).receives(x).toEscalate()` read as one sentence
   * rather than ending in a `.run()` everyone forgets. The usual hazard — an
   * object being auto-awaited somewhere surprising — is the intended behaviour
   * here, and `.run()` stays available when you want the call to be explicit.
   */
  // biome-ignore lint/suspicious/noThenProperty: deliberate; see above.
  then<R1 = Outcome, R2 = never>(
    onfulfilled?: ((value: Outcome) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

/**
 * `expectAgent(myAgent)` or `expectAgent(runTurn, deps)` — the second form curries
 * the extra arguments a real runtime takes, so the call reads the same either way.
 */
export function expectAgent(agent: Agent): AgentExpectation;
export function expectAgent<D>(
  agent: (input: AgentInput, deps: D) => ReturnType<Agent>,
  deps: D,
): AgentExpectation;
export function expectAgent(
  agent: Agent | ((input: AgentInput, deps: unknown) => ReturnType<Agent>),
  deps?: unknown,
): AgentExpectation {
  const bound: Agent =
    deps === undefined
      ? (agent as Agent)
      : (input) => (agent as (i: AgentInput, d: unknown) => ReturnType<Agent>)(input, deps);
  return new AgentExpectation(bound);
}

export type { AgentExpectation };
