import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashRequest, slugify } from "./hash.js";

/** Whatever this Node's `fetch` accepts — avoids naming lib-specific DOM types. */
type FetchArgs = Parameters<typeof globalThis.fetch>;

export type CassetteMode = "auto" | "replay" | "record" | "rerecord" | "passthrough";

export interface CassetteOptions {
  /** Default `evals/__cassettes__`. */
  dir?: string;
  /** Default: `replay` under CI, `auto` everywhere else. */
  mode?: CassetteMode;
  /** Extra response headers to keep. `content-type` is always kept. */
  keepHeaders?: readonly string[];
}

export interface Interaction {
  seq: number;
  key: string;
  request: { method: string; url: string; body: unknown };
  response: { status: number; headers: Record<string, string>; body: unknown };
  timing: { durationMs: number };
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
}

interface CassetteFile {
  version: 1;
  suite: string;
  case: string;
  recordedAt: string;
  interactions: Interaction[];
}

export class CassetteMissError extends Error {
  override name = "CassetteMissError";
  constructor(url: string, key: string, file: string, suite: string) {
    super(
      `No recording for ${url}\n` +
        `  key:  ${key}\n` +
        `  file: ${file}\n` +
        `  Run: agent-evals record ${suite}`,
    );
  }
}

const REDACT_HEADERS = new Set(["authorization", "x-api-key", "api-key", "cookie", "set-cookie"]);
const SECRET = /\b(sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+)/g;

/** Never write a key into a file that gets committed. */
function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET, "[redacted]");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_HEADERS.has(k.toLowerCase()) ? "[redacted]" : redact(v);
    }
    return out;
  }
  return value;
}

async function parseBody(source: Request | Response): Promise<unknown> {
  const text = await source.clone().text();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * One case's tape.
 *
 * Its `fetch` is what the agent (and the Jev client) call. In replay it serves
 * recorded responses and never touches the network; in record it calls through
 * and appends. Either way it accumulates the **recorded** latency, tokens and
 * cost for the case, which is what lets budget scorers stay meaningful under
 * replay instead of measuring a near-zero wall clock.
 */
export class Cassette {
  readonly fetch: typeof globalThis.fetch;

  private readonly cursors = new Map<string, number>();
  private readonly recorded: Interaction[] = [];
  private dirty = false;

  replayedMs = 0;
  costUsd = 0;
  tokens: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };
  hits = 0;
  misses = 0;

  constructor(
    private readonly suite: string,
    private readonly caseId: string,
    private readonly file: string,
    private readonly mode: CassetteMode,
    private existing: Interaction[],
    private readonly realFetch: typeof globalThis.fetch,
  ) {
    if (mode === "rerecord") this.existing = [];
    this.fetch = this.intercept.bind(this) as typeof globalThis.fetch;
  }

  get usedNetwork(): boolean {
    return this.misses > 0;
  }

  private async intercept(...args: FetchArgs): Promise<Response> {
    if (this.mode === "passthrough") return this.realFetch(...args);

    const request = new Request(...args);
    const body = await parseBody(request);
    const key = hashRequest({ method: request.method, url: request.url, body });

    const played = this.take(key);
    if (played) {
      this.hits += 1;
      this.replayedMs += played.timing.durationMs;
      this.costUsd += played.usage?.costUsd ?? 0;
      this.tokens.inputTokens += played.usage?.inputTokens ?? 0;
      this.tokens.outputTokens += played.usage?.outputTokens ?? 0;
      return toResponse(played);
    }

    if (this.mode === "replay") {
      throw new CassetteMissError(request.url, key, this.file, this.suite);
    }

    this.misses += 1;
    const started = Date.now();
    const response = await this.realFetch(request);
    const durationMs = Date.now() - started;
    const responseBody = await parseBody(response);

    const usage = extractUsage(responseBody);
    this.replayedMs += durationMs;
    this.costUsd += usage?.costUsd ?? 0;
    this.tokens.inputTokens += usage?.inputTokens ?? 0;
    this.tokens.outputTokens += usage?.outputTokens ?? 0;

    const interaction: Interaction = {
      seq: this.recorded.length + this.existing.length,
      key,
      request: {
        method: request.method,
        url: request.url,
        body: redact(body),
      },
      response: {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
        body: redact(responseBody),
      },
      timing: { durationMs },
      ...(usage ? { usage } : {}),
    };
    this.recorded.push(interaction);
    this.dirty = true;
    return toResponse(interaction);
  }

  /** The Nth identical request in a case replays the Nth recorded response. */
  private take(key: string): Interaction | undefined {
    const matches = this.existing.filter((i) => i.key === key);
    if (matches.length === 0) return undefined;
    const used = this.cursors.get(key) ?? 0;
    const pick = matches[Math.min(used, matches.length - 1)];
    this.cursors.set(key, used + 1);
    return pick;
  }

  /** `keep: false` discards a partial tape — a crash must never half-record. */
  close(keep: boolean): void {
    if (!keep || !this.dirty) return;
    const merged = [...this.existing, ...this.recorded].map((i, seq) => ({ ...i, seq }));
    const file: CassetteFile = {
      version: 1,
      suite: this.suite,
      case: this.caseId,
      recordedAt: new Date().toISOString(),
      interactions: merged,
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmp, this.file);
  }
}

function toResponse(interaction: Interaction): Response {
  const { status, headers, body } = interaction.response;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(body === null ? null : text, { status, headers });
}

/** Pulls usage out of the provider shapes we know, so budgets survive replay. */
function extractUsage(
  body: unknown,
): { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const usage = (body as { usage?: Record<string, unknown> }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = usage[k];
      if (typeof v === "number") return v;
    }
    return undefined;
  };
  const inputTokens = num("input_tokens", "inputTokens", "prompt_tokens");
  const outputTokens = num("output_tokens", "outputTokens", "completion_tokens");
  const costUsd = num("cost", "costUsd", "total_cost");
  if (inputTokens === undefined && outputTokens === undefined && costUsd === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

export class CassetteStore {
  readonly mode: CassetteMode;
  private readonly dir: string;
  private readonly open: Cassette[] = [];

  constructor(
    private readonly suite: string,
    options: CassetteOptions = {},
    private readonly realFetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    this.dir = resolve(options.dir ?? "evals/__cassettes__", slugify(suite));
    // CI is forced to replay: it must never spend money, and a partial tape
    // silently hitting the network would break "the same report twice".
    this.mode = options.mode ?? (process.env.CI ? "replay" : "auto");
  }

  openCase(caseId: string): Cassette {
    const file = join(this.dir, `${slugify(caseId)}.json`);
    let existing: Interaction[] = [];
    let fileExists = false;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as CassetteFile;
      existing = parsed.interactions ?? [];
      fileExists = true;
    } catch {
      existing = [];
    }
    // `auto` means: replay strictly when a tape exists, record when none does.
    const mode: CassetteMode =
      this.mode === "auto" ? (fileExists ? "replay" : "record") : this.mode;
    const cassette = new Cassette(this.suite, caseId, file, mode, existing, this.realFetch);
    this.open.push(cassette);
    return cassette;
  }

  get hits(): number {
    return this.open.reduce((n, c) => n + c.hits, 0);
  }
  get misses(): number {
    return this.open.reduce((n, c) => n + c.misses, 0);
  }
}
