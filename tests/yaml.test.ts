import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import yamlSuite from "../examples/yaml-cases/yaml.suite.js";
import { runSuite } from "../src/index.js";
import { YamlCaseError, loadCases, parseCaseFile } from "../src/yaml/loader.js";

const write = (name: string, body: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "ae-yaml-"));
  const file = join(dir, name);
  writeFileSync(file, body, "utf8");
  return file;
};

describe("parseCaseFile", () => {
  it("reads a single case", () => {
    const cases = parseCaseFile(
      `id: stock
inbound: "¿Tienen Corolla?"
expect:
  toolCalled: lookupStock
`,
      "x.yaml",
    );
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      id: "stock",
      inbound: { role: "user", text: "¿Tienen Corolla?" },
      expect: { toolCalled: "lookupStock" },
      source: { file: "x.yaml" },
    });
  });

  it("reads a list of cases from one file", () => {
    const cases = parseCaseFile(
      `- id: a
  inbound: uno
- id: b
  inbound: dos
`,
      "x.yaml",
    );
    expect(cases.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("accepts both message shapes in history", () => {
    const cases = parseCaseFile(
      `id: a
history:
  - hola
  - { role: assistant, text: "¿en qué te ayudo?" }
  - { role: user, content: "busco una Hilux" }
inbound: x
`,
      "x.yaml",
    );
    expect(cases[0]?.history.map((m) => m.text)).toEqual([
      "hola",
      "¿en qué te ayudo?",
      "busco una Hilux",
    ]);
  });

  it("carries meta and tags through for conditional scorers", () => {
    const cases = parseCaseFile(
      `id: a
inbound: x
tags: [policy]
meta:
  intent: price_negotiation
`,
      "x.yaml",
    );
    expect(cases[0]).toMatchObject({ tags: ["policy"], meta: { intent: "price_negotiation" } });
  });
});

describe("validation errors name the file and the field", () => {
  it("rejects a missing inbound", () => {
    expect(() => parseCaseFile("id: a\n", "cases/a.yaml")).toThrow(/cases\/a\.yaml → inbound/);
  });

  it("rejects a wrong type, saying what it wanted", () => {
    const err = (() => {
      try {
        parseCaseFile("id: a\ninbound: x\nexpect:\n  latencyUnder: soon\n", "cases/a.yaml");
      } catch (e) {
        return e as Error;
      }
      return new Error("did not throw");
    })();
    expect(err.message).toContain("cases/a.yaml → expect.latencyUnder");
    expect(err.message).toMatch(/number/i);
  });

  it("rejects an unknown key instead of ignoring it", () => {
    expect(() => parseCaseFile("id: a\ninbound: x\nexpct: {}\n", "a.yaml")).toThrow(
      /unknown key\(s\): expct/,
    );
  });

  it("explains why toolArgs, matches and scorers are not available in YAML", () => {
    const err = (() => {
      try {
        parseCaseFile("id: a\ninbound: x\nexpect:\n  matches: 'USD'\n", "a.yaml");
      } catch (e) {
        return e as Error;
      }
      return new Error("did not throw");
    })();
    expect(err.message).toContain(
      "matches (a RegExp has no YAML spelling; use a TypeScript suite)",
    );
  });

  it("rejects malformed YAML with the parser's own complaint", () => {
    expect(() => parseCaseFile("id: [unclosed\n", "a.yaml")).toThrow(/not valid YAML/);
  });

  it("rejects an empty file", () => {
    expect(() => parseCaseFile("", "a.yaml")).toThrow(/the file is empty/);
  });
});

describe("loadCases", () => {
  it("reads every yaml under a directory, recursively and in order", () => {
    const dir = mkdtempSync(join(tmpdir(), "ae-yaml-dir-"));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "a.yaml"), "id: a\ninbound: x\n");
    writeFileSync(join(dir, "nested", "b.yml"), "id: b\ninbound: y\n");
    writeFileSync(join(dir, "ignored.txt"), "not a case");

    expect(loadCases(dir).map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("refuses two cases with the same id and names both files", () => {
    const dir = mkdtempSync(join(tmpdir(), "ae-yaml-dup-"));
    writeFileSync(join(dir, "one.yaml"), "id: same\ninbound: x\n");
    writeFileSync(join(dir, "two.yaml"), "id: same\ninbound: y\n");
    expect(() => loadCases(dir)).toThrow(/Duplicate case id "same".*one\.yaml.*two\.yaml/s);
  });

  it("says so when the path does not exist or holds no cases", () => {
    expect(() => loadCases("nope/nowhere")).toThrow(YamlCaseError);
    expect(() => loadCases(mkdtempSync(join(tmpdir(), "ae-yaml-empty-")))).toThrow(
      /No \.yaml case files/,
    );
  });

  it("reads one file directly", () => {
    const file = write("single.yaml", "id: only\ninbound: x\n");
    expect(loadCases(file).map((c) => c.id)).toEqual(["only"]);
  });
});

describe("a YAML suite is just a suite", () => {
  it("runs and scores exactly like a TypeScript one", async () => {
    const report = await runSuite(yamlSuite);
    expect(report.passed).toBe(true);
    expect(report.cases.map((c) => c.id).sort()).toEqual([
      "price-negotiation-escalates",
      "stock-question",
      "wants-human-hands-off",
    ]);
  });

  it("desugars YAML `expect` through the same scorers", async () => {
    const report = await runSuite(yamlSuite, { only: ["price-negotiation-escalates"] });
    const ids = report.cases[0]?.scores.map((s) => s.scorerId) ?? [];
    expect(ids).toContain("escalated");
    expect(ids).toContain("toolNotCalled:sendQuote");
  });
});
