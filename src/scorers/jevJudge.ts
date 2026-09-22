import { outboundText } from "../core/normalize.js";
import { fail, pass, skip } from "../core/score.js";
import type { Case, JevQuestion, Outcome, Scorer } from "../core/types.js";
import { readChoice, readNoul, readScore } from "../jev/client.js";

/**
 * The default state a judge sees.
 *
 * Deliberately free of latency, cost, tokens and trace: those change every run,
 * and sweeping them into the state would break the cassette on every run. The
 * volatility guard in the batcher enforces this for custom builders too.
 */
export function defaultState(outcome: Outcome, c: Case): Record<string, unknown> {
  return {
    history: c.history.map((m) => ({ role: m.role, text: m.text })),
    inbound: c.inbound.text,
    reply: outcome.outbound.map((m) => m.text),
    toolCalls: (outcome.toolCalls ?? []).map((t) => ({ name: t.name, args: t.args })),
    transitions: (outcome.transitions ?? []).map((t) => t.type),
  };
}

export interface JevJudgeOptions {
  /** The question. Build it with `jev.noul` / `jev.choice` / `jev.score`. */
  question: JevQuestion;
  /** What Jev looks at. Must be reproducible; defaults to `defaultState`. */
  state?: (outcome: Outcome, c: Case) => unknown;
  /** noul: pass when the probability is at least this. */
  passAbove?: number;
  /** score: pass when the level is at most this. */
  passAtMost?: number;
  /** score: pass when the level is at least this. */
  passAtLeast?: number;
  /** choice: pass when the pick is this (or one of these). */
  passIs?: string | readonly string[];
  /** choice: also require this much confidence in the pick. */
  minConfidence?: number;
  /** Report column. Defaults to `jev:<a slug of the question>`. */
  id?: string;
  label?: string;
  weight?: number;
  critical?: boolean;
  /** Skip instead of failing when the Jev call itself fails. */
  soft?: boolean;
  /** Opt out of the volatility guard. You almost never want this. */
  allowVolatileState?: boolean;
  /** Only grade cases matching this. */
  when?: (c: Case) => boolean;
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 4)
    .join("-");

/**
 * A calibrated judge you can actually gate on.
 *
 * Unlike an LLM asked to score 1-5, Jev returns a probability: `0.91` compares
 * to a threshold, a paragraph does not. It cannot return a value outside the
 * options you gave it — but it *can* return the wrong one of those, which is
 * exactly why `agent-evals calibrate` exists. Pick thresholds from a reliability
 * table, not from taste.
 */
export function jevJudge(options: JevJudgeOptions): Scorer {
  const { question } = options;
  const id = options.id ?? `jev:${slug(question.instructions)}`;
  const build = options.state ?? defaultState;

  const scorer: Scorer = {
    id,
    group: id,
    label: options.label ?? id,
    kind: "jev",
    weight: options.weight ?? 1,
    critical: options.critical ?? false,
    ...(options.when ? { when: options.when } : {}),

    plan(outcome, c) {
      return { state: build(outcome, c), questions: { q: question } };
    },

    score({ answers, planError }) {
      if (planError) {
        return options.soft
          ? skip({ reason: `jev unavailable: ${planError.message}` })
          : fail({ reason: `jev failed: ${planError.message}` });
      }
      const answer = answers?.q;
      if (!answer) return skip({ reason: "no answer returned for this question" });

      if (question.type === "noul") {
        const p = readNoul(answer);
        const threshold = options.passAbove ?? 0.5;
        return (p >= threshold ? pass : fail)({
          reason: `${p.toFixed(2)} ${p >= threshold ? ">=" : "<"} ${threshold}`,
          probability: p,
          value: p,
        });
      }

      if (question.type === "score") {
        const { score: level, confidence, probabilities } = readScore(answer);
        const atMost = options.passAtMost;
        const atLeast = options.passAtLeast;
        const ok =
          (atMost === undefined || level <= atMost) && (atLeast === undefined || level >= atLeast);
        const bound =
          atMost !== undefined && atLeast !== undefined
            ? `${atLeast}..${atMost}`
            : atMost !== undefined
              ? `<= ${atMost}`
              : atLeast !== undefined
                ? `>= ${atLeast}`
                : "(no bound set)";
        return (ok ? pass : fail)({
          reason: `${level.toFixed(2)} ${ok ? "within" : "outside"} ${bound}`,
          probability: level,
          value: level,
          confidence,
          ...(probabilities ? { probabilities } : {}),
        });
      }

      const { choice: picked, confidence, probabilities } = readChoice(answer);
      const wanted = options.passIs;
      const allowed =
        wanted === undefined ? [] : Array.isArray(wanted) ? [...wanted] : [wanted as string];
      const matches = allowed.length === 0 || allowed.includes(picked);
      const confident = options.minConfidence === undefined || confidence >= options.minConfidence;
      const ok = matches && confident;
      const why = !matches
        ? `picked "${picked}", expected ${allowed.join(" | ")}`
        : !confident
          ? `picked "${picked}" but only ${confidence.toFixed(2)} confident (need ${options.minConfidence})`
          : `picked "${picked}" (${confidence.toFixed(2)})`;
      return (ok ? pass : fail)({
        reason: why,
        probability: confidence,
        value: picked,
        confidence,
        ...(probabilities ? { probabilities } : {}),
      });
    },
  };

  if (options.allowVolatileState) {
    (scorer as { allowVolatileState?: boolean }).allowVolatileState = true;
  }
  return scorer;
}
