#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { VERSION, runSuite } from "./core/run.js";
import type { Report, Suite } from "./core/types.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderTerminal } from "./report/terminal.js";

const USAGE = `agent-evals ${VERSION}

Usage:
  agent-evals run <suite...> [options]

Options:
  --threshold <n>       override the suite threshold
  --fail-under          exit 1 when the score is under the threshold
  --tag <name>          only cases with this tag (repeatable)
  --only <caseId>       only this case (repeatable)
  --concurrency <n>     cases in flight (default 4)
  --include-llm-judge   opt in to the non-deterministic judge
  --json <path>         write the JSON report (default evals/reports/<ts>.json)
  --markdown <path>     write the markdown report
  --no-report           do not write any file
  -h, --help            this
`;

/**
 * TypeScript suites need a loader. Node strips types natively from 22.18; before
 * that, tsx does it. Either way the error must name the fix, not just fail.
 */
async function ensureTsSupport(file: string): Promise<void> {
  if (!/\.(m?ts|cts)$/.test(file)) return;
  if ((process as { features?: { typescript?: unknown } }).features?.typescript) return;
  try {
    const tsx = (await import("tsx/esm/api")) as { register: () => void };
    tsx.register();
  } catch {
    // Left to the import below to fail with the real syntax error; the hint is in the catch there.
  }
}

async function loadSuite(file: string): Promise<Suite> {
  const abs = resolve(process.cwd(), file);
  await ensureTsSupport(abs);
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(abs).href)) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not load ${file}: ${message}\nIf it is a TypeScript file, install tsx (pnpm add -D tsx) or run on Node >= 22.18.`,
    );
  }
  const suite = (mod.default ?? mod.suite) as Suite | undefined;
  if (!suite || typeof suite !== "object" || !("cases" in suite)) {
    throw new Error(`${file} must default-export a suite created with defineSuite()`);
  }
  return suite;
}

function writeReport(
  report: Report,
  jsonPath: string | undefined,
  mdPath: string | undefined,
): void {
  const stamp = report.runMeta.startedAt.replace(/[:.]/g, "-");
  const json = jsonPath ?? `evals/reports/${report.suite}-${stamp}.json`;
  for (const [path, body] of [
    [json, `${JSON.stringify(report, null, 2)}\n`],
    ...(mdPath ? [[mdPath, renderMarkdown(report)] as const] : []),
  ] as const) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    writeFileSync(resolve(path), body, "utf8");
  }
  // latest.json is what `agent-evals diff` reads by default.
  const latest = resolve(dirname(resolve(json)), "latest.json");
  writeFileSync(latest, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      threshold: { type: "string" },
      "fail-under": { type: "boolean", default: false },
      tag: { type: "string", multiple: true },
      only: { type: "string", multiple: true },
      concurrency: { type: "string" },
      "include-llm-judge": { type: "boolean", default: false },
      json: { type: "string" },
      markdown: { type: "string" },
      "no-report": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...files] = positionals;
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }
  if (command !== "run") {
    process.stderr.write(`Unknown command "${command}". Only "run" exists in M0.\n\n${USAGE}`);
    return 1;
  }
  if (files.length === 0) {
    process.stderr.write(`No suite given.\n\n${USAGE}`);
    return 1;
  }

  let worst = 0;
  for (const file of files) {
    const suite = await loadSuite(file);
    const report = await runSuite(suite, {
      threshold: values.threshold === undefined ? undefined : Number(values.threshold),
      tags: values.tag,
      only: values.only,
      concurrency: values.concurrency === undefined ? undefined : Number(values.concurrency),
      includeLlmJudge: values["include-llm-judge"],
    });

    process.stdout.write(renderTerminal(report));
    if (!values["no-report"]) writeReport(report, values.json, values.markdown);
    if (!report.passed && values["fail-under"]) worst = 1;
  }
  return worst;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(pc.red(`${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  });
