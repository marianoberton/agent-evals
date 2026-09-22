import type { AgentInput, OutcomeInput, ToolCall, Transition } from "../../src/index.js";

/**
 * Adapting a real runtime to the eval contract.
 *
 * This file is the answer to "how do I plug my agent in?", written against a
 * runtime that does **not** already have this shape — which is the normal case.
 *
 * [guarded-agent](https://github.com/marianoberton/guarded-agent)'s entry point is
 * `runTurn(state, inbound, deps) => Promise<TurnResult>`, and a `TurnResult` is
 * `{ state, actions, trace }` — not a single field in common with `Outcome`. So
 * the mapping lives here, on the caller's side, and agent-evals stays free of any
 * knowledge about it.
 *
 * The types below are structural copies of guarded-agent's, so this example
 * compiles without depending on that package. A real integration would import
 * them, or better, guarded-agent would export its own `toOutcome`.
 */

/* ── the shape the runtime speaks ─────────────────────────────────────── */

type ConversationStatus = "agent" | "handoff_requested" | "human" | "awaiting_reopen" | "paused";

interface RuntimeMessage {
  role: "user" | "assistant" | "human";
  text: string;
  /** Required there, absent from an eval case: the adapter has to invent it. */
  at: number;
}

interface ConversationState {
  id: string;
  status: ConversationStatus;
  messages: RuntimeMessage[];
  lastCustomerMessageAt: number | null;
  turnsWithoutProgress: number;
}

type Action =
  | { type: "send"; text: string }
  | { type: "sendTemplate"; template: string; pendingText: string; reason: string }
  | { type: "setStatus"; status: ConversationStatus; reason: string };

interface TraceEntry {
  /** `"preCheck"`, `"classify"`, `"respond"`, `"tool:lookupStock"`, `"policy:veto"`, `"send"` */
  step: string;
  by: "code" | "jev" | "llm";
  /** `"ok"`, `"skipped:paused"`, `"allow"`, `"block"`, `"escalate"`, `"error"` */
  outcome: string;
  detail?: Record<string, unknown>;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number;
}

export interface TurnResult {
  state: ConversationState;
  actions: Action[];
  trace: TraceEntry[];
}

export type RunTurn<D> = (
  state: ConversationState,
  inbound: { conversationId: string; text: string; at: number },
  deps: D,
) => Promise<TurnResult>;

/* ── case → runtime ───────────────────────────────────────────────────── */

/**
 * A case has no timestamps, and the runtime requires one on every message. They
 * come from a fixed clock rather than `Date.now()`: a real clock would change
 * the request every run and miss the cassette every run.
 */
const EPOCH = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;

export function stateFrom(input: AgentInput): ConversationState {
  const messages: RuntimeMessage[] = input.history.map((m, i) => ({
    role: m.role === "system" || m.role === "tool" ? "assistant" : m.role,
    text: m.text,
    at: EPOCH + i * MINUTE,
  }));
  const lastCustomer = [...messages].reverse().find((m) => m.role === "user");
  return {
    id: input.caseId,
    status: "agent",
    messages,
    lastCustomerMessageAt: lastCustomer?.at ?? null,
    turnsWithoutProgress: 0,
  };
}

export const inboundFrom = (input: AgentInput) => ({
  conversationId: input.caseId,
  text: input.inbound.text,
  at: EPOCH + input.history.length * MINUTE,
});

/* ── runtime → Outcome ────────────────────────────────────────────────── */

const TOOL_STEP = /^tool:(.+)$/;

/** A status the runtime sets maps onto the transition an eval asserts. */
function transitionFor(status: ConversationStatus, reason: string): Transition | undefined {
  switch (status) {
    case "handoff_requested":
      return { type: "handoff", reason };
    case "human":
      return { type: "escalated", reason };
    case "paused":
    case "awaiting_reopen":
      return { type: "blocked", reason };
    default:
      return undefined;
  }
}

/**
 * Folds a `TurnResult` into an `Outcome`.
 *
 * Every field is derived, nothing is invented. Where the runtime does not report
 * something, the field is left **absent** rather than defaulted — that is what
 * makes a scorer skip instead of silently passing or failing the agent for
 * something it never measured.
 */
export function toOutcome(result: TurnResult): OutcomeInput {
  const outbound = result.actions.flatMap((a) =>
    a.type === "send"
      ? [a.text]
      : a.type === "sendTemplate"
        ? // The window shut; the template went out and the written reply travelled with it.
          [a.pendingText]
        : [],
  );

  const toolCalls: Omit<ToolCall, "seq">[] = [];
  const transitions: Transition[] = [];
  let turns = 0;
  let latencyMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let sawUsage = false;
  let sawCost = false;

  for (const entry of result.trace) {
    latencyMs += entry.latencyMs;
    if (entry.usage) {
      sawUsage = true;
      inputTokens += entry.usage.inputTokens ?? 0;
      outputTokens += entry.usage.outputTokens ?? 0;
    }
    if (typeof entry.costUsd === "number") {
      sawCost = true;
      costUsd += entry.costUsd;
    }

    if (entry.step === "respond") turns += 1;

    const tool = TOOL_STEP.exec(entry.step);
    if (tool?.[1]) {
      const args = entry.detail?.args;
      toolCalls.push({
        name: tool[1],
        args: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
        ok: entry.outcome !== "error" && entry.outcome !== "block",
        ...(entry.outcome === "block" ||
        entry.outcome === "allow" ||
        entry.outcome === "escalate" ||
        entry.outcome === "rewrite"
          ? { verdict: entry.outcome as ToolCall["verdict"] }
          : {}),
        latencyMs: entry.latencyMs,
      });
    }

    // A pre-check that ended the turn without calling a model.
    if (entry.outcome.startsWith("skipped:")) {
      transitions.push({ type: "skipped", reason: entry.outcome.slice("skipped:".length) });
    }
  }

  for (const action of result.actions) {
    if (action.type !== "setStatus") continue;
    const transition = transitionFor(action.status, action.reason);
    if (transition) transitions.push(transition);
  }

  return {
    outbound,
    toolCalls,
    transitions,
    turns,
    latencyMs,
    ...(sawUsage ? { tokens: { inputTokens, outputTokens } } : {}),
    ...(sawCost ? { costUsd } : {}),
    trace: result.trace,
  };
}

/** The one-liner a suite actually writes. */
export const asAgent =
  <D>(runTurn: RunTurn<D>, deps: D) =>
  async (input: AgentInput): Promise<OutcomeInput> =>
    toOutcome(await runTurn(stateFrom(input), inboundFrom(input), deps));
