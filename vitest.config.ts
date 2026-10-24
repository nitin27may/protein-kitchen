import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Each database worker owns Wasm Postgres instances.
    maxWorkers: 2,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["lib/**/*.ts", "app/**/*.ts", "components/**/*.tsx"],
      reporter: ["text-summary", "html", "json-summary"],
      thresholds: {
        "lib/server/plan-persistence.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
