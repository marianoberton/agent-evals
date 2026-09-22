import { outboundText } from "../core/normalize.js";
import { fail, pass } from "../core/score.js";
import type { Scorer } from "../core/types.js";
import type { ScorerOptions } from "./tools.js";

export interface TextOptions extends ScorerOptions {
  /** `"all"` (default) requires every needle; `"any"` requires at least one. */
  mode?: "all" | "any";
  /** Defaults to `false`: matching ignores case and diacritics. */
  caseSensitive?: boolean;
}

const asList = (v: string | readonly string[]): string[] =>
  Array.isArray(v) ? [...v] : [v as string];

/** Lowercase and strip diacritics so "descuento" matches "Descuentó". */
const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

const prepare = (s: string, caseSensitive: boolean): string => (caseSensitive ? s : fold(s));

/**
 * The reply must contain the needles. `mode: "all"` by default — the arity of a
 * list was undefined in the spec, and "all" is the assertion people mean when
 * they list several required phrases.
 */
export function contains(needles: string | readonly string[], options?: TextOptions): Scorer {
  const list = asList(needles);
  const mode = options?.mode ?? "all";
  const cs = options?.caseSensitive ?? false;
  return {
    id: options?.id ?? `contains:${list.join("|")}`,
    group: "contains",
    label: options?.id ?? "contains",
    kind: "deterministic",
    weight: options?.weight ?? 1,
    critical: options?.critical ?? false,
    score({ outcome }) {
      const haystack = prepare(outboundText(outcome), cs);
      const missing = list.filter((n) => !haystack.includes(prepare(n, cs)));
      const ok = mode === "all" ? missing.length === 0 : missing.length < list.length;
      return ok
        ? pass({ reason: `reply contains ${mode === "all" ? "all" : "one"} of ${list.join(", ")}` })
        : fail({ reason: `reply missing: ${missing.join(", ")}`, value: missing.join(",") });
    },
  };
}

/** None of the needles may appear. This is the "no promised discount" scorer. */
export function notContains(needles: string | readonly string[], options?: TextOptions): Scorer {
  const list = asList(needles);
  const cs = options?.caseSensitive ?? false;
  return {
    id: options?.id ?? `notContains:${list.join("|")}`,
    group: "notContains",
    label: options?.id ?? "notContains",
    kind: "deterministic",
    weight: options?.weight ?? 1,
    critical: options?.critical ?? false,
    score({ outcome }) {
      const haystack = prepare(outboundText(outcome), cs);
      const found = list.filter((n) => haystack.includes(prepare(n, cs)));
      return found.length === 0
        ? pass({ reason: `reply avoids ${list.join(", ")}` })
        : fail({ reason: `reply contains forbidden: ${found.join(", ")}`, value: found.join(",") });
    },
  };
}

export function matches(pattern: RegExp, options?: ScorerOptions): Scorer {
  return {
    id: options?.id ?? `matches:${pattern.source}`,
    group: "matches",
    label: options?.id ?? "matches",
    kind: "deterministic",
    weight: options?.weight ?? 1,
    critical: options?.critical ?? false,
    score({ outcome }) {
      // Fresh regex per call: a /g pattern carries lastIndex between cases otherwise.
      const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
      const text = outboundText(outcome);
      return re.test(text)
        ? pass({ reason: `reply matches /${pattern.source}/` })
        : fail({ reason: `reply does not match /${pattern.source}/` });
    },
  };
}

/** The reply must not be empty. Cheap, and catches a whole class of silent failures. */
export function replied(options?: ScorerOptions): Scorer {
  return {
    id: options?.id ?? "replied",
    kind: "deterministic",
    weight: options?.weight ?? 1,
    critical: options?.critical ?? false,
    score({ outcome }) {
      const text = outboundText(outcome).trim();
      return text.length > 0
        ? pass({ reason: `replied (${text.length} chars)`, value: text.length })
        : fail({ reason: "no outbound message", value: 0 });
    },
  };
}
