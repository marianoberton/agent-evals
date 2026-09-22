import { scorers } from "../scorers/index.js";
import type { Case, Expectations, Scorer, Suite } from "./types.js";

const list = (v: string | readonly string[]): string[] =>
  Array.isArray(v) ? [...v] : [v as string];

type Desugar = (value: never, c: Case) => Scorer | readonly Scorer[];

/**
 * `expect` is not a second scoring engine — it is a table of scorer factories.
 * Every key desugars into ordinary scorers scoped to one case, so the report,
 * the YAML loader and the vitest helper all share one mechanism.
 */
const DESUGAR: { [K in keyof Required<Expectations>]: Desugar } = {
  toolCalled: ((v: string | readonly string[]) =>
    list(v).map((n) => scorers.toolCalled(n))) as Desugar,
  toolNotCalled: ((v: string | readonly string[]) =>
    list(v).map((n) => scorers.toolNotCalled(n))) as Desugar,
  toolArgs: ((v: { tool: string; schema: { parse(x: unknown): unknown } }) =>
    scorers.toolArgs(v.tool, v.schema)) as Desugar,
  escalated: ((v: boolean) => scorers.escalated({ expected: v })) as Desugar,
  blocked: ((v: boolean) => scorers.blocked({ expected: v })) as Desugar,
  handoff: ((v: boolean) => scorers.handoff({ expected: v })) as Desugar,
  contains: ((v: string | readonly string[]) => scorers.contains(v)) as Desugar,
  notContains: ((v: string | readonly string[]) => scorers.notContains(v)) as Desugar,
  matches: ((v: RegExp) => scorers.matches(v)) as Desugar,
  latencyUnder: ((v: number) => scorers.latencyUnder(v)) as Desugar,
  costUnder: ((v: number) => scorers.costUnder(v)) as Desugar,
  tokensUnder: ((v: number) => scorers.tokensUnder(v)) as Desugar,
  maxTurns: ((v: number) => scorers.maxTurns(v)) as Desugar,
  scorers: ((v: readonly Scorer[]) => v) as Desugar,
};

/** Stable key order, so two cases with the same expectations produce the same columns. */
const ORDER = Object.keys(DESUGAR) as (keyof Expectations)[];

export function scorersFromExpect(c: Case): Scorer[] {
  const out: Scorer[] = [];
  for (const key of ORDER) {
    const value = c.expect[key];
    if (value === undefined) continue;
    const produced = DESUGAR[key](value as never, c);
    out.push(...(Array.isArray(produced) ? produced : [produced as Scorer]));
  }
  return out;
}

/**
 * Suite scorers first (they are the invariants and set the column order), then
 * the case's own. A case-level scorer with the same id overrides the suite one,
 * which is how a slow case relaxes a global `latencyUnder` without a new column.
 */
export function scorersFor(suite: Suite, c: Case): Scorer[] {
  const byId = new Map<string, Scorer>();
  for (const s of suite.scorers) byId.set(s.id, s);
  for (const s of scorersFromExpect(c)) byId.set(s.id, s);
  return [...byId.values()].filter((s) => s.when?.(c) ?? true);
}
