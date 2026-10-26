import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    ".next-build/**",
    ".next-e2e/**",
    ".next-*/**",
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "next-env.d.ts",
    "db/**",
    "backups/**",
    "uploads/**",
    "node_modules/**",
  ]),
  {
    rules: {
      // rules-of-hooks and exhaustive-deps stay at the error level from
      // eslint-config-next. The React Compiler rules below are new in
      // eslint-plugin-react-hooks 6+ and flag existing, working patterns.
      // Off for now so the first lint run is signal, not noise; enable them
      // later once the code is migrated.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
    },
  },
  {
    // Existing disable comments (tests/reset.test.ts) would otherwise warn
    // while the rules below are off. Remove this with the TODO.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  {
    // TODO(lint): first-run findings, switched off so the gate can land as
    // config only. Counts are from the first run; fix per rule, then re-enable.
    rules: {
      "react-hooks/error-boundaries": "off", // 4 (React Compiler rule)
      "@next/next/no-img-element": "off", // 9
      "react/no-unescaped-entities": "off", // 9
      "@next/next/no-html-link-for-pages": "off", // 1
      "@typescript-eslint/no-unused-vars": "off", // 14
      "@typescript-eslint/no-explicit-any": "off", // 5 (scripts/photo-candidates.ts)
      "import/no-anonymous-default-export": "off", // 1 (postcss.config.mjs)
    },
  },
  {
    // Playwright fixtures name their callback `use`, which the hooks rule
    // mistakes for React's `use`.
    files: ["tests/e2e/**"],
    rules: { "react-hooks/rules-of-hooks": "off" },
  },
]);
