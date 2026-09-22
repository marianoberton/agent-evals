export { defineCase, defineSuite, SuiteDefinitionError } from "./core/define.js";
export type { CaseInput, SuiteInput } from "./core/define.js";

export { scorersFor, scorersFromExpect } from "./core/expect.js";

export {
  calledTool,
  didTransition,
  hash32,
  normalizeMessage,
  normalizeMessages,
  normalizeOutcome,
  outboundText,
  totalTokens,
  transitionReason,
} from "./core/normalize.js";

export {
  caseScore,
  errored,
  fail,
  hasCriticalFailure,
  meetsThreshold,
  pass,
  skip,
  suiteScore,
  toEntry,
} from "./core/score.js";
export type { ScoreInit } from "./core/score.js";

export { AgentTimeoutError, runSuite, selectCases, VERSION } from "./core/run.js";

export { scorers } from "./scorers/index.js";
export * as scorerFactories from "./scorers/index.js";

export { renderMarkdown } from "./report/markdown.js";
export { renderTerminal } from "./report/terminal.js";
export { columnsOf, renderCell } from "./report/cells.js";

export type {
  Agent,
  AgentInput,
  ArgsSchema,
  Case,
  CaseReport,
  CaseStatus,
  Expectations,
  JevAnswer,
  JevPlan,
  JevQuestion,
  Message,
  MessageInput,
  Outcome,
  OutcomeInput,
  Report,
  Role,
  RunEvents,
  RunOptions,
  Score,
  ScoreContext,
  ScoreEntry,
  Scorer,
  ScorerKind,
  ScorerSummary,
  Suite,
  SuiteMeta,
  ToolCall,
  Transition,
  TransitionType,
  Usage,
} from "./core/types.js";
