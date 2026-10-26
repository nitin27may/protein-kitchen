# WP4: Neon snapshot, rehearsal branch and runtime manifest tools

Stage record for CLAUDE.md. Part of the launch stage in `docs/plan-v3-publish-and-protect.md` ("Launch: single production environment"). This PR adds tools and tests only. It adds no workflow and contacts no remote service; every test uses a fake `fetch`.

## Scope

1. `lib/deployment/neon-admin.ts`: write-capable Neon control-plane client, separate from the GET-only `neonHttpControlPlane`.
2. `pnpm db:snapshot:production` (`scripts/neon-snapshot.ts`): `pre-deploy-<YYYYMMDDTHHMMSSZ>-<sha7>` snapshot branch.
3. `pnpm db:rehearsal create|delete|counts|compare` (`scripts/rehearsal-branch.ts`): disposable `rehearse-<sha7>-<run>` branch and human-owned row counts.
4. `pnpm db:check:production --target=rehearsal` and `--runtime-manifest=<file>`.

## Dependencies

- Production guards on `main` (`requireProductionCiContext`, `productionPins`, `verifyNonProductionBranch`).
- The deploy and `rehearse-migration.yml` workflows (separate PRs) call these commands. Nothing here runs by itself.
- A Neon API key reaches the tools only as `NEON_API_KEY` in the job environment.

## Permission boundaries

- `neon-admin.ts` is the only write path to Neon. Origin is fixed to `https://console.neon.tech/api/v2`, redirects are an error, every request has a timeout, and no error carries a response body, URL, header or credential. A plan-limit response is recognised from the body but never copied.
- Deletes are refused unless the live branch name starts with an allowed prefix (`rehearse-` or `pre-deploy-`) and the branch is not default, primary or protected. This is checked inside the client, so no caller can skip it. Protected-branch support on the free plan is unverified and nothing depends on it.
- `db:snapshot:production` runs only in the approved production CI context (main branch, GitHub Actions, `DEPLOYMENT_ENVIRONMENT=production`, not Vercel). The check runs before any request.
- `db:rehearsal` runs only when `GITHUB_ACTIONS=true`. `counts` and `delete` first load the branch named by `NEON_DEVELOPMENT_BRANCH_ID` and refuse unless its name starts with `rehearse-` and it is not production.
- Counts are row counts of human-owned tables read in a read-only transaction. No row, column value or data-derived string is read or printed. The tools never write human-owned data.
- Output is names, ids, counts and stable codes. Connection URIs are masked with `::add-mask::` (URI and password) before anything else happens and are written only to `$GITHUB_ENV` (`DATABASE_URL_UNPOOLED`) with the host and branch id.

## Behaviour

### Snapshot

- Parent is `NEON_PRODUCTION_BRANCH_ID`, no compute endpoint, `expires_at` = now + `SNAPSHOT_RETENTION_DAYS` (default 7, allowed 1 to 30).
- Waits for the create operations to finish and the branch to be `ready`, then prunes `pre-deploy-*` branches whose name matches the exact pattern, keeping the newest 5 (by creation time). Other branches are never listed for deletion.
- Prints `snapshot <name> <id>`.
- Free plan: if creation hits a branch or storage limit the run exits 1 with `NEON_ADMIN_LIMIT` and a message naming no value. If any prune delete fails the run exits 1 with `NEON_ADMIN_PRUNE_FAILED` after trying all of them. Neither is ever skipped.
- Gotcha: the prune runs after the create, so the project briefly holds 6 snapshots plus production and any rehearsal branch. If the plan limit is tight, creation fails loudly rather than silently pruning first. Delete stale branches in the console, then rerun.

### Rehearsal branch

- `create`: child of production, `read_write` endpoint, 24 hour expiry. Fetches fresh pooled and direct URIs through the API (a child of a protected branch gets new passwords), checks they belong to one endpoint, masks them, then writes `DATABASE_URL_UNPOOLED`, `DATABASE_NONPRODUCTION_HOST` and `NEON_DEVELOPMENT_BRANCH_ID` to `$GITHUB_ENV`. Needs `NEON_DATABASE_NAME` and `NEON_ROLE_NAME`.
- `delete`: deletes the branch in `NEON_DEVELOPMENT_BRANCH_ID`; a branch that is already gone is reported as `absent`, so an `if: always()` cleanup does not fail.
- `counts <file>`: verifies the target with `verifyNonProductionBranch`, then writes `{table: count|null}` for the tables in `HUMAN_OWNED_TABLES` (`lib/deployment/human-counts.ts`, one name per line). `null` means the table does not exist yet.
- `compare <before> <after>`: exits 1 with `COUNTS_LOST tables=<names>` if any table that existed before has fewer rows or is gone. New tables and growth pass.

### check-production

- `--target=rehearsal`: development-target rules (`DATABASE_ENV=development`, `DATABASE_URL_UNPOOLED`, `DATABASE_NONPRODUCTION_HOST`, pins), live `verifyNonProductionBranch`, then ledger, schema and library checks. Auth, mail and snapshot checks are skipped.
- `--runtime-manifest=<file>`: local file only, no network or database. Accepts a JSON array or `{ "envs": [...] }` of `{ key, type, value?, target? }` (the Vercel project env shape). Entries not targeting `production` are ignored; a value is read only when `type` is `plain`. Checks:
  - Required names present: sensitive `DATABASE_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SIGNUP_ALLOWLIST` (and not stored as plain); plain `DATABASE_ENV`, `DATABASE_PRODUCTION_HOST`, `NEON_PROJECT_ID`, `NEON_PRODUCTION_BRANCH_ID`, `BETTER_AUTH_URL`, `AUTH_EMAIL_FROM`, `BLOB_STORE`, `BLOB_BUCKET`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `APP_TZ`, `MAIL_DAILY_CAP`.
  - Forbidden names absent: the existing forbidden list, `DATABASE_URL_UNPOOLED`, `NEON_API_KEY`, `DEPLOYMENT_ENVIRONMENT`, and anything starting `VAPID_`, `STATE_` or `VAULT_` except the flags.
  - `RUNTIME_OFF_FLAGS` (one name per line in `check-production.ts`) must each be the plain value `false`; a hidden value counts as failing.
  - Plain values equal the GitHub-side values: `BETTER_AUTH_URL` (as an origin) with `PRODUCTION_ORIGIN`, `DATABASE_PRODUCTION_HOST`, `NEON_PROJECT_ID`, `NEON_PRODUCTION_BRANCH_ID`, `AUTH_EMAIL_FROM`, and `DATABASE_ENV=production`. `BLOB_STORE` and `BLOB_BUCKET` are compared when the GitHub side carries them (the owner checklist lists no GitHub variable for them, so they are otherwise only required to exist).
  - This removes the need to copy `BETTER_AUTH_SECRET` or `RESEND_API_KEY` into GitHub. Output carries variable names only.

## Acceptance cases

1. Snapshot: name format, no endpoint in the create request, expiry from `SNAPSHOT_RETENTION_DAYS`, ready wait, prune keeps the newest 5 and touches only `pre-deploy-<stamp>-<sha7>` names.
2. Snapshot refused outside the production CI context and with bad pins, retention or SHA, with no request made.
3. Limit hit on create: exit 1, `NEON_ADMIN_LIMIT`, no value in the message. Failed prune delete: exit 1.
4. Rehearsal create sends a `read_write` endpoint and 24 hour expiry, fetches both URIs, masks them before export, exports exactly three variables, and rejects URIs that do not share one endpoint.
5. Delete refused for production, a non-`rehearse-` name, and default, primary or protected branches, with no DELETE sent. An absent branch is not an error.
6. Rehearsal commands refused outside GitHub Actions (also tested through the real scripts).
7. Counts are read in a read-only transaction; compare fails when any table lost rows or vanished.
8. Manifest check: every required, secret, forbidden, flag and equality case above passes and fails as described, and no value appears in output.
9. `pnpm typecheck`, `pnpm lint`, `pnpm validate`, `pnpm build`, `pnpm test:coverage` pass. New files are gated at 100% in `vitest.config.ts`.

## Known issues

- Neon's exact error body for a branch or storage limit is not verified. The client treats HTTP 402, or HTTP 406, 409 or 422 on create whose body mentions limit, exceed, quota, maximum or too many, as a limit. An unrecognised limit response still fails the run, as `NEON_ADMIN_HTTP` with the status code.
- Branch listing is not paginated; the free plan has too few branches for that to matter.
- Whether the free plan supports protected branches is unverified; nothing here depends on it.
