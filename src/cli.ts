#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { calibrate, collectPoints, renderCalibration } from "./cli/calibrate.js";
import { diffReports, renderDiff } from "./cli/diff.js";
import { CliError, expandSuitePaths, loadReport, loadSuite } from "./cli/load.js";
import { VERSION, runSuite } from "./core/run.js";
import type { CassetteMode, Report, RunOptions } from "./core/types.js";
import { renderMarkdown } from "./report/markdown.js";
import { renderTerminal } from "./report/terminal.js";

const USAGE = `agent-evals ${VERSION}

  agent-evals run <suite...>          run suites and write a report
  agent-evals record <suite...>       re-record every cassette, then run
  agent-evals diff <before> <after>   compare two JSON reports
  agent-evals calibrate <suite...>    Jev probabilities vs labelled outcomes
  agent-evals validate <suite...>     load the suites and check them, run nothing

Run options
  --threshold <n>       override the suite threshold
  --fail-under          exit 1 when the score is under the threshold
  --tag <name>          only cases with this tag (repeatable)
  --only <caseId>       only this case (repeatable)
  --concurrency <n>     cases in flight (default 4)
  --include-llm-judge   opt in to the non-deterministic judge
  --cassettes <mode>    auto | replay | record | rerecord | passthrough
  --reports-dir <dir>   where JSON reports go (default evals/reports)
  --json <path>         write the JSON report here instead
  --markdown <path>     also write the markdown report here
  --no-report           write no files

Diff options
  --fail-on-regression  exit 1 when a case that passed now fails

  -h, --help            this
  -v, --version         print the version
`;

const MODES = new Set(["auto", "replay", "record", "rerecord", "passthrough"]);

const number = (value: string | undefined, flag: string): number | undefined => {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new CliError(`${flag} expects a number, got "${value}"`);
  return n;
};

interface Flags {
  threshold?: string;
  "fail-under": boolean;
  tag?: string[];
  only?: string[];
  concurrency?: string;
  "include-llm-judge": boolean;
  cassettes?: string;
  "reports-dir"?: string;
  json?: string;
  markdown?: string;
  "no-report": boolean;
  "fail-on-regression": boolean;
}

function runOptionsFrom(flags: Flags, override?: Partial<RunOptions>): RunOptions {
  if (flags.cassettes !== undefined && !MODES.has(flags.cassettes)) {
    throw new CliError(`--cassettes expects one of ${[...MODES].join(", ")}`);
  }
  return {
    threshold: number(flags.threshold, "--threshold"),
    tags: flags.tag,
    only: flags.only,
    concurrency: number(flags.concurrency, "--concurrency"),
    includeLlmJudge: flags["include-llm-judge"],
    ...(flags.cassettes ? { cassettes: { mode: flags.cassettes as CassetteMode } } : {}),
    ...override,
  };
}

function writeReport(report: Report, flags: Flags): string | undefined {
  if (flags["no-report"]) return undefined;
  const dir = flags["reports-dir"] ?? "evals/reports";
  const stamp = report.runMeta.startedAt.replace(/[:.]/g, "-");
  const jsonPath = resolve(flags.json ?? join(dir, `${report.suite}-${stamp}.json`));
  const body = `${JSON.stringify(report, null, 2)}\n`;

  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, body, "utf8");
  // `latest.json` is what `agent-evals diff` reads when you give it one argument.
  writeFileSync(join(dirname(jsonPath), "latest.json"), body, "utf8");

  if (flags.markdown) {
    const mdPath = resolve(flags.markdown);
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, renderMarkdown(report), "utf8");
  }
  return jsonPath;
}

async function cmdRun(files: string[], flags: Flags, mode?: CassetteMode): Promise<number> {
  let exitCode = 0;
  for (const file of expandSuitePaths(files)) {
    const suite = await loadSuite(file);
    const options = runOptionsFrom(flags, mode ? { cassettes: { mode } } : undefined);
    const report = await runSuite(suite, options);

    process.stdout.write(renderTerminal(report));
    const written = writeReport(report, flags);
    if (written) process.stdout.write(pc.dim(`  report: ${written}\n\n`));
    if (!report.passed && flags["fail-under"]) exitCode = 1;
  }
  return exitCode;
}

async function cmdValidate(files: string[]): Promise<number> {
  for (const file of expandSuitePaths(files)) {
    const suite = await loadSuite(file);
    const scorerCount = new Set(suite.scorers.map((s) => s.id)).size;
    const ungraded = suite.cases.filter(
      (c) => suite.scorers.length === 0 && Object.keys(c.expect).length === 0,
    );
    process.stdout.write(
      `${pc.green("✓")} ${suite.name}  ${suite.cases.length} case(s), ${scorerCount} suite scorer(s), threshold ${suite.threshold}\n`,
    );
    for (const c of ungraded) {
      process.stdout.write(
        pc.yellow(`  ! ${c.id} has no scorers and no expect — it grades nothing\n`),
      );
    }
  }
  return 0;
}

async function cmdDiff(files: string[], flags: Flags): Promise<number> {
  const [beforePath, afterPath] = files;
  if (!beforePath) throw new CliError("diff needs a report to compare against.");
  const before = loadReport(beforePath);
  const after = loadReport(
    afterPath ?? join(flags["reports-dir"] ?? "evals/reports", "latest.json"),
  );
  const diff = diffReports(before, after);
  process.stdout.write(renderDiff(diff));
  return flags["fail-on-regression"] && diff.regressions.length > 0 ? 1 : 0;
}

async function cmdCalibrate(files: string[], flags: Flags): Promise<number> {
  let any = false;
  for (const file of expandSuitePaths(files)) {
    const suite = await loadSuite(file);
    const report = await runSuite(suite, runOptionsFrom(flags));
    const points = collectPoints(report, suite.cases);

    process.stdout.write(`\n${pc.bold(suite.name)}\n\n`);
    if (points.size === 0) {
      process.stdout.write(
        "  No Jev scorers ran, so there is nothing to calibrate.\n" +
          "  Add a jevJudge scorer, and label the cases whose answer you already know.\n\n",
      );
      continue;
    }
    for (const [scorerId, { points: p, unlabelled }] of points) {
      any = true;
      process.stdout.write(`${renderCalibration(calibrate(scorerId, p, unlabelled))}\n`);
    }
  }
  return any ? 0 : 0;
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
      cassettes: { type: "string" },
      "reports-dir": { type: "string" },
      json: { type: "string" },
      markdown: { type: "string" },
      "no-report": { type: "boolean", default: false },
      "fail-on-regression": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });

  const flags = values as unknown as Flags;
  const [command, ...rest] = positionals;

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  switch (command) {
    case "run":
      if (rest.length === 0) throw new CliError("run needs at least one suite file.");
      return cmdRun(rest, flags);
    case "record":
      if (rest.length === 0) throw new CliError("record needs at least one suite file.");
      return cmdRun(rest, flags, "rerecord");
    case "validate":
      if (rest.length === 0) throw new CliError("validate needs at least one suite file.");
      return cmdValidate(rest);
    case "diff":
      return cmdDiff(rest, flags);
    case "calibrate":
      if (rest.length === 0) throw new CliError("calibrate needs at least one suite file.");
      return cmdCalibrate(rest, flags);
    default:
      throw new CliError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${pc.red(message)}\n`);
    process.exitCode = 1;
  });
