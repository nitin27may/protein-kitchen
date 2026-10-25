import { defineConfig, devices } from "@playwright/test";
import { e2eTarget } from "./tests/e2e/target";

e2eTarget(process.env.POSTGRES_E2E_URL);
const port = process.env.E2E_PORT ?? "3112";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./tests/e2e/setup.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure", screenshot: "only-on-failure",
  },
  projects: [{ name: "phone-chromium", use: { ...devices["Pixel 7"] } }],
  webServer: {
    command: "pnpm exec tsx scripts/e2e-server.ts",
    url: `http://127.0.0.1:${port}/recipes`, timeout: 120_000, reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
});
