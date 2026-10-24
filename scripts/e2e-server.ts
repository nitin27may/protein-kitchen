import { spawn } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { e2eTarget } from "../tests/e2e/target";
import { prepareBrowserDatabase } from "../tests/e2e/setup";

const target = e2eTarget(process.env.POSTGRES_E2E_URL);
await prepareBrowserDatabase();
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: target.connectionString, DATABASE_URL_UNPOOLED: target.connectionString,
  DATABASE_ENV: "development", NODE_ENV: "development", NEXT_DIST_DIR: ".next-e2e",
  VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "", UPLOADS_DIR: path.resolve("test-results/uploads"),
  BETTER_AUTH_URL: "http://127.0.0.1:3112", BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  HOUSEHOLD_BOOTSTRAP_SECRET: "synthetic-browser-bootstrap-key-for-tests", AUTH_TEST_MAILBOX: "1", RESEND_API_KEY: "",
};
delete env.VERCEL_ENV;
const child = spawn("pnpm", ["dev", "--hostname", "127.0.0.1", "--port", "3112"], { env, stdio: "inherit" });
child.on("error", (error) => { console.error("Browser test server failed to start.", error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { child.kill(signal); });
