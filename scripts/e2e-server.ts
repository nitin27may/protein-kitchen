import { spawn } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { e2eTarget } from "../tests/e2e/target";
import { prepareBrowserDatabase } from "../tests/e2e/setup";
import { fixtureConfiguration as state, githubFixture } from "../tests/helpers/github-state";
import { pushProvider } from "../tests/helpers/push-provider";
import webpush from "web-push";

/** Parallel worktrees can run browser tests side by side by choosing different ports. */
const port = process.env.E2E_PORT ?? "3112";
const target = e2eTarget(process.env.POSTGRES_E2E_URL);
await prepareBrowserDatabase();
const fixture = githubFixture(Date.now);
fixture.reset();
const controlSecret = randomBytes(32).toString("base64url");
const pushSecret = randomBytes(32).toString("base64url");
const reminderSecret = randomBytes(32).toString("base64url");
const pushFixture = await pushProvider(pushSecret);
const vapid = webpush.generateVAPIDKeys();
let failStateRequests = false;
const control = (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown> | undefined): boolean => {
    if (request.url === "/__browser_control") {
      if (request.method !== "POST" || request.headers.authorization !== `Bearer ${controlSecret}`) { fixture.json(response, {}, 401); return true; }
      if (body?.mode === "reset") { fixture.reset(); fixture.intercept = control; failStateRequests = false; }
      else if (body?.mode === "failure") failStateRequests = true;
      else if (body?.mode === "healthy") failStateRequests = false;
      else if (body?.mode === "conflict") fixture.edit({ "protein-kitchen/manifest.json": "Synthetic out-of-band edit" });
      else { fixture.json(response, {}, 400); return true; }
      fixture.json(response, { head: fixture.head }); return true;
    }
    if (failStateRequests) { fixture.json(response, {}, 503); return true; }
    return false;
  };
fixture.intercept = control;
await fixture.start();
const controlPath = path.resolve(".next-e2e-fixture/state-sync.json");
await mkdir(path.dirname(controlPath), { recursive: true });
await writeFile(controlPath, JSON.stringify({ endpoint: fixture.endpoint, secret: controlSecret }), { mode: 0o600 });
const pushControlPath = path.resolve(".next-e2e-fixture/reminders.json");
await writeFile(pushControlPath, JSON.stringify({ endpoint: pushFixture.endpoint, secret: pushSecret, schedulerSecret: reminderSecret }), { mode: 0o600 });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: target.connectionString, DATABASE_URL_UNPOOLED: target.connectionString,
  DATABASE_ENV: "development", NODE_ENV: "development", NEXT_DIST_DIR: ".next-e2e",
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, UPLOADS_DIR: path.resolve("test-results/uploads"),
  VAPID_SUBJECT: "mailto:synthetic@example.test", REMINDER_SCHEDULER_ENABLED: "true", REMINDER_SCHEDULER_SECRET: reminderSecret,
  REMINDER_TEST_PUSH_URL: pushFixture.endpoint, REMINDER_TEST_PUSH_SECRET: pushSecret, APP_TZ: "UTC",
  BETTER_AUTH_URL: `http://127.0.0.1:${port}`, BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  HOUSEHOLD_BOOTSTRAP_SECRET: "synthetic-browser-bootstrap-key-for-tests", AUTH_TEST_MAILBOX: "1", RESEND_API_KEY: "",
  BLOB_STORE: "filesystem", STATE_SYNC_ENABLED: "true", STATE_SYNC_CLASSES: "saved-views",
  STATE_SYNC_HOUSEHOLD_ID: "00000000-0000-4000-8000-000000000001",
  STATE_GITHUB_APP_ID: String(state.appId), STATE_GITHUB_INSTALLATION_ID: String(state.installationId),
  STATE_GITHUB_REPOSITORY_ID: String(state.repositoryId), STATE_GITHUB_OWNER: state.owner,
  STATE_GITHUB_REPOSITORY: state.repository, STATE_GITHUB_BRANCH: state.branch, STATE_GITHUB_PRIVATE_KEY: state.privateKey,
  STATE_SYNC_TEST_GITHUB_URL: fixture.endpoint, STATE_SYNC_SCHEDULER_SECRET: controlSecret,
};
delete env.VERCEL_ENV;
delete env.VERCEL;
const child = spawn("pnpm", ["dev", "--hostname", "127.0.0.1", "--port", port], { env, stdio: "inherit" });
child.on("error", (error) => { console.error("Browser test server failed to start.", error); process.exitCode = 1; });
child.on("exit", async (code) => {
  process.exitCode = code ?? 1;
  await fixture.close(); await pushFixture.close(); await rm(controlPath, { force: true }); await rm(pushControlPath, { force: true });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { child.kill(signal); });
