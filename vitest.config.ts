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
        "lib/auth/account-deletion.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/auth/config.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/auth/signup.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/auth/tokens.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/auth/mail.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/auth/server.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/auth/test-mail.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/auth/create.ts": { statements: 95, branches: 90, functions: 100, lines: 95 },
        "lib/auth/access.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/auth/browser.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "app/onboarding/actions.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/schemas/person.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "app/api/auth/**/route.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/server/plan-persistence.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/server/plan-access.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/server/subscriptions.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/auth/response.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/human/personal-feedback.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/server/feedback.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "lib/server/account-export.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "app/api/account/export/route.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
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
