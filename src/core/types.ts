/**
 * agent-evals — the core contract.
 *
 * Everything an agent, a scorer and a report speak. No runtime code, no I/O.
 * Hand-written on purpose: this file is the published `.d.ts`, and zod-inferred
 * types hover unreadably for a public API. Zod lives at the boundaries only
 * (YAML loading, cassette files, Jev responses).
 */

/* ────────────────────────────── Messages ────────────────────────────── */

export type Role = "user" | "assistant" | "system" | "tool";

/** Canonical message. Case authors may write looser shapes; see `MessageInput`. */
export interface Message {
  readonly role: Role;
  readonly text: string;
  /** Channel fixtures (phone, template id, attachments). Never scored on its own. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * What a case author may write. A bare string becomes a `user` message.
 * `content` is accepted as an alias for `text` so OpenAI-shaped histories paste in.
 */
export type MessageInput =
  | string
  | { role: Role; text: string; meta?: Record<string, unknown> }
  | { role: Role; content: string; meta?: Record<string, unknown> };

/* ─────────────────────────────── Agent ──────────────────────────────── */

/**
 * Exactly what the agent under test receives.
 *
 * The contract is structural: an agent only has to read `history` and `inbound`
 * and may ignore everything else. `fetch` is the cassette injection point — pass
 * it to your provider and every model call is recorded once and replayed forever,
 * latency and cost included.
 */
export interface AgentInput {
  readonly suite: string;
  readonly caseId: string;
  readonly history: readonly Message[];
  readonly inbound: Message;
  readonly tags: readonly string[];
  readonly meta: Readonly<Record<string, unknown>>;
  /** Cassette-backed fetch. Identical to `globalThis.fetch` in passthrough mode. */
  readonly fetch: typeof globalThis.fetch;
  /** Aborted when the case times out. */
  readonly signal: AbortSignal;
  /** Stable per-case seed, for agents that sample. */
  readonly seed: number;
}

export type Agent = (input: AgentInput) => OutcomeInput | Promise<OutcomeInput>;

/* ────────────────────────────── Outcome ─────────────────────────────── */

export interface ToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly result?: unknown;
  /** `false` means the tool threw or returned an error. `undefined` means not reported. */
  readonly ok?: boolean;
  readonly error?: string;
  /** Verdict a policy layer applied to this call. */
  readonly verdict?: "allow" | "block" | "escalate" | "rewrite";
  readonly latencyMs?: number;
  /** 0-based position within the turn. Filled by the normaliser. */
  readonly seq: number;
}

export type TransitionType = "escalated" | "blocked" | "handoff" | "skipped";

export type Transition =
  | { readonly type: "escalated"; readonly reason?: string; readonly to?: string }
  | { readonly type: "blocked"; readonly reason?: string; readonly by?: string }
  | { readonly type: "handoff"; readonly reason?: string; readonly to?: string }
  /** A pre-check ended the turn without calling a model. */
  | { readonly type: "skipped"; readonly reason: string };

export interface Usage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * The normalised result of one turn.
 *
 * `outbound` is the only required field. Every other field is optional, and an
 * absent field means "this agent does not report it": scorers that need it
 * return `pass: null` (skip, rendered `–`) instead of failing the agent for
 * something it never claimed to measure.
 */
export interface Outcome {
  /** Zero or one in practice; an array because channels may split a reply. */
  readonly outbound: readonly Message[];
  readonly toolCalls?: readonly ToolCall[];
  readonly transitions?: readonly Transition[];
  /** Model round-trips in the tool loop. Feeds `maxTurns`. */
  readonly turns?: number;
  readonly latencyMs?: number;
  readonly tokens?: Usage;
  readonly costUsd?: number;
  /** Classifier outputs (`intent`, `language`). Optional evidence for conditional scorers. */
  readonly labels?: Readonly<Record<string, string | number | boolean>>;
  /** Anything else. Shown on failure, never hashed, never scored. */
  readonly trace?: unknown;
}

/** What an agent may return. Normalised to `Outcome` by the harness. */
export interface OutcomeInput extends Partial<Omit<Outcome, "outbound" | "toolCalls">> {
  outbound?: string | MessageInput | readonly MessageInput[] | null;
  toolCalls?: readonly (Omit<ToolCall, "seq"> & { seq?: number })[];
}

/* ─────────────────────────────── Score ──────────────────────────────── */

/**
 * `pass: null` means "not applicable to this case". It leaves both the numerator
 * and the denominator, and renders as `–`. The spec's own report table has `–`
 * cells, so this third state was always there; it was only missing from the type.
 */
export interface Score {
  readonly pass: boolean | null;
  readonly weight: number;
  /** Readable in a report without opening the case file. */
  readonly reason: string;
  /** Jev `noul`, or the probability of the chosen `choice`. */
  readonly probability?: number;
  /** Full distribution, for `choice` and `score` questions. */
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
  /** The observed value: `8421` (ms), `0.031` (usd), `"price_question"`. */
  readonly value?: string | number | boolean;
  /** Set when the scorer itself threw. Implies `pass: false`. */
  readonly error?: string;
}

export type ScorerKind = "deterministic" | "jev" | "llm";

export interface ScoreContext {
  readonly outcome: Outcome;
  readonly case: Case;
  readonly suite: SuiteMeta;
  /** Answers to this scorer's own planned questions, keyed as `plan()` returned them. */
  readonly answers?: Readonly<Record<string, JevAnswer>>;
  /** The batched Jev call failed. The scorer decides whether to fail or skip. */
  readonly planError?: Error;
}

export interface Scorer {
  /** Unique within a suite. e.g. `toolCalled:lookupStock`. */
  readonly id: string;
  /**
   * Report column this scorer shares with its siblings, e.g. `contains`.
   * Defaults to the part of `id` before the first `:`. Several scorers of the
   * same group in one case collapse into one cell: all must pass.
   */
  readonly group?: string;
  /** Column header. Defaults to `group`. */
  readonly label?: string;
  readonly kind: ScorerKind;
  readonly weight: number;
  /** A failure fails the suite regardless of the aggregate score. */
  readonly critical?: boolean;
  /** `false` means this scorer does not apply to this case, and the cell is `–`. */
  when?(c: Case): boolean;
  /**
   * Declare Jev questions without issuing a request; pure and sync.
   * The runner merges every scorer's plan for a case into one request.
   */
  plan?(outcome: Outcome, c: Case): JevPlan | null;
  /** Pure. Must be sync when `kind` is `"deterministic"` — enforced at run time. */
  score(ctx: ScoreContext): Score | Promise<Score>;
}

/* ──────────────────────── Jev (contract subset) ─────────────────────── */

export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  /** `criteria` is an ordered array: the index is the level. */
  | { type: "score"; instructions: string; criteria: readonly string[] };

export interface JevPlan {
  /** Must be deterministic: no timestamps, no measured latency. Guarded at run time. */
  readonly state: unknown;
  readonly questions: Readonly<Record<string, JevQuestion>>;
}

export interface JevAnswer {
  readonly type: "noul" | "choice" | "score";
  readonly noul?: number;
  readonly choice?: string;
  readonly score?: number;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly confidence?: number;
  readonly legend?: readonly string[];
}

/* ──────────────────────────── Case & Suite ──────────────────────────── */

export interface ArgsSchema {
  parse(value: unknown): unknown;
}

export interface Expectations {
  toolCalled?: string | readonly string[];
  toolNotCalled?: string | readonly string[];
  toolArgs?: { tool: string; schema: ArgsSchema };
  escalated?: boolean;
  blocked?: boolean;
  handoff?: boolean;
  contains?: string | readonly string[];
  notContains?: string | readonly string[];
  matches?: RegExp;
  latencyUnder?: number;
  costUnder?: number;
  tokensUnder?: number;
  maxTurns?: number;
  /** Escape hatch: extra scorers for this case only. */
  scorers?: readonly Scorer[];
}

export interface Case {
  readonly id: string;
  readonly name?: string;
  readonly history: readonly Message[];
  readonly inbound: Message;
  readonly expect: Readonly<Expectations>;
  readonly tags: readonly string[];
  /** Declared ground truth about the case, e.g. `{ intent: "price_negotiation" }`. */
  readonly meta: Readonly<Record<string, unknown>>;
  readonly weight: number;
  readonly skip?: boolean;
  readonly only?: boolean;
  readonly timeoutMs?: number;
  /** Provenance, for the report. Set by the YAML loader. */
  readonly source?: { file: string; line?: number };
}

export interface SuiteMeta {
  readonly name: string;
  readonly threshold: number;
}

export interface Suite<Ids extends string = string> {
  readonly name: string;
  readonly threshold: number;
  readonly agent: Agent;
  /** Invariants: these run on every case. Case-specific assertions go in `expect`. */
  readonly scorers: readonly Scorer[];
  readonly cases: readonly Case[];
  readonly concurrency?: number;
  readonly timeoutMs?: number;
  /** Phantom, carries the literal case ids so `runSuite({ only })` is typed. */
  readonly __ids?: Ids;
}

/* ─────────────────────────────── Report ─────────────────────────────── */

export type CaseStatus = "ok" | "error" | "skipped";

export interface ScoreEntry extends Score {
  readonly scorerId: string;
  readonly group: string;
  readonly label: string;
  readonly kind: ScorerKind;
  readonly critical: boolean;
}

export interface CaseReport {
  readonly id: string;
  readonly name?: string;
  readonly tags: readonly string[];
  readonly status: CaseStatus;
  /** `null` when every scorer skipped. `0` when the agent threw. */
  readonly score: number | null;
  readonly weight: number;
  readonly scores: readonly ScoreEntry[];
  readonly outcome?: Outcome;
  readonly error?: { message: string; stack?: string };
  /** Wall clock. Excluded from determinism comparisons. */
  readonly durationMs: number;
}

export interface ScorerSummary {
  readonly group: string;
  readonly label: string;
  readonly kind: ScorerKind;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly rate: number | null;
}

export interface Report {
  readonly version: 1;
  readonly suite: string;
  readonly threshold: number;
  readonly score: number | null;
  readonly passed: boolean;
  readonly cases: readonly CaseReport[];
  readonly scorers: readonly ScorerSummary[];
  /** Everything non-deterministic lives here and is excluded from `diff`. */
  readonly runMeta: {
    readonly startedAt: string;
    readonly durationMs: number;
    readonly includeLlmJudge: boolean;
    readonly agentEvalsVersion: string;
  };
}

/* ──────────────────────────── Run options ───────────────────────────── */

export interface RunEvents {
  onCaseStart?(c: Case): void;
  onCaseEnd?(r: CaseReport): void;
}

export interface RunOptions<Ids extends string = string> {
  readonly only?: readonly Ids[];
  readonly tags?: readonly string[];
  readonly concurrency?: number;
  /** Overrides the suite's threshold. */
  readonly threshold?: number;
  readonly includeLlmJudge?: boolean;
  readonly signal?: AbortSignal;
  readonly events?: RunEvents;
  /** Injected for tests and, from M1, by the cassette layer. */
  readonly fetch?: typeof globalThis.fetch;
}
