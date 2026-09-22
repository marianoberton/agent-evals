export { costUnder, latencyUnder, maxTurns, tokensUnder } from "./budget.js";
export { defaultState, jevJudge } from "./jevJudge.js";
export { schema } from "./schema.js";
export { contains, matches, notContains, replied } from "./text.js";
export { noToolCalled, toolArgs, toolCalled, toolNotCalled } from "./tools.js";
export { blocked, escalated, escalatedWhen, handoff } from "./transitions.js";

export type { ScorerOptions } from "./tools.js";
export type { TextOptions } from "./text.js";
export type { SchemaOptions } from "./schema.js";
export type { JevJudgeOptions } from "./jevJudge.js";
export type { EscalatedWhenOptions, TransitionOptions } from "./transitions.js";

import * as budget from "./budget.js";
import * as jev from "./jevJudge.js";
import * as schemaScorer from "./schema.js";
import * as text from "./text.js";
import * as tools from "./tools.js";
import * as transitions from "./transitions.js";

/** The namespace the README uses: `scorers.toolCalled("lookupStock")`. */
export const scorers = {
  ...tools,
  jevJudge: jev.jevJudge,
  ...transitions,
  ...text,
  ...budget,
  ...schemaScorer,
} as const;
