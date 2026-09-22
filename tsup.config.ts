import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/vitest/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // tsx must stay external: the CLI registers it at run time from the consumer's
  // node_modules, and a bundled copy cannot install module hooks for the host.
  // tsx and vitest stay external: tsx must load from the consumer's
  // node_modules to install module hooks, and vitest is an optional peer.
  external: ["tsx", "tsx/esm/api", "vitest"],
});
