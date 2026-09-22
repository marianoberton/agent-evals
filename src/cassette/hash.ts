import { createHash } from "node:crypto";

/**
 * Sorts object keys so two semantically identical requests hash the same.
 * Arrays keep their order on purpose: a `score` question's `criteria` is an
 * ordered scale, and reordering it is a different question.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = canonicalize(obj[key]);
    return out;
  }
  return value;
}

export interface RequestKey {
  method: string;
  url: string;
  body: unknown;
}

/**
 * The cassette key.
 *
 * Method, URL and the full body go in; headers never do. Changing a prompt, a
 * question's wording, the model or the state **invalidates on purpose** — that
 * is the feature. Including the URL means switching gateway re-records too,
 * which is also on purpose: a different provider is a different recording.
 */
export function hashRequest(key: RequestKey): string {
  const json = JSON.stringify(canonicalize(key));
  return `sha256:${createHash("sha256").update(json).digest("hex").slice(0, 32)}`;
}

const RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/**
 * A filesystem-safe name for a case id.
 *
 * When the slug is not byte-identical to the id — accents, spaces, punctuation,
 * a reserved win32 device name — a short hash is appended, so `¿Corolla?` and
 * `Corolla` can never collide silently.
 */
export function slugify(id: string): string {
  const base = id
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const safe = base.length > 0 && !RESERVED.has(base) ? base : "case";
  if (safe === id) return safe;
  const suffix = createHash("sha256").update(id).digest("hex").slice(0, 6);
  return `${safe}-${suffix}`;
}
