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
export { defaultState, jevJudge } from "./scorers/jevJudge.js";
export type { JevJudgeOptions } from "./scorers/jevJudge.js";
export { llmJudge, parseVerdict } from "./scorers/llmJudge.js";
export type { LlmJudgeOptions } from "./scorers/llmJudge.js";

export { loadCases, parseCaseFile, YamlCaseError } from "./yaml/loader.js";

/** Question builders: `jev.noul(...)`, `jev.choice(...)`, `jev.score(...)`. */
export * as jev from "./jev/questions.js";
export {
  DEFAULTS as JEV_DEFAULTS,
  JevClient,
  JevError,
  readChoice,
  readNoul,
  readScore,
} from "./jev/client.js";
export type { JevClientOptions, JevUsage } from "./jev/client.js";
export { assertTokenBudget, JevBudgetError, TOKEN_BUDGET } from "./jev/questions.js";
export {
  assertDeterministicState,
  NonDeterministicStateError,
  resolveJevBatch,
} from "./jev/batch.js";

export { Cassette, CassetteMissError, CassetteStore } from "./cassette/store.js";
export type { Interaction } from "./cassette/store.js";
export { canonicalize, hashRequest, slugify } from "./cassette/hash.js";
export * as scorerFactories from "./scorers/index.js";

export { diffReports, renderDiff } from "./cli/diff.js";
export type { CaseDiff, Change, ReportDiff } from "./cli/diff.js";
export { calibrate, collectPoints, renderCalibration } from "./cli/calibrate.js";
export type { Bucket, Calibration } from "./cli/calibrate.js";

/**
 * `expectAgent` needs no test framework — it throws a plain Error — so it lives
 * at the root and works under jest or node:test too. `defineEvals` genuinely
 * needs vitest's `describe`/`it`, so it stays behind `agent-evals/vitest`.
 */
export { AgentExpectationError, expectAgent } from "./vitest/expectAgent.js";
export type { AgentExpectation } from "./vitest/expectAgent.js";

export { renderMarkdown } from "./report/markdown.js";
export { renderTerminal } from "./report/terminal.js";
export { columnsOf, renderCell } from "./report/cells.js";

export type {
  Agent,
  AgentInput,
  ArgsSchema,
  CassetteMode,
  CassetteOptions,
  Case,
  CaseReport,
  CaseStatus,
  Expectations,
  JevAnswer,
  JevOptions,
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
