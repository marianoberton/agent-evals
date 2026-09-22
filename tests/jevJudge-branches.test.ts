import { describe, expect, it } from "vitest";
import { defaultState, jev, jevJudge, normalizeOutcome, scorers } from "../src/index.js";
import type { Case, JevAnswer, Score, Scorer, SuiteMeta } from "../src/index.js";

const SUITE: SuiteMeta = { name: "t", threshold: 1 };

/** jevJudge reads pre-fetched answers; it must never call out from `score`. */
const neverCalled = (() => {
  throw new Error("jevJudge must not fetch from score()");
}) as unknown as typeof globalThis.fetch;

const kase = (over: Partial<Case> = {}): Case => ({
  id: "c",
  history: [{ role: "user", text: "hola" }],
  inbound: { role: "user", text: "¿Tienen Corolla?" },
  expect: {},
  tags: [],
  meta: {},
  weight: 1,
  ...over,
});

/** Grades a judge directly against a canned answer, with no network in sight. */
const grade = (scorer: Scorer, answer: JevAnswer | undefined, planError?: Error): Score =>
  scorer.score({
    outcome: normalizeOutcome({ outbound: "hola" }),
    case: kase(),
    suite: SUITE,
    fetch: neverCalled,
    ...(answer ? { answers: { q: answer } } : {}),
    ...(planError ? { planError } : {}),
  }) as Score;

describe("defaultState", () => {
  it("carries what a judge needs to judge", () => {
    const state = defaultState(
      normalizeOutcome({
        outbound: "Sí, tenemos.",
        toolCalls: [{ name: "lookupStock", args: { q: "Corolla" } }],
        transitions: [{ type: "escalated", reason: "price_negotiation" }],
      }),
      kase(),
    );
    expect(state).toEqual({
      history: [{ role: "user", text: "hola" }],
      inbound: "¿Tienen Corolla?",
      reply: ["Sí, tenemos."],
      toolCalls: [{ name: "lookupStock", args: { q: "Corolla" } }],
      transitions: ["escalated"],
    });
  });

  it("carries nothing that changes between runs", () => {
    const state = defaultState(
      normalizeOutcome({ outbound: "x", latencyMs: 4, costUsd: 0.1, trace: { anything: 1 } }),
      kase(),
    );
    for (const forbidden of ["latencyMs", "costUsd", "tokens", "trace"]) {
      expect(Object.keys(state)).not.toContain(forbidden);
    }
  });
});

describe("noul gating", () => {
  const scorer = jevJudge({ question: jev.noul("¿Responde?"), passAbove: 0.9 });

  it("passes at exactly the threshold", () => {
    expect(grade(scorer, { type: "noul", noul: 0.9 }).pass).toBe(true);
  });

  it("defaults the threshold to 0.5 when none is given", () => {
    const loose = jevJudge({ question: jev.noul("¿?") });
    expect(grade(loose, { type: "noul", noul: 0.51 }).pass).toBe(true);
    expect(grade(loose, { type: "noul", noul: 0.49 }).pass).toBe(false);
  });
});

describe("score gating", () => {
  const answer = (score: number): JevAnswer => ({ type: "score", score, confidence: 0.8 });

  it("honours a floor", () => {
    const scorer = jevJudge({ question: jev.score("¿?", ["a", "b"]), passAtLeast: 1 });
    expect(grade(scorer, answer(1.2)).pass).toBe(true);
    expect(grade(scorer, answer(0.4)).reason).toBe("0.40 outside >= 1");
  });

  it("honours a band", () => {
    const scorer = jevJudge({
      question: jev.score("¿?", ["a", "b", "c"]),
      passAtLeast: 1,
      passAtMost: 2,
    });
    expect(grade(scorer, answer(1.5)).reason).toBe("1.50 within 1..2");
    expect(grade(scorer, answer(2.4)).pass).toBe(false);
  });

  it("passes anything when no bound was set, and says so", () => {
    const scorer = jevJudge({ question: jev.score("¿?", ["a", "b"]) });
    expect(grade(scorer, answer(9)).reason).toContain("(no bound set)");
  });
});

describe("choice gating", () => {
  const pick = (choice: string, confidence: number): JevAnswer => ({
    type: "choice",
    choice,
    confidence,
    probabilities: { [choice]: confidence },
  });
  const question = jev.choice("¿Qué quiere?", { stock: "Stock", price: "Precio" });

  it("accepts any of several allowed picks", () => {
    const scorer = jevJudge({ question, passIs: ["stock", "price"] });
    expect(grade(scorer, pick("price", 0.9)).pass).toBe(true);
  });

  it("rejects a pick that is confident but wrong", () => {
    const scorer = jevJudge({ question, passIs: "stock" });
    const s = grade(scorer, pick("price", 0.99));
    expect(s.pass).toBe(false);
    expect(s.reason).toBe('picked "price", expected stock');
  });

  it("rejects a right pick the model is not sure about", () => {
    const scorer = jevJudge({ question, passIs: "stock", minConfidence: 0.8 });
    const s = grade(scorer, pick("stock", 0.55));
    expect(s.pass).toBe(false);
    expect(s.reason).toContain("only 0.55 confident (need 0.8)");
  });

  it("accepts any pick when none was specified", () => {
    const scorer = jevJudge({ question });
    expect(grade(scorer, pick("price", 0.7)).pass).toBe(true);
  });
});

describe("failure handling", () => {
  const scorer = jevJudge({ question: jev.noul("¿?"), passAbove: 0.5 });

  it("skips when the batch returned no answer for this question", () => {
    const s = grade(scorer, undefined);
    expect(s.pass).toBeNull();
    expect(s.reason).toContain("no answer returned");
  });

  it("fails loudly when Jev broke", () => {
    expect(grade(scorer, undefined, new Error("HTTP 500")).pass).toBe(false);
  });

  it("skips instead when the judge is soft", () => {
    const soft = jevJudge({ question: jev.noul("¿?"), passAbove: 0.5, soft: true });
    const s = grade(soft, undefined, new Error("HTTP 500"));
    expect(s.pass).toBeNull();
    expect(s.reason).toContain("jev unavailable");
  });
});

describe("scorer wiring", () => {
  it("derives a readable id from the question when none is given", () => {
    const scorer = jevJudge({ question: jev.noul("Does the reply answer the question?") });
    expect(scorer.id).toBe("jev:does-the-reply-answer");
    expect(scorer.group).toBe(scorer.id);
  });

  it("carries weight, critical and when through", () => {
    const scorer = jevJudge({
      question: jev.noul("¿?"),
      weight: 3,
      critical: true,
      when: (c) => c.tags.includes("policy"),
    });
    expect(scorer.weight).toBe(3);
    expect(scorer.critical).toBe(true);
    expect(scorer.when?.(kase({ tags: ["policy"] }))).toBe(true);
    expect(scorer.when?.(kase())).toBe(false);
  });

  it("plans one question against the state builder it was given", () => {
    const scorer = jevJudge({ question: jev.noul("¿?"), state: () => ({ custom: true }) });
    const plan = scorer.plan?.(normalizeOutcome({ outbound: "x" }), kase());
    expect(plan?.state).toEqual({ custom: true });
    expect(Object.keys(plan?.questions ?? {})).toEqual(["q"]);
  });

  it("marks itself when it opts out of the volatility guard", () => {
    const scorer = jevJudge({ question: jev.noul("¿?"), allowVolatileState: true });
    expect((scorer as { allowVolatileState?: boolean }).allowVolatileState).toBe(true);
  });

  it("is reachable from the scorers namespace", () => {
    expect(scorers.jevJudge).toBe(jevJudge);
  });
});
