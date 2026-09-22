import { normalizeMessage, normalizeMessages } from "./normalize.js";
import type { Agent, Case, Expectations, MessageInput, Scorer, Suite } from "./types.js";

export class SuiteDefinitionError extends Error {
  override name = "SuiteDefinitionError";
}

export interface CaseInput {
  id: string;
  name?: string;
  history?: readonly MessageInput[];
  inbound: string | MessageInput;
  expect?: Expectations;
  tags?: readonly string[];
  /** Declared ground truth. Conditional scorers read this, never the agent's own labels. */
  meta?: Record<string, unknown>;
  weight?: number;
  skip?: boolean;
  only?: boolean;
  timeoutMs?: number;
  source?: { file: string; line?: number };
}

/**
 * `const T` preserves the literal `id`, so `runSuite(suite, { only: ["typo"] })`
 * is a compile error rather than a silently empty run.
 */
export function defineCase<const T extends CaseInput>(input: T): Case & { readonly id: T["id"] } {
  if (!input.id) throw new SuiteDefinitionError("Case needs a non-empty id");
  return Object.freeze({
    id: input.id,
    name: input.name,
    history: Object.freeze(normalizeMessages(input.history)),
    inbound: normalizeMessage(input.inbound, "user"),
    expect: Object.freeze({ ...(input.expect ?? {}) }),
    tags: Object.freeze([...(input.tags ?? [])]),
    meta: Object.freeze({ ...(input.meta ?? {}) }),
    weight: input.weight ?? 1,
    skip: input.skip,
    only: input.only,
    timeoutMs: input.timeoutMs,
    source: input.source,
  }) as Case & { readonly id: T["id"] };
}

const isCase = (c: Case | CaseInput): c is Case =>
  typeof (c as Case).weight === "number" && Array.isArray((c as Case).tags);

export interface SuiteInput {
  name: string;
  /** Defaults to 1: a new suite should start strict and be relaxed on purpose. */
  threshold?: number;
  agent: Agent;
  /** Invariants that run on every case. Case-specific assertions belong in `expect`. */
  scorers?: readonly Scorer[];
  cases: readonly (Case | CaseInput)[];
  concurrency?: number;
  timeoutMs?: number;
}

type IdOf<T> = T extends { cases: readonly (infer C)[] }
  ? C extends { id: infer I extends string }
    ? I
    : string
  : string;

/** Validates at definition time, not at run time: a typo should never survive to a report. */
export function defineSuite<const T extends SuiteInput>(input: T): Suite<IdOf<T>> {
  if (!input.name) throw new SuiteDefinitionError("Suite needs a non-empty name");

  const threshold = input.threshold ?? 1;
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new SuiteDefinitionError(
      `Suite "${input.name}": threshold must be in [0, 1], got ${threshold}`,
    );
  }
  if (input.cases.length === 0) {
    throw new SuiteDefinitionError(`Suite "${input.name}": no cases`);
  }

  const cases = input.cases.map((c) => (isCase(c) ? c : defineCase(c as CaseInput)));

  const seenCases = new Set<string>();
  for (const c of cases) {
    if (seenCases.has(c.id)) {
      throw new SuiteDefinitionError(`Suite "${input.name}": duplicate case id "${c.id}"`);
    }
    seenCases.add(c.id);
  }

  const scorers = input.scorers ?? [];
  const seenScorers = new Set<string>();
  for (const s of scorers) {
    if (seenScorers.has(s.id)) {
      throw new SuiteDefinitionError(
        `Suite "${input.name}": duplicate scorer id "${s.id}". Pass { id } to one of them.`,
      );
    }
    seenScorers.add(s.id);
  }

  return Object.freeze({
    name: input.name,
    threshold,
    agent: input.agent,
    scorers: Object.freeze([...scorers]),
    cases: Object.freeze(cases),
    concurrency: input.concurrency,
    timeoutMs: input.timeoutMs,
  }) as Suite<IdOf<T>>;
}
