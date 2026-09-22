import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/cli.ts", "src/**/index.ts"],
      thresholds: {
        "src/scorers/**": { lines: 90, functions: 90, statements: 90, branches: 80 },
      },
    },
  },
});
