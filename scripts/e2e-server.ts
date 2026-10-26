import { spawn } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { loadCandidates } from "../lib/photos/candidates";
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
  HOUSEHOLD_BOOTSTRAP_SECRET: "synthetic-browser-bootstrap-key-for-tests", HOUSEHOLD_OWNER_EMAIL: "ui-owner@example.test", PHOTO_CURATOR_EMAILS: "authorized-browser-fixture@example.test", AUTH_TEST_MAILBOX: "1", RESEND_API_KEY: "",
  BLOB_STORE: "filesystem", LEGACY_IMPORT_ENABLED: "true", STATE_SYNC_ENABLED: "true", STATE_SYNC_CLASSES: "saved-views",
  STATE_SYNC_HOUSEHOLD_ID: "00000000-0000-4000-8000-000000000001",
  STATE_GITHUB_APP_ID: String(state.appId), STATE_GITHUB_INSTALLATION_ID: String(state.installationId),
  STATE_GITHUB_REPOSITORY_ID: String(state.repositoryId), STATE_GITHUB_OWNER: state.owner,
  STATE_GITHUB_REPOSITORY: state.repository, STATE_GITHUB_BRANCH: state.branch, STATE_GITHUB_PRIVATE_KEY: state.privateKey,
  STATE_SYNC_TEST_GITHUB_URL: fixture.endpoint, STATE_SYNC_SCHEDULER_SECRET: controlSecret,
};
// The fixture directory replaces Wikimedia/Openverse only here: loopback protein_kitchen_e2e (checked by e2eTarget above),
// development environment, not Vercel. lib/photos/remote-seam.ts checks the same conditions again and throws otherwise.
// The directory is a per-run copy of tests/fixtures/photos so a browser test can edit it (remove a licence entry, add an image)
// without touching committed files. Every candidate in the real list gets a licence entry that matches what the list says,
// and images/default.jpg answers any image URL, so approving a real candidate works with no network. A test makes one fail
// by deleting its licence entry from this copy.
const photoFixtureDir = path.resolve(".next-e2e-fixture/photos");
await rm(photoFixtureDir, { recursive: true, force: true });
await cp(path.resolve("tests/fixtures/photos"), photoFixtureDir, { recursive: true });
await writeFile(path.join(photoFixtureDir, "images", "default.jpg"), await sharp({ create: { width: 800, height: 600, channels: 3, background: "#4a7c59" } }).jpeg().toBuffer());
const candidateList = loadCandidates(process.cwd());
await writeFile(path.join(photoFixtureDir, "licences.json"), JSON.stringify(Object.fromEntries(
  [...Object.values(candidateList.recipes), ...Object.values(candidateList.ingredients)].flat().map((c) => [c.key, c.provider === "commons" ? c.licence : "by"] as const),
), null, 1));
env.PHOTO_REMOTE_TEST_DIR = photoFixtureDir;
delete env.VERCEL_ENV;
delete env.VERCEL;
// The library photo manifest is kept in the Next data cache on disk for an hour; a stale copy from an earlier run names photos this database does not have.
await rm(path.resolve(".next-e2e/dev/cache/fetch-cache"), { recursive: true, force: true });
const child = spawn("pnpm", ["dev", "--hostname", "127.0.0.1", "--port", port], { env, stdio: "inherit" });
child.on("error", (error) => { console.error("Browser test server failed to start.", error); process.exitCode = 1; });
child.on("exit", async (code) => {
  process.exitCode = code ?? 1;
  await fixture.close(); await pushFixture.close(); await rm(controlPath, { force: true }); await rm(pushControlPath, { force: true });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { child.kill(signal); });
