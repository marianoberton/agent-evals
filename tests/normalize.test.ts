import { describe, expect, it } from "vitest";
import {
  calledTool,
  didTransition,
  hash32,
  normalizeMessage,
  normalizeOutcome,
  outboundText,
  totalTokens,
  transitionReason,
} from "../src/index.js";

describe("normalizeMessage", () => {
  it("turns a bare string into a user message", () => {
    expect(normalizeMessage("hola")).toEqual({ role: "user", text: "hola" });
  });

  it("accepts content as an alias for text", () => {
    expect(normalizeMessage({ role: "assistant", content: "hi" })).toEqual({
      role: "assistant",
      text: "hi",
    });
  });

  it("keeps meta when present", () => {
    expect(normalizeMessage({ role: "user", text: "x", meta: { channel: "wa" } })).toEqual({
      role: "user",
      text: "x",
      meta: { channel: "wa" },
    });
  });

  it("rejects a message with neither text nor content", () => {
    expect(() => normalizeMessage({ role: "user" } as never)).toThrow(/string "text"/);
  });
});

describe("normalizeOutcome", () => {
  it("accepts a bare string as the outbound message", () => {
    expect(normalizeOutcome({ outbound: "hola" }).outbound).toEqual([
      { role: "assistant", text: "hola" },
    ]);
  });

  it("treats a missing outbound as an empty turn, not as an error", () => {
    expect(normalizeOutcome({}).outbound).toEqual([]);
    expect(normalizeOutcome({ outbound: null }).outbound).toEqual([]);
  });

  it("numbers tool calls in call order", () => {
    const o = normalizeOutcome({
      toolCalls: [
        { name: "a", args: {} },
        { name: "b", args: {} },
      ],
    });
    expect(o.toolCalls?.map((t) => t.seq)).toEqual([0, 1]);
  });

  it("does not invent fields the agent never reported", () => {
    const o = normalizeOutcome({ outbound: "x" });
    expect(o.toolCalls).toBeUndefined();
    expect(o.transitions).toBeUndefined();
    expect(o.costUsd).toBeUndefined();
  });

  it("rejects a non-object return value", () => {
    expect(() => normalizeOutcome("nope" as never)).toThrow(/must return an object/);
  });
});

describe("absent-field readers", () => {
  it("returns null, not false, when the agent reports no transitions", () => {
    expect(didTransition(normalizeOutcome({ outbound: "x" }), "escalated")).toBeNull();
  });

  it("returns false when transitions are reported but empty", () => {
    expect(didTransition(normalizeOutcome({ outbound: "x", transitions: [] }), "escalated")).toBe(
      false,
    );
  });

  it("reads the transition reason", () => {
    const o = normalizeOutcome({
      transitions: [{ type: "escalated", reason: "price_negotiation" }],
    });
    expect(transitionReason(o, "escalated")).toBe("price_negotiation");
  });

  it("returns null, not false, when the agent reports no tool calls", () => {
    expect(calledTool(normalizeOutcome({ outbound: "x" }), "t")).toBeNull();
    expect(calledTool(normalizeOutcome({ outbound: "x", toolCalls: [] }), "t")).toBe(false);
  });
});

describe("helpers", () => {
  it("joins every outbound message", () => {
    expect(outboundText(normalizeOutcome({ outbound: ["a", "b"] }))).toBe("a\nb");
  });

  it("sums tokens and returns undefined when none were reported", () => {
    expect(totalTokens(normalizeOutcome({ tokens: { inputTokens: 10, outputTokens: 5 } }))).toBe(
      15,
    );
    expect(totalTokens(normalizeOutcome({}))).toBeUndefined();
    expect(totalTokens(normalizeOutcome({ tokens: {} }))).toBeUndefined();
  });

  it("hashes deterministically", () => {
    expect(hash32("a/b")).toBe(hash32("a/b"));
    expect(hash32("a/b")).not.toBe(hash32("a/c"));
  });
});
