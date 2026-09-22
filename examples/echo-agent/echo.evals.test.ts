import { defineEvals } from "../../src/vitest/index.js";
import suite from "./echo.suite.js";

/**
 * The whole suite as ordinary vitest tests: one `it` per case, plus one for the
 * threshold. Same runner, same watch mode, same CI job as every other test in
 * the repo — which is the point of shipping a vitest helper at all.
 */
defineEvals(suite);
