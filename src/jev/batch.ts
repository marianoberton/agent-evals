import { hashRequest } from "../cassette/hash.js";
import type { JevAnswer, JevPlan, JevQuestion } from "../core/types.js";
import type { JevClient } from "./client.js";

/**
 * Fields whose value changes between runs. A scorer that sweeps one of these
 * into its `state` re-hashes the request every run, misses the cassette every
 * run, and quietly turns the suite non-deterministic — the single biggest
 * determinism hazard in the whole design, so it is an error, not a warning.
 */
const VOLATILE = new Set([
  "latencyms",
  "durationms",
  "measuredlatency",
  "costusd",
  "tokens",
  "usage",
  "trace",
  "timestamp",
  "recordedat",
  "startedat",
  "at",
  "now",
  "seed",
  "requestid",
]);

export class NonDeterministicStateError extends Error {
  override name = "NonDeterministicStateError";
}

export function assertDeterministicState(scorerId: string, state: unknown, path = "state"): void {
  if (Array.isArray(state)) {
    state.forEach((v, i) => assertDeterministicState(scorerId, v, `${path}[${i}]`));
    return;
  }
  if (!state || typeof state !== "object") return;
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    if (VOLATILE.has(key.toLowerCase())) {
      throw new NonDeterministicStateError(
        `Scorer "${scorerId}" put ${path}.${key} into its Jev state. That value changes every run, so the cassette would never match and the suite would stop being reproducible. Drop it, or pass { allowVolatileState: true } if you really mean it.`,
      );
    }
    assertDeterministicState(scorerId, value, `${path}.${key}`);
  }
}

const SAFE_KEY = /[^a-zA-Z0-9_]/g;

interface Group {
  state: unknown;
  questions: Record<string, JevQuestion>;
  owners: Map<string, { scorerId: string; original: string }>;
}

/**
 * Turns every Jev scorer's declared plan into the fewest possible requests.
 *
 * Scorers never call Jev themselves — they *declare* questions in `plan()` and
 * read answers in `score()`. That is what lets the runner merge them: two
 * `jevJudge` scorers sharing the default state become one HTTP call with two
 * questions, which is where the 10x speed and 12x cost saving come from.
 */
export async function resolveJevBatch(
  plans: ReadonlyMap<string, JevPlan>,
  jev: JevClient,
  fetchImpl: typeof globalThis.fetch,
  planErrors: Map<string, Error>,
  options: { allowVolatile?: ReadonlySet<string> } = {},
): Promise<Map<string, Record<string, JevAnswer>>> {
  const answersByScorer = new Map<string, Record<string, JevAnswer>>();
  if (plans.size === 0) return answersByScorer;

  const groups = new Map<string, Group>();
  // Sorted, so the request body — and therefore the cassette key — is identical
  // no matter what order the scorers happened to finish planning in.
  for (const [scorerId, plan] of [...plans].sort(([a], [b]) => (a < b ? -1 : 1))) {
    try {
      if (!options.allowVolatile?.has(scorerId)) {
        assertDeterministicState(scorerId, plan.state);
      }
    } catch (err) {
      planErrors.set(scorerId, err instanceof Error ? err : new Error(String(err)));
      continue;
    }

    const groupKey = hashRequest({ method: "GROUP", url: "", body: plan.state });
    const group: Group = groups.get(groupKey) ?? {
      state: plan.state,
      questions: {},
      owners: new Map(),
    };
    for (const [key, question] of Object.entries(plan.questions)) {
      let wire = `${scorerId.replace(SAFE_KEY, "_")}__${key.replace(SAFE_KEY, "_")}`;
      while (wire in group.questions) wire += "_";
      group.questions[wire] = question;
      group.owners.set(wire, { scorerId, original: key });
    }
    groups.set(groupKey, group);
  }

  await Promise.all(
    [...groups.values()].map(async (group) => {
      const owners = [...new Set([...group.owners.values()].map((o) => o.scorerId))];
      try {
        const answers = await jev.decide(group.state, group.questions, { fetch: fetchImpl });
        for (const [wire, { scorerId, original }] of group.owners) {
          let bucket = answersByScorer.get(scorerId);
          if (!bucket) {
            bucket = {};
            answersByScorer.set(scorerId, bucket);
          }
          const answer = answers[wire];
          if (answer) bucket[original] = answer;
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Every scorer that depended on this call learns why; each decides
        // whether that is a failure or a skip.
        for (const id of owners) planErrors.set(id, error);
      }
    }),
  );

  return answersByScorer;
}
