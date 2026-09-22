import type { JevAnswer, JevQuestion } from "../core/types.js";
import { assertTokenBudget } from "./questions.js";

/**
 * Client for Jev (TypeSafe's System One model).
 *
 * Jev is not a chat model: it takes no `messages` and returns no prose. You give
 * it a `state` and a map of typed `questions`, and it returns calibrated answers.
 * A chat-completions SDK pointed at this endpoint will not work.
 *
 * Ported from a working Python client, including the parts that bite: the
 * retryable status set, `Retry-After` handling, the rate limiter, and the
 * `confidence`-missing fallback when reading a `choice`.
 */

export const DEFAULTS = {
  /** OpenRouter's Decisions endpoint. TypeSafe's own is https://api.typesafe.ai/v1/systemone. */
  baseUrl: "https://openrouter.ai/api/alpha/decisions",
  model: "typesafe/jev-1.13",
  /** Jev bills input tokens only; output is free. */
  inputPricePerMtok: 0.042,
  maxRps: 15,
  maxRetries: 5,
  timeoutMs: 45_000,
} as const;

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export class JevError extends Error {
  override name = "JevError";
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export interface JevClientOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Restrict routing to zero-retention providers. On by default. */
  zdr?: boolean;
  maxRps?: number;
  maxRetries?: number;
  timeoutMs?: number;
  inputPricePerMtok?: number;
  /** Injected so every call can go through a cassette. */
  fetch?: typeof globalThis.fetch;
  /** Injected so backoff is reproducible in tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface JevUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** One request per `1/maxRps` seconds, shared across concurrent callers. */
class RateLimiter {
  private readonly interval: number;
  private next = 0;
  constructor(
    maxRps: number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.interval = maxRps > 0 ? 1000 / maxRps : 0;
  }
  async acquire(): Promise<void> {
    if (this.interval <= 0) return;
    const now = Date.now();
    const wait = this.next - now;
    this.next = Math.max(now, this.next) + this.interval;
    if (wait > 0) await this.sleep(wait);
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class JevClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly zdr: boolean;
  readonly inputPricePerMtok: number;
  readonly usage: JevUsage = { requests: 0, inputTokens: 0, outputTokens: 0 };

  private readonly apiKey: string | undefined;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly limiter: RateLimiter;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: JevClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.JEV_BASE_URL ?? DEFAULTS.baseUrl;
    this.model = options.model ?? process.env.JEV_MODEL ?? DEFAULTS.model;
    this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.TYPESAFE_API_KEY;
    this.zdr = options.zdr ?? process.env.JEV_ZDR !== "false";
    this.inputPricePerMtok = options.inputPricePerMtok ?? DEFAULTS.inputPricePerMtok;
    this.maxRetries = options.maxRetries ?? DEFAULTS.maxRetries;
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.limiter = new RateLimiter(options.maxRps ?? DEFAULTS.maxRps, this.sleep);
    this.doFetch = options.fetch ?? globalThis.fetch;
  }

  get costUsd(): number {
    return (this.usage.inputTokens / 1_000_000) * this.inputPricePerMtok;
  }

  /**
   * One decision. Every question is scored independently against the state, so
   * batching many questions into one call changes no answer — it only makes the
   * call cheaper and faster, because the state is sent once instead of N times.
   */
  async decide(
    state: unknown,
    questions: Readonly<Record<string, JevQuestion>>,
    options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
  ): Promise<Record<string, JevAnswer>> {
    assertTokenBudget(state, questions);

    const body: Record<string, unknown> = { model: this.model, state, questions };
    if (this.zdr) body.zdr = true;

    const doFetch = options.fetch ?? this.doFetch;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      await this.limiter.acquire();

      let response: Response;
      try {
        response = await doFetch(this.baseUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
            "x-title": "agent-evals",
          },
          body: JSON.stringify(body),
          signal: options.signal ?? AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await this.backoff(attempt);
        continue;
      }

      if (RETRYABLE.has(response.status)) {
        lastError = new JevError(
          `HTTP ${response.status}: ${(await safeText(response)).slice(0, 300)}`,
          response.status,
        );
        await this.backoff(attempt, response.headers.get("retry-after"));
        continue;
      }

      if (!response.ok) {
        throw new JevError(
          `HTTP ${response.status}: ${(await safeText(response)).slice(0, 500)}`,
          response.status,
        );
      }

      const data = (await response.json()) as JevResponse;
      if (!data || typeof data !== "object" || !data.answers) {
        throw new JevError(`response has no "answers": ${JSON.stringify(data).slice(0, 300)}`);
      }

      this.usage.requests += 1;
      this.usage.inputTokens += data.usage?.input_tokens ?? 0;
      this.usage.outputTokens += data.usage?.output_tokens ?? 0;
      return data.answers;
    }

    throw new JevError(`Jev failed after ${this.maxRetries} attempts: ${lastError?.message}`);
  }

  private async backoff(attempt: number, retryAfter?: string | null): Promise<void> {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) {
        await this.sleep(Math.min(seconds, 30) * 1000);
        return;
      }
    }
    await this.sleep(Math.min(2 ** attempt, 16) * (0.5 + this.random()) * 1000);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable body>";
  }
}

/* ── Readers ───────────────────────────────────────────────────────────── */

/** Probability that the answer is yes. */
export function readNoul(answer: JevAnswer | undefined, fallback = 0): number {
  const v = answer?.noul;
  return typeof v === "number" ? v : fallback;
}

/**
 * The picked option and how confident the model is in it.
 *
 * `confidence` is sometimes absent; the probability of the picked option is the
 * right stand-in, and is what the reference client uses.
 */
export function readChoice(
  answer: JevAnswer | undefined,
  fallback = "",
): { choice: string; confidence: number; probabilities?: Readonly<Record<string, number>> } {
  const picked = answer?.choice ?? fallback;
  let confidence = answer?.confidence;
  if (typeof confidence !== "number") confidence = answer?.probabilities?.[picked] ?? 0;
  const probabilities = answer?.probabilities;
  return probabilities
    ? { choice: picked, confidence, probabilities }
    : { choice: picked, confidence };
}

/** Position on the scale — a weighted average, so it may land between levels. */
export function readScore(
  answer: JevAnswer | undefined,
  fallback = 0,
): { score: number; confidence: number; probabilities?: Readonly<Record<string, number>> } {
  const value = typeof answer?.score === "number" ? answer.score : fallback;
  const confidence = typeof answer?.confidence === "number" ? answer.confidence : 0;
  const probabilities = answer?.probabilities;
  return probabilities ? { score: value, confidence, probabilities } : { score: value, confidence };
}
