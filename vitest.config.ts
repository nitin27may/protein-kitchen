import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
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
        "lib/auth/household.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/server/plan-persistence.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/db/sqlite-snapshot.ts": { statements: 95, branches: 95, functions: 100, lines: 100 },
        "lib/human/sqlite-restore.ts": { statements: 95, branches: 95, functions: 100, lines: 100 },
        "lib/db/postgres/import-target.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/db/postgres/verify-branch.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/db/postgres/verified-client.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/server/context.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
      },
    },
  },
});
