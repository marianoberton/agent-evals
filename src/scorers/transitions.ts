import { didTransition, transitionReason } from "../core/normalize.js";
import { fail, pass, skip } from "../core/score.js";
import type { Case, Scorer, TransitionType } from "../core/types.js";
import type { ScorerOptions } from "./tools.js";

const NO_TRANSITION_REPORT = "agent did not report transitions";

export interface TransitionOptions extends ScorerOptions {
  /** `false` asserts the transition did NOT happen. Defaults to `true`. */
  expected?: boolean;
  /** When set, the transition's reason must equal this. */
  reason?: string;
}

function transitionScorer(type: TransitionType, options?: TransitionOptions): Scorer {
  const expected = options?.expected ?? true;
  return {
    // Same id for both polarities, so a case's `expect.escalated: false`
    // overrides a suite-level `escalated()` instead of contradicting it.
    id: options?.id ?? type,
    group: type,
    label: options?.id ?? type,
    kind: "deterministic",
    weight: options?.weight ?? 1,
    critical: options?.critical ?? false,
    score({ outcome }) {
      const happened = didTransition(outcome, type);
      if (happened === null) return skip({ reason: NO_TRANSITION_REPORT });
      if (happened !== expected) {
        return fail({
          reason: expected ? `expected ${type}, did not` : `${type} but must not`,
          value: String(happened),
        });
      }
      if (expected && options?.reason !== undefined) {
        const actual = transitionReason(outcome, type);
        return actual === options.reason
          ? pass({ reason: `${type} (${actual})`, value: actual })
          : fail({
              reason: `${type} reason "${actual ?? "none"}", expected "${options.reason}"`,
              value: actual ?? "none",
            });
      }
      const actual = expected ? transitionReason(outcome, type) : undefined;
      return pass({
        reason: expected ? `${type}${actual ? ` (${actual})` : ""}` : `did not ${type}`,
        value: actual,
      });
    },
  };
}

export const escalated = (options?: TransitionOptions): Scorer =>
  transitionScorer("escalated", options);

export const blocked = (options?: TransitionOptions): Scorer =>
  transitionScorer("blocked", options);

export const handoff = (options?: TransitionOptions): Scorer =>
  transitionScorer("handoff", options);

export interface EscalatedWhenOptions extends ScorerOptions {
  /** Matches `case.meta.intent`, or a tag with the same name. */
  intent?: string;
  /** Matches any `case.meta` key. */
  meta?: Record<string, unknown>;
  /** Matches a tag on the case. */
  tag?: string;
}

/**
 * "Cases of this kind must escalate."
 *
 * The condition reads the case's declared ground truth (`meta` / `tags`), never
 * the agent's own classifier output: an eval that trusts the agent's label to
 * decide what the agent should have done is grading itself. Cases that do not
 * match render `–`, which is exactly how the report table in the README gets its
 * empty cells.
 */
export function escalatedWhen(options: EscalatedWhenOptions): Scorer {
  const inner = transitionScorer("escalated", { ...options, id: "escalatedWhen" });
  const target = options.intent ?? options.tag;

  const matches = (c: Case): boolean => {
    if (options.intent !== undefined) {
      if (c.meta.intent === options.intent || c.tags.includes(options.intent)) return true;
      return false;
    }
    if (options.tag !== undefined) return c.tags.includes(options.tag);
    if (options.meta !== undefined) {
      return Object.entries(options.meta).every(([k, v]) => c.meta[k] === v);
    }
    return true;
  };

  return {
    ...inner,
    id: options.id ?? (target ? `escalatedWhen:${target}` : "escalatedWhen"),
    group: "escalatedWhen",
    label: options.id ?? "escalatedWhen",
    when: matches,
    score: inner.score,
  };
}
