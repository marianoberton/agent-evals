import { calledTool } from "../core/normalize.js";
import { fail, pass, skip } from "../core/score.js";
import type { ArgsSchema, Scorer } from "../core/types.js";

export interface ScorerOptions {
  weight?: number;
  critical?: boolean;
  id?: string;
}

const base = (o: ScorerOptions | undefined, id: string) => ({
  id: o?.id ?? id,
  kind: "deterministic" as const,
  weight: o?.weight ?? 1,
  critical: o?.critical ?? false,
});

const NO_TOOL_REPORT = "agent did not report tool calls";

/** The named tool must appear among the calls, in any position. */
export function toolCalled(name: string, options?: ScorerOptions): Scorer {
  return {
    ...base(options, `toolCalled:${name}`),
    group: "toolCalled",
    label: options?.id ?? "toolCalled",
    score({ outcome }) {
      const called = calledTool(outcome, name);
      if (called === null) return skip({ reason: NO_TOOL_REPORT, value: name });
      const names = (outcome.toolCalls ?? []).map((t) => t.name);
      return called
        ? pass({ reason: `called ${name}`, value: name })
        : fail({
            reason: `expected ${name}; called ${names.length ? names.join(", ") : "nothing"}`,
            value: name,
          });
    },
  };
}

/** The named tool must not appear. An agent that reports no tool calls is skipped, not passed. */
export function toolNotCalled(name: string, options?: ScorerOptions): Scorer {
  return {
    ...base(options, `toolNotCalled:${name}`),
    group: "toolNotCalled",
    label: options?.id ?? "toolNotCalled",
    score({ outcome }) {
      const called = calledTool(outcome, name);
      if (called === null) return skip({ reason: NO_TOOL_REPORT, value: name });
      return called
        ? fail({ reason: `${name} must not be called`, value: name })
        : pass({ reason: `${name} not called`, value: name });
    },
  };
}

/**
 * The arguments of every call to `tool` must satisfy `schema` (any object with a
 * throwing `parse`, so a zod schema drops straight in).
 */
export function toolArgs(tool: string, schema: ArgsSchema, options?: ScorerOptions): Scorer {
  return {
    ...base(options, `toolArgs:${tool}`),
    group: "toolArgs",
    label: options?.id ?? "toolArgs",
    score({ outcome }) {
      if (outcome.toolCalls === undefined) return skip({ reason: NO_TOOL_REPORT, value: tool });
      const calls = outcome.toolCalls.filter((t) => t.name === tool);
      if (calls.length === 0) return fail({ reason: `${tool} was never called`, value: tool });
      for (const call of calls) {
        try {
          schema.parse(call.args);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return fail({
            reason: `${tool}(#${call.seq}) args rejected: ${message.split("\n")[0]}`,
            value: tool,
          });
        }
      }
      return pass({ reason: `${tool} args valid (${calls.length} call(s))`, value: tool });
    },
  };
}

/** No tool at all may be called. The "it must refuse" assertion. */
export function noToolCalled(options?: ScorerOptions): Scorer {
  return {
    ...base(options, "noToolCalled"),
    score({ outcome }) {
      if (outcome.toolCalls === undefined) return skip({ reason: NO_TOOL_REPORT });
      const names = outcome.toolCalls.map((t) => t.name);
      return names.length === 0
        ? pass({ reason: "no tool called" })
        : fail({ reason: `expected no tool; called ${names.join(", ")}`, value: names.join(",") });
    },
  };
}
