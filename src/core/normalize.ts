import type {
  Message,
  MessageInput,
  Outcome,
  OutcomeInput,
  Role,
  ToolCall,
  TransitionType,
} from "./types.js";

/** The only place loose author input becomes canonical. Pure. */
export function normalizeMessage(input: MessageInput, fallbackRole: Role = "user"): Message {
  if (typeof input === "string") return { role: fallbackRole, text: input };
  if (input === null || typeof input !== "object") {
    throw new TypeError(`Message must be a string or an object, got ${typeof input}`);
  }
  const text = "text" in input ? input.text : input.content;
  if (typeof text !== "string") {
    throw new TypeError('Message needs a string "text" (or "content") property');
  }
  return input.meta ? { role: input.role, text, meta: input.meta } : { role: input.role, text };
}

export function normalizeMessages(
  input: readonly MessageInput[] | undefined,
  fallbackRole: Role = "user",
): Message[] {
  return (input ?? []).map((m) => normalizeMessage(m, fallbackRole));
}

/** Hardens whatever the agent returned. Never invents fields the agent omitted. */
export function normalizeOutcome(raw: OutcomeInput): Outcome {
  if (raw === null || typeof raw !== "object") {
    throw new TypeError(`Agent must return an object, got ${raw === null ? "null" : typeof raw}`);
  }
  const { outbound, toolCalls, ...rest } = raw;

  const messages: Message[] =
    outbound === undefined || outbound === null
      ? []
      : Array.isArray(outbound)
        ? (outbound as readonly MessageInput[]).map((m) => normalizeMessage(m, "assistant"))
        : [normalizeMessage(outbound as MessageInput, "assistant")];

  const calls: ToolCall[] | undefined = toolCalls?.map((t, i) => ({ ...t, seq: t.seq ?? i }));

  const out: Outcome = { ...rest, outbound: messages };
  return calls === undefined ? out : { ...out, toolCalls: calls };
}

/** What the text scorers read: every outbound message joined. */
export function outboundText(outcome: Outcome): string {
  return outcome.outbound.map((m) => m.text).join("\n");
}

/**
 * The whole "missing field" policy in one signature.
 *
 * `null` means the agent never reported transitions at all, so a scorer must
 * skip rather than claim the transition did not happen.
 */
export function didTransition(outcome: Outcome, type: TransitionType): boolean | null {
  if (outcome.transitions === undefined) return null;
  return outcome.transitions.some((t) => t.type === type);
}

export function transitionReason(outcome: Outcome, type: TransitionType): string | undefined {
  return outcome.transitions?.find((t) => t.type === type)?.reason;
}

/** `null` when the agent does not report tool calls at all. */
export function calledTool(outcome: Outcome, name: string): boolean | null {
  if (outcome.toolCalls === undefined) return null;
  return outcome.toolCalls.some((t) => t.name === name);
}

export function totalTokens(outcome: Outcome): number | undefined {
  const t = outcome.tokens;
  if (!t) return undefined;
  if (t.inputTokens === undefined && t.outputTokens === undefined) return undefined;
  return (t.inputTokens ?? 0) + (t.outputTokens ?? 0);
}

/** Deterministic 32-bit hash. Used for per-case seeds and slug disambiguation. */
export function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
