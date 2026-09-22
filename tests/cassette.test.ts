import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CassetteMissError,
  CassetteStore,
  canonicalize,
  hashRequest,
  slugify,
} from "../src/index.js";

const tmp = (): string => mkdtempSync(join(tmpdir(), "agent-evals-"));

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Counts calls so "the second run makes zero network calls" is measurable. */
function counting(body: unknown = { ok: true, usage: { input_tokens: 40, cost: 0.002 } }) {
  const state = { calls: 0 };
  const fetchImpl = (async (): Promise<Response> => {
    state.calls += 1;
    await new Promise((r) => setTimeout(r, 4));
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchImpl, state };
}

describe("hashing", () => {
  it("sorts object keys so identical requests hash the same", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toEqual({ a: { c: 3, d: 2 }, b: 1 });
  });

  it("keeps array order, because a score scale is ordinal", () => {
    expect(canonicalize(["alto", "bajo"])).toEqual(["alto", "bajo"]);
    const a = hashRequest({ method: "POST", url: "u", body: { c: ["x", "y"] } });
    const b = hashRequest({ method: "POST", url: "u", body: { c: ["y", "x"] } });
    expect(a).not.toBe(b);
  });

  it("ignores key order but not content", () => {
    const one = hashRequest({ method: "POST", url: "u", body: { a: 1, b: 2 } });
    const two = hashRequest({ method: "POST", url: "u", body: { b: 2, a: 1 } });
    expect(one).toBe(two);
  });

  it("invalidates on purpose when the question changes", () => {
    const before = hashRequest({ method: "POST", url: "u", body: { q: "¿Responde?" } });
    const after = hashRequest({ method: "POST", url: "u", body: { q: "¿Responde bien?" } });
    expect(before).not.toBe(after);
  });

  it("re-records when the gateway changes", () => {
    const or = hashRequest({ method: "POST", url: "https://openrouter.ai/x", body: {} });
    const ts = hashRequest({ method: "POST", url: "https://api.typesafe.ai/x", body: {} });
    expect(or).not.toBe(ts);
  });
});

describe("slugify", () => {
  it("leaves a clean id alone", () => {
    expect(slugify("stock-question")).toBe("stock-question");
  });

  it("disambiguates when it had to change the id", () => {
    const a = slugify("¿Corolla?");
    const b = slugify("Corolla");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^corolla-[0-9a-f]{6}$/);
  });

  it("never emits a reserved win32 device name", () => {
    expect(slugify("con")).not.toBe("con");
    expect(slugify("con")).toMatch(/^case-|^con-/);
  });
});

describe("record then replay", () => {
  it("records on the first run and makes zero network calls on the second", async () => {
    const dir = tmp();
    const net = counting();

    const first = new CassetteStore("suite", { dir, mode: "auto" }, net.fetch);
    const a = first.openCase("case-1");
    await a.fetch("https://api.example.com/x", { method: "POST", body: '{"q":1}' });
    a.close(true);
    expect(net.state.calls).toBe(1);

    const second = new CassetteStore("suite", { dir, mode: "auto" }, net.fetch);
    const b = second.openCase("case-1");
    const response = await b.fetch("https://api.example.com/x", {
      method: "POST",
      body: '{"q":1}',
    });
    b.close(true);

    expect(net.state.calls).toBe(1); // the whole point
    expect(await response.json()).toMatchObject({ ok: true });
    expect(second.hits).toBe(1);
    expect(second.misses).toBe(0);
  });

  it("replays the recorded latency and usage, not a fresh wall clock", async () => {
    const dir = tmp();
    const net = counting();
    const first = new CassetteStore("s", { dir, mode: "record" }, net.fetch);
    const a = first.openCase("c");
    await a.fetch("https://x.test/", { method: "POST", body: "{}" });
    a.close(true);
    const recordedMs = a.replayedMs;
    expect(recordedMs).toBeGreaterThan(0);

    const second = new CassetteStore("s", { dir, mode: "replay" }, net.fetch);
    const b = second.openCase("c");
    await b.fetch("https://x.test/", { method: "POST", body: "{}" });
    expect(b.replayedMs).toBe(recordedMs);
    expect(b.tokens.inputTokens).toBe(40);
    expect(b.costUsd).toBeCloseTo(0.002, 6);
  });

  it("serves repeated identical calls in recorded order", async () => {
    const dir = tmp();
    let n = 0;
    const net = (async () =>
      new Response(JSON.stringify({ n: ++n }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;

    const first = new CassetteStore("s", { dir, mode: "record" }, net);
    const a = first.openCase("c");
    await a.fetch("https://x.test/", { method: "POST", body: "{}" });
    await a.fetch("https://x.test/", { method: "POST", body: "{}" });
    a.close(true);

    const second = new CassetteStore("s", { dir, mode: "replay" }, net);
    const b = second.openCase("c");
    const one = await (await b.fetch("https://x.test/", { method: "POST", body: "{}" })).json();
    const two = await (await b.fetch("https://x.test/", { method: "POST", body: "{}" })).json();
    expect([one, two]).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("throws a miss in replay mode, naming the record command", async () => {
    const dir = tmp();
    const store = new CassetteStore("dealership", { dir, mode: "replay" }, counting().fetch);
    const c = store.openCase("nope");
    await expect(c.fetch("https://x.test/", { method: "POST", body: "{}" })).rejects.toThrow(
      CassetteMissError,
    );
    await expect(c.fetch("https://x.test/", { method: "POST", body: "{}" })).rejects.toThrow(
      /agent-evals record dealership/,
    );
  });

  it("does not write a tape when the case is discarded", async () => {
    const dir = tmp();
    const store = new CassetteStore("s", { dir, mode: "record" }, counting().fetch);
    const c = store.openCase("crashed");
    await c.fetch("https://x.test/", { method: "POST", body: "{}" });
    c.close(false);
    expect(readdirSync(dir)).not.toContain("s");
  });

  it("rerecord ignores the existing tape", async () => {
    const dir = tmp();
    const net = counting();
    const first = new CassetteStore("s", { dir, mode: "record" }, net.fetch);
    const a = first.openCase("c");
    await a.fetch("https://x.test/", { method: "POST", body: "{}" });
    a.close(true);

    const again = new CassetteStore("s", { dir, mode: "rerecord" }, net.fetch);
    const b = again.openCase("c");
    await b.fetch("https://x.test/", { method: "POST", body: "{}" });
    expect(net.state.calls).toBe(2);
  });

  it("passthrough never reads or writes", async () => {
    const dir = tmp();
    const net = counting();
    const store = new CassetteStore("s", { dir, mode: "passthrough" }, net.fetch);
    const c = store.openCase("c");
    await c.fetch("https://x.test/", { method: "POST", body: "{}" });
    await c.fetch("https://x.test/", { method: "POST", body: "{}" });
    c.close(true);
    expect(net.state.calls).toBe(2);
  });

  it("forces replay under CI, so a missing tape can never cost money", () => {
    vi.stubEnv("CI", "true");
    expect(new CassetteStore("s", { dir: tmp() }).mode).toBe("replay");
  });
});

describe("what gets written", () => {
  it("never writes the api key", async () => {
    const dir = tmp();
    const net = counting();
    const store = new CassetteStore("s", { dir, mode: "record" }, net.fetch);
    const c = store.openCase("c");
    await c.fetch("https://x.test/", {
      method: "POST",
      headers: { authorization: "Bearer sk-secret-value-abcdefghijklmnop" },
      body: JSON.stringify({ apiKey: "sk-secret-value-abcdefghijklmnop" }),
    });
    c.close(true);

    const file = readFileSync(join(dir, "s", "c.json"), "utf8");
    expect(file).not.toContain("sk-secret-value-abcdefghijklmnop");
    expect(file).toContain("[redacted]");
  });

  it("writes a readable, stable file", async () => {
    const dir = tmp();
    const store = new CassetteStore("my suite", { dir, mode: "record" }, counting().fetch);
    const c = store.openCase("my case");
    await c.fetch("https://x.test/", { method: "POST", body: '{"q":1}' });
    c.close(true);

    const parsed = JSON.parse(
      readFileSync(join(dir, slugify("my suite"), `${slugify("my case")}.json`), "utf8"),
    );
    expect(parsed).toMatchObject({ version: 1, suite: "my suite", case: "my case" });
    expect(parsed.interactions[0]).toMatchObject({
      seq: 0,
      request: { method: "POST", url: "https://x.test/", body: { q: 1 } },
      response: { status: 200 },
    });
    expect(parsed.interactions[0].key).toMatch(/^sha256:[0-9a-f]{32}$/);
  });
});
