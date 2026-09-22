import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Report, Suite } from "../core/types.js";

export class CliError extends Error {
  override name = "CliError";
}

/**
 * TypeScript suites need a loader.
 *
 * tsx is preferred even on a Node that strips types natively, because native
 * stripping does not rewrite the `.js` specifiers that `moduleResolution:
 * NodeNext` forces you to write — a suite importing `./agent.js` next to an
 * `agent.ts` resolves under tsx and fails under plain Node.
 */
let tsRegistered = false;
async function ensureTsSupport(file: string): Promise<void> {
  if (tsRegistered || !/\.(m?ts|cts)$/.test(file)) return;
  tsRegistered = true;
  try {
    const tsx = (await import("tsx/esm/api")) as { register: () => void };
    tsx.register();
  } catch {
    // Left to the import below to fail with the real error; the hint is in its catch.
  }
}

/** Expands globs the shell did not, and directories, into suite files. */
export function expandSuitePaths(patterns: readonly string[]): string[] {
  const out: string[] = [];
  for (const pattern of patterns) {
    const absolute = resolve(process.cwd(), pattern);
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = statSync(absolute);
    } catch {
      stat = undefined;
    }

    if (stat?.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (/\.suite\.(m?[jt]s|cts)$/.test(name)) out.push(join(absolute, name));
      }
      continue;
    }
    if (stat?.isFile()) {
      out.push(absolute);
      continue;
    }

    // An unexpanded glob: only the simple `dir/*.suite.ts` shape, which is what
    // cmd.exe and PowerShell hand through verbatim.
    const star = pattern.lastIndexOf("*");
    if (star !== -1) {
      const dir = resolve(process.cwd(), pattern.slice(0, pattern.lastIndexOf("/") + 1) || ".");
      const tail = pattern.slice(star + 1);
      try {
        for (const name of readdirSync(dir).sort()) {
          if (name.endsWith(tail)) out.push(join(dir, name));
        }
        continue;
      } catch {
        // falls through to the error below
      }
    }
    throw new CliError(`No such file: ${pattern}`);
  }
  if (out.length === 0) throw new CliError("No suite files matched.");
  return out;
}

export async function loadSuite(file: string): Promise<Suite> {
  const absolute = resolve(process.cwd(), file);
  await ensureTsSupport(absolute);

  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Could not load ${file}: ${message}\n` +
        "If it is a TypeScript file, install tsx (pnpm add -D tsx) or run on Node >= 22.18.",
    );
  }

  const suite = (mod.default ?? mod.suite) as Suite | undefined;
  if (!suite || typeof suite !== "object" || !Array.isArray((suite as Suite).cases)) {
    throw new CliError(`${file} must default-export a suite created with defineSuite()`);
  }
  return suite;
}

export function loadReport(file: string): Report {
  const absolute = resolve(process.cwd(), file);
  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch {
    throw new CliError(`No such report: ${file}`);
  }
  let parsed: Report;
  try {
    parsed = JSON.parse(raw) as Report;
  } catch (err) {
    throw new CliError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.cases)) {
    throw new CliError(`${file} is not an agent-evals report (expected version 1)`);
  }
  return parsed;
}

export const isSuitePath = (p: string): boolean => /\.(m?[jt]s|cts)$/.test(extname(p) ? p : "");
