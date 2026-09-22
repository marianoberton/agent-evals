import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  // tsx must stay external: the CLI registers it at run time from the consumer's
  // node_modules, and a bundled copy cannot install module hooks for the host.
  external: ["tsx", "tsx/esm/api"],
});
