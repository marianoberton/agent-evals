import { outboundText } from "../core/normalize.js";
import { fail, pass } from "../core/score.js";
import type { ArgsSchema, Scorer } from "../core/types.js";
import type { ScorerOptions } from "./tools.js";

export interface SchemaOptions extends ScorerOptions {
  /** `"json"` (default) parses the reply as JSON first; `"raw"` passes the string through. */
  parse?: "json" | "raw";
}

/**
 * The outbound message must satisfy a schema — for agents whose reply is
 * structured output rather than prose. Any object with a throwing `parse` works,
 * so a zod schema drops straight in.
 */
export function schema(shape: ArgsSchema, options?: SchemaOptions): Scorer {
  const mode = options?.parse ?? "json";
  return {
    id: options?.id ?? "schema",
    kind: "deterministic",
    weight: options?.weight ?? 1,
    critical: options?.critical ?? false,
    score({ outcome }) {
      const text = outboundText(outcome);
      let value: unknown = text;
      if (mode === "json") {
        try {
          value = JSON.parse(text);
        } catch {
          return fail({ reason: "reply is not valid JSON" });
        }
      }
      try {
        shape.parse(value);
        return pass({ reason: "reply matches schema" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return fail({ reason: `schema rejected reply: ${message.split("\n")[0]}` });
      }
    },
  };
}
