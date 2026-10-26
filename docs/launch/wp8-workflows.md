# WP8: production and rehearsal workflows, preview retired

Stage record for CLAUDE.md. Part of "Launch: single production environment" in `docs/plan-v3-publish-and-protect.md`. This change writes workflow files, two small Vercel API tools and contract tests. It runs no workflow and contacts no remote service; every test uses fakes or recorded `gh` JSON.

## Scope

1. `.github/workflows/production.yml`: `gate` then `release` (the only deploy path).
2. `.github/workflows/rehearse-migration.yml`: `gate` then `rehearse`.
3. `lib/deployment/release-gate.ts` and `scripts/release-gate.ts` (`pnpm deploy:gate production|rehearsal`): the gate logic, testable and shared.
4. `lib/deployment/vercel-project.ts` (+ `scripts/vercel-env-manifest.ts`, `scripts/assert-vercel-protection.ts`) and `lib/deployment/vercel-release.ts` (+ `scripts/vercel-release.ts`): Vercel API reads.
5. `neon-snapshot.ts`: prune to the newest 4 before the new snapshot, to 5 after.
6. Preview removed: `preview.yml`, `migrate-preview.ts`, `seed-preview.ts`, `smoke-preview.ts`, `preview-preflight.ts`, `lib/deployment/preflight.ts`, `preview-migration.ts`, their tests, the preflight coverage gate and the `deploy:preflight`, `deploy:smoke:preview`, `db:migrate:preview`, `db:seed:preview` scripts. The mail sender still refuses `VERCEL_ENV=preview`.
7. New dev dependency `yaml` (exact `2.9.1`) so contract tests parse the workflows instead of grepping text.

## Permission boundaries

- Top-level `permissions: contents: read`. `gate` adds only `actions: read`, has no environment, and uses no secret or variable (`GH_TOKEN` is the job token).
- There is one GitHub environment, `production`, with required-reviewer approval and a main-only branch policy. Secrets exist only in the `release` and `rehearse` jobs (both use it) and are attached per step, not per job: `pnpm install`, `vercel build` and the other Vercel steps never see `DATABASE_URL*` or `NEON_API_KEY`; database steps never see `VERCEL_TOKEN`; only the smoke steps see `PRODUCTION_PROTECTION_BYPASS`. Job-level `env` holds variables only. Names only in the files.
- `release` and `rehearse` share the concurrency group `production` (`cancel-in-progress: false`), so a rehearsal and a release never overlap on the Neon branch limit. GitHub keeps one running and one pending run per group, so a third queued run replaces the pending one; re-dispatch if that happens.
- Every action is pinned to the full SHA already used in `ci.yml`. The Vercel CLI is installed as `vercel@63.1.2` (published 2026-10-09, more than two weeks before 2026-10-25; the registry's `latest` is 65.2.0 and `canary` 63.1.1).
- Checkouts use `persist-credentials: false`. No artifact is uploaded; the summary goes to `$GITHUB_STEP_SUMMARY` and holds ids and durations only. The repository is public.
- Vercel `pull` happens after every database step and its output is never sourced; cleanup removes `.vercel/.env*`, `.vercel/output` and the temporary files in an `if: always()` step.

## production.yml

Triggers: `workflow_run` of `ci` (completed, branch `main`) and `workflow_dispatch` (no inputs; releases current main HEAD). `gate` has a job-level `if` (`workflow_run.conclusion == 'success'` or manual), so a red or cancelled CI run on main skips quietly instead of showing a failed gate.

`gate` (5 min): chooses the SHA (`workflow_run.head_sha`, else `github.sha`); refuses unless the CI run concluded `success`, was a `push` and ran on `main` (manual runs must start from `refs/heads/main`); reports `superseded` and exits non-zero when `repos/<repo>/commits/main` is not that SHA; requires a successful push `ci.yml` run on main for that SHA whose `acceptance` job succeeded (job pages read with `gh api --paginate --slurp`); outputs `sha`.

`release` (30 min, `environment: production`, `concurrency: production`, no cancel): job env `DEPLOYMENT_ENVIRONMENT=production`, `DATABASE_ENV=production`, `APP_RELEASE_SHA`, plus the secrets and variables from the checklist. Step order:

1. checkout at the SHA, pnpm, Node 22, `pnpm install --frozen-lockfile`, pinned Vercel CLI
2. require settings (names only)
3. `pnpm deploy:manifest` writes `$RUNNER_TEMP/manifest.json` (name, type, target; a value only for `plain` variables)
4. `pnpm deploy:assert-protection`
5. `pnpm db:check:production --phase=pre-migrate --runtime-manifest=...`
6. `pnpm db:snapshot:production`, `pnpm db:migrate:postgres`, `pnpm seed`
7. `pnpm db:check:production --phase=pre-deploy --runtime-manifest=...`
8. `pnpm deploy:release previous` (previous production deployment id into the summary)
9. `vercel pull --yes --environment=production`, `vercel build --prod`, `vercel deploy --prebuilt --prod --skip-domain --json`
10. `pnpm deploy:release candidate` (READY and production target, exports `url` and `id`)
11. `pnpm deploy:smoke:production --stage=candidate`
12. `vercel promote <url> --yes`, `pnpm deploy:release wait-alias <id>` (succeeds when either the Aliases API or `/api/health` shows the new release; see below)
13. `pnpm deploy:smoke:production --stage=live`
14. summary, then the always-run cleanup

Note on steps 5 and 7: `BETTER_AUTH_SECRET` and `RESEND_API_KEY` exist only in Vercel, never in GitHub. With `--phase=... --runtime-manifest=...` the check runs the manifest check and then the normal phase checks, and the auth and mail configuration checks are satisfied from the manifest instead of the job environment: both secrets must be present and typed `sensitive`, `BETTER_AUTH_URL` must be a plain value equal to `PRODUCTION_ORIGIN`, and `AUTH_EMAIL_FROM` must be a plain bare address equal to the GitHub-side value. Database, Neon, ledger, schema, library, snapshot and host-pin checks are unchanged. Without `--runtime-manifest` (local or ad hoc runs) the process environment is still required to hold both secrets. `--runtime-manifest` alone, with no `--phase`, stays the local manifest-only check.

Anything that fails before step 12 leaves production serving the previous deployment. The database steps are expand-only, so the previous deployment keeps working against the migrated schema.

## rehearse-migration.yml

Trigger: `workflow_dispatch`, no inputs, started from `main`. It rehearses only the tip of main: `gate` applies the production gate (manual run on `refs/heads/main`, SHA still the tip of main, successful push CI plus `acceptance`). To rehearse a migration that is not merged yet, merge it to main first. A green main CI also starts `production.yml`; the required-reviewer approval on the `production` environment is what holds the release, and the rehearsal needs the same approval. `rehearse` (`production` environment, concurrency group `production`, 30 min, `DATABASE_ENV=development`, `NEON_API_KEY` only on the steps that call Neon): `db:rehearsal create`, `counts before`, check (pre-migrate), timed migrate, seed, check (pre-deploy), `counts after`, `compare`, and an always-run `db:rehearsal delete` plus temp-file removal.

## Acceptance cases

1. Contract tests (`tests/production-workflow.test.ts`, `tests/rehearse-workflow.test.ts`): triggers, gate isolation, release environment and concurrency, exact step order, pull after all database steps, SHA and CLI pinning, `persist-credentials: false`, always-run cleanup, no artifact, no echoed credentials.
2. Gate: replayed `gh` JSON for success, superseded, wrong event, wrong branch, wrong SHA, failed or missing CI, missing, failed or skipped `acceptance`, malformed JSON, a failing `gh`.
3. Vercel tools: fake `fetch`; fixed origin, redirects refused, secret values never written, errors value-free, protection fails closed on `all`, null and anything but the named constant.
4. Snapshot: with production plus five snapshots under a six-branch limit the run prunes first, then creates; a failed prune stops before creation.
5. `pnpm typecheck`, `pnpm lint`, `pnpm validate`, `pnpm test:coverage` pass. The three new `lib/deployment` files are gated at 100%.

## Gotchas and known issues

- Secrets are scoped per step. `vercel build` still holds `VERCEL_TOKEN` (it is passed as `--token`) but no database or Neon credential.
- A failed CI run on main still starts `production` but the gate job is skipped (no red run, no deploy).
- The snapshot name uses `GITHUB_SHA`, which on `workflow_run` is the tip of the default branch; the gate guarantees it equals the released SHA at gate time, but a push between the gate and the snapshot would make them differ (harmless: still a valid snapshot name, and the next run is superseded-checked).
- `rehearse-migration.yml` runs repository code with `NEON_API_KEY` in scope, so it rehearses only commits on main (no `ref` input). Keep reviewer approval and the main-only branch policy on `production`.
- Because there is one environment, a rehearsal approval is a `production` approval. Read the run title before approving.

## UNVERIFIED API assumptions (no remote contact was allowed)

- Vercel `ssoProtection.deploymentType` for Standard Protection is `all_except_custom_domains` (`STANDARD_PROTECTION_TYPE` in `vercel-project.ts`).
- `GET /v10/projects/{id}/env?decrypt=false` returns `{ envs: [{ key, type, value?, target }], pagination? }` and any `pagination.next` means more pages; `value` is present for `plain`.
- `teamId` is sent only when `VERCEL_ORG_ID` starts with `team_`.
- `GET /v6/deployments?projectId&target=production&state=READY&limit=1` lists `{ deployments: [{ uid }] }`; `GET /v13/deployments/{host-or-id}` returns `id`, `readyState`, `target` (its `alias[]` is not used for the alias wait, see the next item). These replace `vercel inspect --json`, whose output shape is also unverified.
- `wait-alias` accepts either of two independent proofs, polled every 5 s for up to 180 s, then fails with `VERCEL_ALIAS_TIMEOUT`. (1) `GET https://api.vercel.com/v4/aliases/{production host}?teamId=...` returns the alias record and its `deploymentId` equals the promoted deployment id (UNVERIFIED shape, from Vercel API reference knowledge only). (2) `GET {PRODUCTION_ORIGIN}/api/health` (public; returns only `ok`, `release`, `database`, `library`) reports a `release` equal to `APP_RELEASE_SHA`. A failed or malformed answer from either source counts as "not yet". Why: in the first real production run (`dpl_8rAZM5Y67P8g4G7heyVTN4QfcWtN`, READY, `aliasAssigned` true) the deployment object's `alias[]` held only `protein-kitchen-nitin27mays-projects.vercel.app`, not the production domain `protein-kitchen-tau.vercel.app`, so the earlier check timed out while the domain served the new release.
- `vercel deploy --json` prints `{ url }` or `{ deployment: { url } }`; `--skip-domain` and `vercel promote` exist in 63.1.2; `vercel build --prod` and `vercel pull` read `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` from the environment.
- `gh api --paginate --slurp` returns an array of pages (needs a `gh` that supports `--slurp`, 2.48 or later; the runner image has it).
- On `workflow_run`, `GITHUB_REF` is `refs/heads/main` (the default branch), which the production CI guard requires.
