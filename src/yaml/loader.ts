import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { defineCase } from "../core/define.js";
import type { Case, Expectations } from "../core/types.js";

/**
 * Cases as YAML, for the people who write them and do not write TypeScript.
 *
 * A fixture format lives or dies on its error messages, so validation errors
 * name the file and the field path, never just "invalid input":
 *
 *   evals/cases/offer.yaml → expect.toolArgs: not supported in YAML …
 */

export class YamlCaseError extends Error {
  override name = "YamlCaseError";
}

const messageSchema = z.union([
  z.string(),
  z.object({
    role: z.enum(["user", "assistant", "system", "tool"]),
    text: z.string(),
    meta: z.record(z.unknown()).optional(),
  }),
  z.object({
    role: z.enum(["user", "assistant", "system", "tool"]),
    content: z.string(),
    meta: z.record(z.unknown()).optional(),
  }),
]);

const stringOrList = z.union([z.string(), z.array(z.string())]);

/**
 * `toolArgs`, `matches` and `scorers` are deliberately absent: a zod schema, a
 * RegExp and a function have no honest YAML spelling, and a half-working one
 * ("regex as a string") would be a trap. Use a TypeScript suite for those.
 */
const expectSchema = z
  .object({
    toolCalled: stringOrList.optional(),
    toolNotCalled: stringOrList.optional(),
    escalated: z.boolean().optional(),
    blocked: z.boolean().optional(),
    handoff: z.boolean().optional(),
    contains: stringOrList.optional(),
    notContains: stringOrList.optional(),
    latencyUnder: z.number().positive().optional(),
    costUnder: z.number().positive().optional(),
    tokensUnder: z.number().positive().optional(),
    maxTurns: z.number().int().positive().optional(),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    history: z.array(messageSchema).optional(),
    inbound: messageSchema,
    expect: expectSchema.optional(),
    tags: z.array(z.string()).optional(),
    meta: z.record(z.unknown()).optional(),
    weight: z.number().positive().optional(),
    skip: z.boolean().optional(),
    only: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

/**
 * A file may hold one case or a list of them, but NOT as a zod union: a union
 * reports "(root): Invalid input" and swallows the field path, which is the one
 * thing this loader exists to get right. So the shape is decided first, and
 * only then validated.
 */
const listSchema = z.array(caseSchema);

const TS_ONLY: Record<string, string> = {
  toolArgs: "a zod schema has no YAML spelling",
  matches: "a RegExp has no YAML spelling",
  scorers: "a scorer is a function",
};

function describeIssue(issue: z.ZodIssue): string {
  const path = issue.path.join(".") || "(root)";
  if (issue.code === "unrecognized_keys") {
    const unknown = issue.keys.map((k) => {
      const why = TS_ONLY[k];
      return why ? `${k} (${why}; use a TypeScript suite)` : k;
    });
    return `${path}: unknown key(s): ${unknown.join(", ")}`;
  }
  return `${path}: ${issue.message}`;
}

export function parseCaseFile(source: string, file: string): Case[] {
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new YamlCaseError(`${file} → not valid YAML: ${message}`);
  }

  if (raw === null || raw === undefined) throw new YamlCaseError(`${file} → the file is empty`);

  const isList = Array.isArray(raw);
  const result = isList ? listSchema.safeParse(raw) : caseSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${file} → ${describeIssue(i)}`);
    throw new YamlCaseError(`Invalid case file:\n${lines.join("\n")}`);
  }

  const entries = isList
    ? (result.data as z.infer<typeof listSchema>)
    : [result.data as z.infer<typeof caseSchema>];
  return entries.map((entry) =>
    defineCase({
      id: entry.id,
      name: entry.name ?? entry.description,
      history: entry.history,
      inbound: entry.inbound,
      expect: (entry.expect ?? {}) as Expectations,
      tags: entry.tags,
      meta: entry.meta,
      weight: entry.weight,
      skip: entry.skip,
      only: entry.only,
      timeoutMs: entry.timeoutMs,
      source: { file },
    }),
  );
}

/** Loads one `.yaml` file, or every `.yaml` under a directory, recursively. */
export function loadCases(path: string): Case[] {
  const absolute = resolve(process.cwd(), path);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(absolute);
  } catch {
    throw new YamlCaseError(`No such path: ${path}`);
  }

  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ya?ml$/.test(name)) files.push(full);
    }
  };

  if (stat.isDirectory()) walk(absolute);
  else files.push(absolute);

  if (files.length === 0) throw new YamlCaseError(`No .yaml case files under ${path}`);

  const cases: Case[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const label = relative(process.cwd(), file).replace(/\\/g, "/");
    for (const kase of parseCaseFile(readFileSync(file, "utf8"), label)) {
      const previous = seen.get(kase.id);
      if (previous) {
        throw new YamlCaseError(`Duplicate case id "${kase.id}": ${previous} and ${label}`);
      }
      seen.set(kase.id, label);
      cases.push(kase);
    }
  }
  return cases;
}
