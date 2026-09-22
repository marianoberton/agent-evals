import type { JevQuestion } from "../core/types.js";

/**
 * Builders for the three Jev primitives.
 *
 * The shapes mirror the wire format exactly, so the client is a pass-through and
 * there is no translation layer to drift.
 */

/**
 * A yes/no question. The answer is a single number: the probability that the
 * answer is yes. Near 1 is a strong yes, near 0 a strong no, 0.5 is uncertain.
 * There is no separate confidence — the probability *is* the confidence.
 */
export function noul(
  instructions: string,
  criteria?: { true: string; false: string },
): JevQuestion {
  return criteria ? { type: "noul", instructions, criteria } : { type: "noul", instructions };
}

/**
 * Pick one of the named options. The answer carries the pick, the full
 * distribution, and a confidence summarising how peaked that distribution is.
 *
 * `criteria` maps each option key to a description of what it means. The model
 * can only return a key you listed.
 */
export function choice(instructions: string, criteria: Record<string, string>): JevQuestion {
  return { type: "choice", instructions, criteria };
}

/**
 * Place the state on an ordered scale. `criteria` is an **ordered array** of
 * level descriptions, and the returned `score` is a weighted average that may
 * land between two levels — 1.4 means "mostly level 1, leaning 2".
 */
export function score(instructions: string, criteria: readonly string[]): JevQuestion {
  return { type: "score", instructions, criteria };
}

/** Rough token estimate, only used to fail loudly before spending on an oversized request. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.ceil(text.length / 4);
}

/** Jev's budget: ~64k total, and ~32k for the state plus the longest single question. */
export const TOKEN_BUDGET = { total: 64_000, statePlusLongest: 32_000 } as const;

export class JevBudgetError extends Error {
  override name = "JevBudgetError";
}

export function assertTokenBudget(
  state: unknown,
  questions: Readonly<Record<string, JevQuestion>>,
): void {
  const stateTokens = estimateTokens(state);
  let total = stateTokens;
  let longest = 0;
  let longestKey = "";
  for (const [key, q] of Object.entries(questions)) {
    const n = estimateTokens(q);
    total += n;
    if (n > longest) {
      longest = n;
      longestKey = key;
    }
  }
  if (stateTokens + longest > TOKEN_BUDGET.statePlusLongest) {
    throw new JevBudgetError(
      `state (~${stateTokens} tokens) plus question "${longestKey}" (~${longest}) exceeds Jev's ` +
        `${TOKEN_BUDGET.statePlusLongest}-token limit. Trim what the scorer puts in \`state\`.`,
    );
  }
  if (total > TOKEN_BUDGET.total) {
    throw new JevBudgetError(
      `state plus ${Object.keys(questions).length} question(s) is ~${total} tokens, over Jev's ` +
        `${TOKEN_BUDGET.total}-token limit.`,
    );
  }
}
