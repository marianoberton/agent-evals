import { describe, expect, it } from "vitest";
import { scorersFor } from "../core/expect.js";
import { runSuite } from "../core/run.js";
import type { Report, RunOptions, Suite } from "../core/types.js";

/**
 * Turns a suite into ordinary vitest tests: one `it` per case, inside a
 * `describe` named after the suite.
 *
 * "Evals are tests" becomes literal — same runner, same watch mode, same
 * reporter, same CI job. The failure message is the scorer's own `reason`, so a
 * red eval reads like any other failed assertion instead of pointing you at a
 * separate report you then have to go and open.
 *
 * ```ts
 * import { defineEvals } from "agent-evals/vitest";
 * import suite from "./dealership.suite.js";
 *
 * defineEvals(suite);
 * ```
 */
export function defineEvals<Ids extends string>(
  suite: Suite<Ids>,
  options: RunOptions<Ids> & { gate?: boolean } = {},
): void {
  // The suite runs once, in a shared promise: running it per `it` would call the
  // agent N times and make the cases interfere through the cassette cursors.
  let started: Promise<Report> | undefined;
  const report = (): Promise<Report> => {
    started ??= runSuite(suite, options);
    return started;
  };

  describe(suite.name, () => {
    for (const kase of suite.cases) {
      const run = kase.skip ? it.skip : kase.only ? it.only : it;
      const scorerCount = scorersFor(suite as Suite, kase).length;
      const title = kase.name ? `${kase.id} — ${kase.name}` : kase.id;

      run(title, async () => {
        const result = await report();
        const entry = result.cases.find((c) => c.id === kase.id);

        // A filtered-out case is not a failure; it simply did not run.
        if (!entry) return;

        if (entry.status === "error") {
          throw new Error(`agent threw: ${entry.error?.message ?? "unknown error"}`);
        }

        const failures = entry.scores.filter((s) => s.pass === false);
        if (failures.length > 0) {
          const detail = failures.map((s) => `  ✗ ${s.label}: ${s.reason}`).join("\n");
          const reply = entry.outcome?.outbound
            .map((m) => m.text)
            .join("\n")
            .trim();
          throw new Error(
            `${failures.length} of ${entry.scores.length} expectation(s) failed:\n${detail}\n` +
              `  reply: ${reply ? JSON.stringify(reply.slice(0, 280)) : "(none)"}`,
          );
        }

        // Every scorer skipping means the case asserted nothing, which is a bug
        // in the case rather than a pass.
        if (scorerCount > 0 && entry.score === null) {
          const why = entry.scores.map((s) => `  – ${s.label}: ${s.reason}`).join("\n");
          throw new Error(`every scorer skipped, so this case asserted nothing:\n${why}`);
        }
        expect(entry.score).not.toBeNull();
      });
    }

    // The threshold is a property of the suite, not of any one case, so it gets
    // its own test rather than being smeared across the others.
    if (options.gate !== false) {
      it(`scores at or above ${(options.threshold ?? suite.threshold).toFixed(2)}`, async () => {
        const result = await report();
        expect(
          result.passed,
          `suite scored ${result.score?.toFixed(2) ?? "–"}, threshold ${result.threshold}`,
        ).toBe(true);
      });
    }
  });
}
