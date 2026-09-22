import { totalTokens } from "../core/normalize.js";
import { fail, pass, skip } from "../core/score.js";
import type { Outcome, Scorer } from "../core/types.js";
import type { ScorerOptions } from "./tools.js";

/**
 * Budget scorers read what the agent *reported*, never the harness wall clock.
 *
 * That is what keeps them meaningful under cassette replay: the cassette records
 * and replays the real network time and token usage of the recorded run, so a
 * replayed suite still fails on a 20-second turn — and fails identically twice.
 * An agent that reports nothing gets `–`, not a free pass.
 */
function budgetScorer(
  group: string,
  read: (o: Outcome) => number | undefined,
  limit: number,
  format: (n: number) => string,
  missing: string,
  options?: ScorerOptions,
): Scorer {
  return {
    // The id is the group: two limits on the same metric are a contradiction, so a
    // case-level limit replaces the suite-level one instead of stacking with it.
    id: options?.id ?? group,
    group,
    label: options?.id ?? group,
    kind: "deterministic",
    weight: options?.weight ?? 1,
    critical: options?.critical ?? false,
    score({ outcome }) {
      const actual = read(outcome);
      if (actual === undefined) return skip({ reason: missing });
      return actual <= limit
        ? pass({ reason: `${format(actual)} <= ${format(limit)}`, value: actual })
        : fail({ reason: `${format(actual)} > ${format(limit)}`, value: actual });
    },
  };
}

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`);
const usd = (n: number): string => `$${n.toFixed(4)}`;
const tok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const latencyUnder = (maxMs: number, options?: ScorerOptions): Scorer =>
  budgetScorer("latency", (o) => o.latencyMs, maxMs, ms, "agent did not report latency", options);

export const costUnder = (maxUsd: number, options?: ScorerOptions): Scorer =>
  budgetScorer("cost", (o) => o.costUsd, maxUsd, usd, "agent did not report cost", options);

export const tokensUnder = (maxTokens: number, options?: ScorerOptions): Scorer =>
  budgetScorer("tokens", totalTokens, maxTokens, tok, "agent did not report tokens", options);

/**
 * Model round-trips in the tool loop. The eval-side mirror of a runtime's
 * `maxTurnsWithoutProgress`: an agent that loops is a production failure even
 * when its final reply is fine.
 */
export const maxTurns = (max: number, options?: ScorerOptions): Scorer =>
  budgetScorer(
    "turns",
    (o) => o.turns,
    max,
    (n) => `${n} turn(s)`,
    "agent did not report turns",
    options,
  );
