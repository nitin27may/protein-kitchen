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
- Secrets exist only in the `release` job (`production` environment) and the `rehearse` job (`production-rehearsal`). Names only in the files.
- Every action is pinned to the full SHA already used in `ci.yml`. The Vercel CLI is installed as `vercel@63.1.2` (published 2026-10-09, more than two weeks before 2026-10-25; the registry's `latest` is 65.2.0 and `canary` 63.1.1).
- Checkouts use `persist-credentials: false`. No artifact is uploaded; the summary goes to `$GITHUB_STEP_SUMMARY` and holds ids and durations only. The repository is public.
- Vercel `pull` happens after every database step and its output is never sourced; cleanup removes `.vercel/.env*`, `.vercel/output` and the temporary files in an `if: always()` step.

## production.yml

Triggers: `workflow_run` of `ci` (completed, branch `main`) and `workflow_dispatch` (no inputs; releases current main HEAD).

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
12. `vercel promote <url> --yes`, `pnpm deploy:release wait-alias <id>`
13. `pnpm deploy:smoke:production --stage=live`
14. summary, then the always-run cleanup

Anything that fails before step 12 leaves production serving the previous deployment. The database steps are expand-only, so the previous deployment keeps working against the migrated schema.

## rehearse-migration.yml

Trigger: `workflow_dispatch` with `ref` (default `main`). `gate` resolves the ref to a SHA and requires the same push CI plus `acceptance` (any branch). `rehearse` (`production-rehearsal`, concurrency `rehearsal`, 30 min, `DATABASE_ENV=development`): `db:rehearsal create`, `counts before`, check (pre-migrate), timed migrate, seed, check (pre-deploy), `counts after`, `compare`, and an always-run `db:rehearsal delete` plus temp-file removal.

## Acceptance cases

1. Contract tests (`tests/production-workflow.test.ts`, `tests/rehearse-workflow.test.ts`): triggers, gate isolation, release environment and concurrency, exact step order, pull after all database steps, SHA and CLI pinning, `persist-credentials: false`, always-run cleanup, no artifact, no echoed credentials.
2. Gate: replayed `gh` JSON for success, superseded, wrong event, wrong branch, wrong SHA, failed or missing CI, missing, failed or skipped `acceptance`, malformed JSON, a failing `gh`.
3. Vercel tools: fake `fetch`; fixed origin, redirects refused, secret values never written, errors value-free, protection fails closed on `all`, null and anything but the named constant.
4. Snapshot: with production plus five snapshots under a six-branch limit the run prunes first, then creates; a failed prune stops before creation.
5. `pnpm typecheck`, `pnpm lint`, `pnpm validate`, `pnpm test:coverage` pass. The three new `lib/deployment` files are gated at 100%.

## Gotchas and known issues

- **First-run blocker (see report):** `pnpm db:check:production` (non-manifest mode) still requires `BETTER_AUTH_SECRET` and `RESEND_API_KEY` in the job environment (`checkConfiguration`), but the owner checklist keeps those out of GitHub. The checker or the checklist must change before the first run.
- Job-level env gives the `vercel build` step the same secrets as the database steps, as specified. Scope them per step later if the build should not see `NEON_API_KEY`.
- A failed CI run on main also starts `production` and fails at the gate (a red run, no deploy). Neutral skipping would need a job-level `if`.
- The snapshot name uses `GITHUB_SHA`, which on `workflow_run` is the tip of the default branch; the gate guarantees it equals the released SHA at gate time, but a push between the gate and the snapshot would make them differ (harmless: still a valid snapshot name, and the next run is superseded-checked).
- `rehearse-migration.yml` checks out and runs code from an arbitrary accepted ref with `NEON_API_KEY` in scope. Keep reviewer approval on `production-rehearsal`.

## UNVERIFIED API assumptions (no remote contact was allowed)

- Vercel `ssoProtection.deploymentType` for Standard Protection is `all_except_custom_domains` (`STANDARD_PROTECTION_TYPE` in `vercel-project.ts`).
- `GET /v10/projects/{id}/env?decrypt=false` returns `{ envs: [{ key, type, value?, target }], pagination? }` and any `pagination.next` means more pages; `value` is present for `plain`.
- `teamId` is sent only when `VERCEL_ORG_ID` starts with `team_`.
- `GET /v6/deployments?projectId&target=production&state=READY&limit=1` lists `{ deployments: [{ uid }] }`; `GET /v13/deployments/{host-or-id}` returns `id`, `readyState`, `target`, `alias[]`, `aliasAssigned`. These replace `vercel inspect --json`, whose output shape is also unverified.
- `vercel deploy --json` prints `{ url }` or `{ deployment: { url } }`; `--skip-domain` and `vercel promote` exist in 63.1.2; `vercel build --prod` and `vercel pull` read `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` from the environment.
- `gh api --paginate --slurp` returns an array of pages (needs a `gh` that supports `--slurp`, 2.48 or later; the runner image has it).
- On `workflow_run`, `GITHUB_REF` is `refs/heads/main` (the default branch), which the production CI guard requires.
