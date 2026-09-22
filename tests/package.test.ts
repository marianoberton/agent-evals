import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The M5 gate: `npm i -D agent-evals` works from a clean project.
 *
 * This packs the real tarball and installs it into an empty directory, because
 * every packaging bug — a missing file, a wrong exports path, a devDependency
 * that turned out to be load-bearing — only shows up on the far side of
 * `npm pack`. Running the source in this repo proves none of it.
 */

const ROOT = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  exports: Record<string, unknown>;
  files: string[];
  dependencies: Record<string, string>;
};

const run = (cmd: string, args: string[], cwd: string): string =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * npm's own JS entry point, driven by this Node.
 *
 * Not `npm` / `npm.cmd`: Node 22 refuses to spawn a `.cmd` without a shell, and
 * a shell brings quoting problems that have nothing to do with what is being
 * tested. `npm_execpath` is set when vitest was started by npm; otherwise npm
 * ships next to the node binary.
 */
const npmCli = (): string => {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv?.endsWith(".js") && existsSync(fromEnv)) return fromEnv;
  const bundled = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(bundled)) return bundled;
  const unix = "/usr/lib/node_modules/npm/bin/npm-cli.js";
  if (existsSync(unix)) return unix;
  throw new Error("could not locate npm-cli.js");
};

const npm = (args: string[], cwd: string): string =>
  run(process.execPath, [npmCli(), ...args], cwd);

describe("the published package", () => {
  it("declares the entry points it promises", () => {
    expect(pkg.exports["."]).toMatchObject({ import: "./dist/index.js" });
    expect(pkg.exports["./vitest"]).toMatchObject({ import: "./dist/vitest/index.js" });
    expect(pkg.files).toContain("dist");
  });

  it("ships only what a consumer needs", () => {
    // Anything heavier than these belongs in devDependencies. A consumer
    // installing an eval harness should not inherit a build toolchain.
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["picocolors", "yaml", "zod"]);
  });

  it("packs every file the exports map points at", () => {
    const listing = npm(["pack", "--dry-run", "--json"], ROOT);
    const files = (JSON.parse(listing) as { files: { path: string }[] }[])[0]?.files.map(
      (f) => f.path,
    );
    for (const needed of [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/cli.js",
      "dist/vitest/index.js",
      "dist/vitest/index.d.ts",
      "README.md",
      "LICENSE",
    ]) {
      expect(files, `${needed} is missing from the tarball`).toContain(needed);
    }
  });

  it("does not ship tests, examples, cassettes or the local explainer", () => {
    const listing = npm(["pack", "--dry-run", "--json"], ROOT);
    const files = (JSON.parse(listing) as { files: { path: string }[] }[])[0]?.files.map(
      (f) => f.path,
    );
    for (const file of files ?? []) {
      expect(file).not.toMatch(/^(tests|examples|scripts|evals)\//);
      expect(file).not.toBe("explicacion.html");
      expect(file).not.toMatch(/\.env/);
    }
  });

  it(
    "installs into a clean project and runs a suite end to end",
    async () => {
      npm(["pack", "--pack-destination", tmpdir()], ROOT);
      const tarball = join(tmpdir(), `${pkg.name}-${pkg.version}.tgz`);
      expect(existsSync(tarball), "npm pack produced no tarball").toBe(true);

      const project = mkdtempSync(join(tmpdir(), "ae-consumer-"));
      writeFileSync(
        join(project, "package.json"),
        JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2),
      );
      npm(["install", "--no-audit", "--no-fund", tarball], project);

      // A suite written the way a consumer writes one: plain JS, package name
      // imports, no build step, no tsx.
      writeFileSync(
        join(project, "my.suite.js"),
        `import { defineSuite, scorers } from "agent-evals";

export default defineSuite({
  name: "consumer-suite",
  threshold: 1,
  agent: ({ inbound }) => ({
    outbound: \`eco: \${inbound.text}\`,
    toolCalls: [{ name: "echo", args: {} }],
    transitions: [],
    latencyMs: 3,
  }),
  scorers: [scorers.replied(), scorers.latencyUnder(1000)],
  cases: [
    { id: "a", inbound: "hola", expect: { toolCalled: "echo", contains: "eco" } },
  ],
});
`,
      );

      const out = run(
        process.execPath,
        [
          join(project, "node_modules", "agent-evals", "dist", "cli.js"),
          "run",
          "my.suite.js",
          "--fail-under",
          "--no-report",
        ],
        project,
      );
      expect(out).toContain("consumer-suite");
      expect(out).toContain("1.00");

      // And the programmatic API, including the root-exported expectAgent.
      writeFileSync(
        join(project, "check.mjs"),
        `import { runSuite, renderMarkdown, expectAgent, jev, jevJudge } from "agent-evals";
import suite from "./my.suite.js";

const report = await runSuite(suite);
if (!report.passed) throw new Error("suite did not pass");
if (!renderMarkdown(report).includes("consumer-suite")) throw new Error("no markdown");
if (typeof jevJudge !== "function" || typeof jev.noul !== "function") throw new Error("no jev");

await expectAgent(() => ({ outbound: "hola" })).receives("x").toContain("hola");
console.log("ok");
`,
      );
      expect(run(process.execPath, [join(project, "check.mjs")], project).trim()).toBe("ok");
    },
    { timeout: 180_000 },
  );
});
