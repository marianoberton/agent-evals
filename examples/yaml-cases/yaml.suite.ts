import { defineSuite, scorers } from "../../src/index.js";
import { loadCases } from "../../src/yaml/loader.js";
import { echoAgent } from "../echo-agent/agent.js";

/**
 * The same suite shape, with the cases in YAML.
 *
 * `loadCases` returns ordinary `Case` objects, so nothing downstream knows or
 * cares where they came from — the report, the vitest helper and `calibrate`
 * all behave identically.
 */
export default defineSuite({
  name: "yaml-cases",
  threshold: 1,
  agent: echoAgent,
  scorers: [
    scorers.notContains(["descuento", "discount"]),
    scorers.latencyUnder(1_000),
    scorers.escalatedWhen({ intent: "price_negotiation" }),
  ],
  cases: loadCases("examples/yaml-cases/cases"),
});
