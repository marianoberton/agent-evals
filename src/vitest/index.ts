/**
 * The vitest entry point.
 *
 * `defineEvals` imports `describe`/`it` from vitest, so this subpath is only
 * importable from inside a vitest run. `expectAgent` needs no runner at all and
 * is also exported from the package root, for jest, node:test, or anywhere else.
 */
export { AgentExpectationError, expectAgent } from "./expectAgent.js";
export type { AgentExpectation } from "./expectAgent.js";
export { defineEvals } from "./defineEvals.js";
