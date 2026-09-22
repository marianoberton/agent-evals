import { outboundText } from "../core/normalize.js";
import { fail, pass, skip } from "../core/score.js";
import type { Case, Outcome, Scorer } from "../core/types.js";

/**
 * An LLM asked to grade a reply.
 *
 * This is the thing the library exists to argue against, shipped anyway because
 * sometimes you genuinely want prose in the loop. It is `kind: "llm"`, which
 * means it is **off the gate by default** and only runs with
 * `--include-llm-judge`.
 *
 * Why it is off by default, plainly: ask the same model the same question twice
 * and you can get 4 and then 2. A threshold on that is not a gate, it is a coin
 * you flip on every deploy. Use `jevJudge` for anything you intend to block on;
 * use this to read an opinion while you are still working out what the rule is.
 *
 * It goes through the cassette like every other call, so a recorded run is at
 * least reproducible — but re-recording can change the verdict, which is exactly
 * the property `jevJudge` does not have.
 */

export interface LlmJudgeOptions {
  /** What the judge is asked. Written as instructions to a grader, not a prompt. */
  rubric: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Pass when the score is at least this, on the 0–1 scale the rubric returns. */
  passAbove?: number;
  /** What the judge sees. Defaults to the same reproducible shape `jevJudge` uses. */
  state?: (outcome: Outcome, c: Case) => unknown;
  id?: string;
  label?: string;
  weight?: number;
  /** Skip instead of failing when the call itself fails. Defaults to true here. */
  soft?: boolean;
  maxTokens?: number;
  when?: (c: Case) => boolean;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";

const SYSTEM = [
  "You grade one reply from a customer-service agent against a rubric.",
  "Answer with JSON only, no prose around it:",
  '{"score": <number between 0 and 1>, "reason": "<one short sentence>"}',
  "1 means the reply fully satisfies the rubric, 0 means it does not at all.",
].join("\n");

function defaultState(outcome: Outcome, c: Case): Record<string, unknown> {
  return {
    history: c.history.map((m) => ({ role: m.role, text: m.text })),
    inbound: c.inbound.text,
    reply: outcome.outbound.map((m) => m.text),
    toolCalls: (outcome.toolCalls ?? []).map((t) => ({ name: t.name, args: t.args })),
  };
}

interface Verdict {
  score: number;
  reason: string;
}

/** Models wrap JSON in prose often enough that a bare JSON.parse is not enough. */
export function parseVerdict(text: string): Verdict | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Verdict>;
    if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) return undefined;
    return {
      score: Math.min(1, Math.max(0, parsed.score)),
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return undefined;
  }
}

export function llmJudge(options: LlmJudgeOptions): Scorer {
  const id = options.id ?? "llmJudge";
  const threshold = options.passAbove ?? 0.7;
  const build = options.state ?? defaultState;
  const soft = options.soft ?? true;

  return {
    id,
    group: id,
    label: options.label ?? id,
    // Never "deterministic". This is the flag that keeps it off the gate.
    kind: "llm",
    weight: options.weight ?? 1,
    critical: false,
    ...(options.when ? { when: options.when } : {}),

    async score({ outcome, case: kase, fetch: cassetteFetch }) {
      const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;

      const body = {
        model: options.model ?? DEFAULT_MODEL,
        max_tokens: options.maxTokens ?? 200,
        // Sampling off. It does not make the judge deterministic — the provider
        // can still return different text — but it removes the noise we can.
        temperature: 0,
        messages: [
          { role: "system", content: `${SYSTEM}\n\nRubric:\n${options.rubric}` },
          { role: "user", content: JSON.stringify(build(outcome, kase), null, 2) },
        ],
      };

      try {
        // Through the cassette: a recorded verdict at least replays the same.
        const response = await cassetteFetch(
          options.baseUrl ?? process.env.LLM_JUDGE_BASE_URL ?? DEFAULT_BASE_URL,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
              "x-title": "agent-evals",
            },
            body: JSON.stringify(body),
          },
        );

        if (!response.ok) {
          const detail = `HTTP ${response.status}`;
          return soft
            ? skip({ reason: `llm judge unavailable: ${detail}` })
            : fail({ reason: `llm judge failed: ${detail}` });
        }

        const data = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
          content?: { text?: string }[];
        };
        const text = data.choices?.[0]?.message?.content ?? data.content?.[0]?.text ?? "";
        const verdict = parseVerdict(text);

        if (!verdict) {
          return soft
            ? skip({ reason: `llm judge returned no usable verdict: ${text.slice(0, 80)}` })
            : fail({ reason: "llm judge returned no usable verdict" });
        }

        const ok = verdict.score >= threshold;
        return (ok ? pass : fail)({
          reason: verdict.reason || `${verdict.score.toFixed(2)} vs ${threshold}`,
          probability: verdict.score,
          value: verdict.score,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return soft
          ? skip({ reason: `llm judge unavailable: ${message}` })
          : fail({ reason: `llm judge failed: ${message}` });
      }
    },
  };
}
