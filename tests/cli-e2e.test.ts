import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Drives the CLI as a user does: a real process, real exit codes, real files.
 * Unit tests of the command functions would not catch an argument-parsing bug,
 * a bad exit code, or a suite that fails to load.
 */
const ROOT = resolve(__dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(...args: string[]): Run {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), CLI, ...args],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "" },
      },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const tmp = () => mkdtempSync(join(tmpdir(), "ae-cli-"));

const ECHO = "examples/echo-agent/echo.suite.ts";
const BUGGY = "tests/fixtures/failing.suite.ts";

describe("help and version", () => {
  it("prints usage with no command and exits non-zero", () => {
    const r = cli();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("agent-evals run");
  });

  it("prints usage on --help and exits zero", () => {
    const r = cli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("calibrate");
  });

  it("prints the version", () => {
    expect(cli("--version").stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects an unknown command", () => {
    const r = cli("frobnicate", ECHO);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown command "frobnicate"');
  });

  it("rejects a suite file that does not exist", () => {
    const r = cli("run", "nope/missing.suite.ts");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("No such file");
  });
});

describe("run", () => {
  it("passes the green example and exits zero", () => {
    const r = cli("run", ECHO, "--no-report");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("echo-agent");
    expect(r.stdout).toContain("1.00");
  });

  it("exits 1 on the buggy suite only when asked to gate", () => {
    expect(cli("run", BUGGY, "--no-report").code).toBe(0);
    expect(cli("run", BUGGY, "--no-report", "--fail-under").code).toBe(1);
  });

  it("honours a threshold override", () => {
    expect(cli("run", BUGGY, "--no-report", "--fail-under", "--threshold", "0.5").code).toBe(0);
  });

  it("rejects a non-numeric threshold instead of silently scoring NaN", () => {
    const r = cli("run", ECHO, "--no-report", "--threshold", "high");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--threshold expects a number");
  });

  it("filters by tag and by case id", () => {
    expect(cli("run", ECHO, "--no-report", "--tag", "policy").stdout).not.toContain(
      "stock-question",
    );
    const only = cli("run", ECHO, "--no-report", "--only", "stock-question").stdout;
    expect(only).toContain("stock-question");
    expect(only).not.toContain("wants-human");
  });

  it("rejects an unknown cassette mode", () => {
    const r = cli("run", ECHO, "--no-report", "--cassettes", "sideways");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--cassettes expects one of");
  });

  it("writes a JSON report and a latest.json next to it", () => {
    const dir = tmp();
    const r = cli("run", ECHO, "--reports-dir", dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "latest.json"))).toBe(true);

    const report = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
    expect(report).toMatchObject({ version: 1, suite: "echo-agent", passed: true });
    expect(report.cases).toHaveLength(6);
  });

  it("writes markdown when asked", () => {
    const dir = tmp();
    cli("run", ECHO, "--reports-dir", dir, "--markdown", join(dir, "report.md"));
    const md = readFileSync(join(dir, "report.md"), "utf8");
    expect(md).toContain("**echo-agent**");
    expect(md).toContain("| case");
  });
});

describe("validate", () => {
  it("loads suites without running the agent", () => {
    const r = cli("validate", ECHO);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("echo-agent");
    expect(r.stdout).toContain("6 case(s)");
  });
});

describe("diff", () => {
  it("compares two written reports and gates on regressions", () => {
    const dir = tmp();
    cli("run", ECHO, "--reports-dir", dir, "--json", join(dir, "good.json"));
    cli("run", BUGGY, "--reports-dir", dir, "--json", join(dir, "bad.json"));

    const same = cli(
      "diff",
      join(dir, "good.json"),
      join(dir, "good.json"),
      "--fail-on-regression",
    );
    expect(same.code).toBe(0);
    expect(same.stdout).toContain("No regressions");

    // Different suites: every case is new/removed, so still no regression.
    const cross = cli("diff", join(dir, "good.json"), join(dir, "bad.json"));
    expect(cross.stdout).toMatch(/[+-] /);
  });

  it("says so when the report file is missing or not a report", () => {
    expect(cli("diff", "nope.json").stderr).toContain("No such report");
    const dir = tmp();
    cli("run", ECHO, "--reports-dir", dir);
    expect(cli("diff", "package.json", join(dir, "latest.json")).stderr).toContain(
      "not an agent-evals report",
    );
  });
});

describe("calibrate", () => {
  it("explains what is missing when nothing is judged by Jev", () => {
    const r = cli("calibrate", ECHO, "--no-report");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("nothing to calibrate");
  });

  it("prints a reliability table from the labelled example, offline", () => {
    const r = cli("calibrate", "examples/calibration/calibrate.suite.ts", "--no-report");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("jev:grounded");
    expect(r.stdout).toContain("predicted  observed");

    // The example is built around a judge that is confidently wrong once, so the
    // safe threshold lands ABOVE the 0.9 the suite naively gates at. That gap is
    // the whole reason this command exists.
    expect(r.stdout).toMatch(/at or above 0\.9[4-9]/);
  });

  it("needs no network: the cassettes carry the judge's answers", () => {
    const r = cli(
      "calibrate",
      "examples/calibration/calibrate.suite.ts",
      "--no-report",
      "--cassettes",
      "replay",
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("brier=");
  });
});
