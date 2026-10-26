# Publish and protect: Postgres, auth, GitHub backup, Vercel

Status: steps 12-17 implemented locally; step 18 private cloud-photo implementation passes local acceptance, but its live storage rehearsal awaits explicit approval. Step 19A-19C's selective snapshots, private GitHub App publication, persisted recovery, owner controls and authenticated scheduler are verified locally. Step 20A-20B local encrypted artifacts/guarded restore, 20C1-20C2 append-only vault library/operator/fetched recovery and 20D timezone/device receipts/authenticated scheduling pass local acceptance. Approved off-machine acceptance/pre-reset gate, retention, live provider/device checks and deployment remain open. Isolated Neon database rehearsals were verified after approval; public publishing has not started. Updated 2026-10-24. Live cloud/state-sync acceptance and UI/photo owner/device checks remain. Identity/provider changes and later infrastructure still follow their approval gates. See `roadmap.md` for current status; the PR numbers in this document are delivery labels, not GitHub pull request numbers.

## Stage: Launch, single production environment (2026-10-25)

Status: planned. This section is the stage record required by CLAUDE.md before the launch work starts. Where it conflicts with older sections below (protected preview, invite-only access, owner claim bootstrap, state sync and vault at launch), this section wins. The protected-preview material is history; preview is retired.

### Scope

Put the app on the internet for the owner and friends in one environment: production on Vercel with the single existing Neon project. There is no staging and no preview deployment. Everything else in this stage follows from that.

Decisions:

1. **One environment.** Production only. Local development uses a throwaway loopback Postgres or PGlite. Local development never connects to Neon, and no development or preview Neon branch is kept.
2. **Deploys only from GitHub Actions on `main`.** The deploy job runs in the `production` GitHub environment, which needs approval from the owner as required reviewer. The job refuses to run unless the exact SHA has a successful `acceptance` check.
3. **Deploy order.** Snapshot the Neon production branch as `pre-deploy-<timestamp>`, then: migrate, seed, `pnpm db:check:production` (pre-deploy phase), `vercel build --prod`, deploy as a candidate (not yet serving the production domain), smoke test the candidate, promote, smoke test production.
4. **Rollback.** Vercel instant rollback restores the previous deployment (on the Hobby plan only the previous production deployment, not an arbitrary older one). Restore the Neon `pre-deploy-*` snapshot branch only for data damage, because a code rollback cannot undo new database writes. Migrations stay expand-only so the previous deployment works against the new schema.
5. **Migration rehearsal.** `rehearse-migration.yml` runs the pending migrations against a Neon branch of production that expires in 1 day, in the `production-rehearsal` environment, then deletes it. It never touches the production branch.
6. **Preview retired.** `preview.yml`, the `preview` GitHub environment, `pnpm deploy:preflight` and the 21 Vercel Preview variables are removed or left unused. Vercel Preview and Development environments stay empty.
7. **Vercel protection.** Standard Protection. The site is public; preview URLs are not used. `PRODUCTION_PROTECTION_BYPASS` lets the workflow smoke test the candidate before promotion.
8. **Neon plan: free (owner decision, 2026-10-25).** The project history retention is 6 hours (21600 s), so built-in point-in-time restore only covers damage noticed within 6 hours. The `pre-deploy-*` snapshot branches (7-day expiry, newest few kept, pruned strictly) are the real recovery path beyond 6 hours, and they only capture the state at deploy time. Free-tier storage and branch limits must be respected: production is about 32 MB today, and every snapshot, rehearsal and other branch counts against the limits. The prune step must fail loudly (non-zero exit, workflow failure) if a limit is hit or a prune fails, never skip silently. The nightly encrypted `pg_dump` is the missing safety net, so it moves from "after launch" to "soon after launch" (see Backups on the free plan below).
9. **Mail limits.** Per recipient: 3 messages per 15 minutes and 10 per day. Plus a global daily cap (`MAIL_DAILY_CAP`), which stays at 60 because the Resend free tier allows 100 messages per day. While launch is friends-only, `SIGNUP_ALLOWLIST` restricts who can sign up; it is removed when signup opens.
10. **Owner data.** The owner's legacy SQLite data is imported into the owner's own household through a new household-targeted in-app importer, enabled only by `LEGACY_IMPORT_ENABLED=true` for the import window. The first person to sign up never claims legacy data, and no bootstrap secret exists in production.
11. **Features OFF at launch.** Reminders (`REMINDER_SCHEDULER_ENABLED=false`), state sync (`STATE_SYNC_ENABLED=false`), vault (`VAULT_ENABLED=false`) and library photo review (`PHOTO_REVIEW_ENABLED=false`). Their code stays; their credentials are absent from Vercel.
12. **Photos after launch.** Library photos are reviewed after launch, not before.

### Open decision: the later photo design

Not decided, and not part of launch. Two layers are likely:

- **Library approvals** stored once, with no household, shown to everyone including anonymous visitors and credited on `/credits`.
- **Household uploads** stay private to the uploading household.

The existing per-household `photo_decisions` rows are not the final model for library approvals. Do not build on them for the public layer. Settle this design, with its own stage record, before turning `PHOTO_REVIEW_ENABLED` on.

### Dependencies

- Production guards (PR1, PR2 above) merged. They are on `main`.
- Owner-supplied values below, entered by the owner.
- Workflow changes (deploy workflow, `rehearse-migration.yml`, `preview.yml` removal), the household-targeted importer and the mail caps/allowlist are separate PRs, each with its own stage detail. This PR is documentation only.
- Privacy page content (see below).

### Permission boundaries

- Agents never read or print `.env*` files or secret values, and never run commands against Neon or Vercel without a visible owner approval for that action.
- Secrets are entered by the owner through hidden prompts or the provider UI (`gh secret set NAME`, `vercel env add NAME --sensitive`), never in chat, commits, command arguments or logs.
- Migrate, seed and import against production run only from the `main` workflow job (guards above). No laptop path exists.
- Owner-only actions: approving the `production` deployment, promoting, restoring a snapshot, enabling `LEGACY_IMPORT_ENABLED`, removing `SIGNUP_ALLOWLIST`, and the Vercel/GitHub/Neon settings below.
- Agents never write human-owned data and never change `tested`, `rating`, `favourite` or `banned`.

### Owner-supplied values checklist (names only)

GitHub `production` environment, secrets:

- `VERCEL_TOKEN`
- `DATABASE_URL` (pooled)
- `DATABASE_URL_UNPOOLED` (direct)
- `NEON_API_KEY`
- `PRODUCTION_PROTECTION_BYPASS`

GitHub `production` environment, variables:

- `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
- `NEON_PROJECT_ID`, `NEON_PRODUCTION_BRANCH_ID`
- `DATABASE_PRODUCTION_HOST`, `DATABASE_DIRECT_PRODUCTION_HOST`
- `PRODUCTION_ORIGIN`
- `AUTH_EMAIL_FROM` (bare address, no display name)
- `SNAPSHOT_RETENTION_DAYS` (optional)

GitHub `production-rehearsal` environment: secret `NEON_API_KEY`; variables `NEON_PROJECT_ID`, `NEON_PRODUCTION_BRANCH_ID`, `NEON_DATABASE_NAME`, `NEON_ROLE_NAME`.

Vercel Production runtime, sensitive:

- `DATABASE_URL`, `BETTER_AUTH_SECRET`, `RESEND_API_KEY`
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`
- `SIGNUP_ALLOWLIST`

Vercel Production runtime, plain:

- `DATABASE_ENV=production`, `DATABASE_PRODUCTION_HOST`
- `NEON_PROJECT_ID`, `NEON_PRODUCTION_BRANCH_ID`
- `BETTER_AUTH_URL`, `AUTH_EMAIL_FROM`
- `BLOB_STORE=neon`, `BLOB_BUCKET`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`
- `APP_TZ`
- `STATE_SYNC_ENABLED=false`, `REMINDER_SCHEDULER_ENABLED=false`, `VAULT_ENABLED=false`, `PHOTO_REVIEW_ENABLED=false`, `LEGACY_IMPORT_ENABLED=false`
- `MAIL_DAILY_CAP`

Must be absent from Vercel Production: `DATABASE_URL_UNPOOLED`, `NEON_API_KEY`, `HOUSEHOLD_BOOTSTRAP_SECRET`, `HOUSEHOLD_OWNER_EMAIL`, `AUTH_TEST_MAILBOX`, test-push and test-github variables, `VAPID_*`, `REMINDER_SCHEDULER_SECRET`, `STATE_*` and `VAULT_*` credentials, `DEPLOYMENT_ENVIRONMENT`. (`DEPLOYMENT_ENVIRONMENT=production` is set by the workflow job only.)

Settings the owner applies:

- Delete the 21 Vercel Preview variables; leave Preview and Development empty.
- Vercel deployment protection: Standard.
- GitHub `production` environment: required reviewer is the owner, deployment branches limited to `main`, administrator bypass off.
- GitHub `main` branch protection: pull request required and the `acceptance` status check required. In `.github/workflows/ci.yml` the workflow is named `ci` and `acceptance` is the aggregate job; it needs `ci`, `browser` and `secrets` to succeed, so requiring `acceptance` covers all three. Do not require the three individually (an upstream skip would then show as missing rather than failed). Check the exact context name in the repository's branch protection UI after the first run on the PR.
- Neon: free plan with 6 hours of history (see decision 8). Neon Auth and Realtime stay off; the owner turns Neon Auth off in the console (an empty `neon_auth` schema exists on both branches).
- Owner checks in the Neon console, reported back before launch (UNVERIFIED, see Free-plan unknowns below): whether a branch can be marked Protected on the free plan, and whether Neon object-storage buckets are available on the free plan.

### Backups on the free plan

- Branch snapshots (`pre-deploy-*`) cover deploy-time damage only. They do not cover damage that happens between deploys and is noticed after 6 hours.
- Soon after launch (no longer "after launch"): a nightly `pg_dump` that is encrypted (age) before it leaves the runner. The repository is now PUBLIC, so GitHub Actions workflow artifacts are downloadable by other people. A plaintext dump must never be uploaded as an artifact. Upload only the encrypted file, to private storage, and keep the age private key with the owner only.
- Until that job exists, the risk is stated plainly: data lost and noticed more than 6 hours later, between deploys, is not recoverable.

### Free-plan unknowns (owner to check in the Neon console and report)

- Protected branch: UNVERIFIED on the free plan. If unavailable, production protection comes from the production guards (`PRODUCTION_CONTEXT_REFUSED` and the pins) plus GitHub `production` environment approval.
- Neon object-storage bucket: UNVERIFIED on the free plan. If unavailable, the photo store needs another route (to be decided; library photos are not part of launch, household uploads are).
- Neon Auth: the owner turns it off in the console. An empty `neon_auth` schema exists on both branches.

### Facts verified read-only on 2026-10-25

- Project "Meal Planner" has two branches. `production` (br-restless-breeze-b4717mzi, endpoint ep-proud-mud-...) has no application tables and no migration ledger. `dev-step14-rehearsal` is old: 2 migrations applied and rehearsal data; it is deleted after launch.
- The owner's old `.env.local` pointed at the PRODUCTION endpoint. Before anyone runs `pnpm dev`, local development must be moved to a local Postgres (`DATABASE_URL` and `DATABASE_ENV` for a loopback database). Treat that file as unsafe until then.

### Privacy page content (placeholder)

The owner still must supply, and nothing here may be invented: a contact address, the processor and region list (hosting, database, mail, storage), and backup retention. The privacy page is not published until these exist.

### Acceptance cases

1. A deploy to production cannot start from a laptop, another branch or a SHA without a successful `acceptance` check.
2. The `production` job waits for owner approval; a non-owner cannot approve.
3. A failed migrate, seed, check, build or candidate smoke test does not promote.
4. `pre-deploy-*` snapshot exists and is under 60 minutes old at check time.
5. Candidate smoke test and production smoke test both pass (public pages, sign-in page, health route).
6. A Vercel instant rollback returns the previous deployment, proven in the rollback drill.
7. With `SIGNUP_ALLOWLIST` set, a non-listed email cannot sign up and receives no mail; the 4th code request in 15 minutes and the 11th in a day to one recipient are refused; the global cap refuses at `MAIL_DAILY_CAP`.
8. Vercel Production shows none of the must-be-absent variables.
9. The legacy import creates the owner's data in the owner's own household only, with counts and checksums matching the source copy, and is refused when `LEGACY_IMPORT_ENABLED` is not `true`.
10. `pnpm typecheck`, `pnpm validate`, `pnpm test` pass; gitleaks finds nothing.

### Soft-launch plan and go/no-go gates

Each gate must pass before the next starts. Any failure is a no-go until fixed.

1. **Owner only.** `SIGNUP_ALLOWLIST` contains only the owner's address. Deploy through the full workflow.
2. **Real email.** Sign up with the real address; the code arrives from `AUTH_EMAIL_FROM`, passes SPF/DKIM, and is not in spam.
3. **Browsers and devices.** Safari, the installed iPhone home-screen app (its own cookie store) and Android Chrome each sign in, stay signed in across a restart and sign out.
4. **Hosted smoke as a person.** Plan, shopping list, export, a household upload and the public pages as a signed-in person and as an anonymous visitor.
5. **Legacy import.** Take a verified copy of the SQLite database and uploads, set `LEGACY_IMPORT_ENABLED=true`, import into the owner's household, verify counts and checksums, set it back to `false`.
6. **Backup restore drill.** Restore the latest `pre-deploy-*` snapshot branch into a throwaway branch and read the data back (point-in-time restore only reaches back 6 hours on the free plan, so it is not the drill target). Delete the branch. Also confirm the prune step stays within the free-tier branch and storage limits.
7. **Rollback drill.** Deploy a harmless change, roll back with Vercel instant rollback, confirm the previous version serves.
8. **Friends.** Add friends' addresses to `SIGNUP_ALLOWLIST` in small batches. Watch mail volume against the caps. Remove the allowlist only by a later owner decision.

### Launch-day runbook

1. Confirm the checklists above are complete and `main` has a green `acceptance` check for the SHA to deploy.
2. Start the deploy workflow on `main`; approve the `production` environment as owner.
3. The job snapshots `pre-deploy-<timestamp>` (7-day expiry), prunes older snapshots to the newest few and fails loudly if a free-tier limit is hit, migrates, seeds, runs `pnpm db:check:production`, builds, deploys a candidate and smoke tests it.
4. Promote, then smoke test the production origin.
5. Work through the go/no-go gates in order.
6. Watch Vercel logs and Resend sending for the first hour of each gate.

### Rollback

- **Bad code, data intact:** Vercel instant rollback to the previous deployment. No database action.
- **Data damage:** stop writes by rolling back and, if needed, restore to a new branch, check it, then repoint. Within 6 hours of the damage, use Neon point-in-time restore (project history retention is 6 hours). Beyond 6 hours, the only source is the newest `pre-deploy-*` snapshot branch (or, once it exists, the latest encrypted nightly dump). Writes made after the snapshot are lost; say so to users.
- **Vercel rollback limit:** on Hobby, instant rollback only returns to the previous production deployment. Two bad deploys in a row means fixing forward or redeploying a known-good SHA through the workflow.
- **Bad migration:** migrations are expand-only, so roll back code first and fix forward. Restore only if data is damaged.
- **Mail abuse:** lower `MAIL_DAILY_CAP` or set `SIGNUP_ALLOWLIST`, redeploy.
- Prune snapshots strictly: delete expired `pre-deploy-*` branches and keep only the newest few, after `SNAPSHOT_RETENTION_DAYS` (default per the workflow, 7). The prune step fails the workflow loudly if it cannot prune or if a free-tier limit is hit; it never continues quietly.

### Gotchas

- Vercel instant rollback does not undo migrations or data.
- `DATABASE_URL` is pooled for runtime and `DATABASE_URL_UNPOOLED` is direct for migrations; only the former exists in Vercel.
- Free plan: history retention is 6 hours (21600 s). Do not describe point-in-time restore as a 7-day safety net anywhere.
- Free-tier storage and branch limits apply to the snapshots, the 1-day rehearsal branch and `production` together. Production is about 32 MB today. A pre-deploy snapshot is a full branch, so the number kept must stay small.
- `AUTH_EMAIL_FROM` must be a bare address, not `Name <addr>`.

## Stage scope: single production environment and production guards (2026-10-25)

Owner decision: there is ONE hosted environment, production, on Vercel with the single existing Neon project, shared with friends. Local development uses a throwaway local Postgres (or PGlite). The protected-preview machinery stays for history but is not a second environment to maintain. A remote sanity check must pass before any deployment; GitHub Actions may later run migrations and deploys behind an owner approval. This stage only builds and tests the guards; it touches no remote service.

Hard boundaries for agents working this stage: never run anything against Neon or Vercel, never read or print `.env*` values or secrets, no workflow or Vercel configuration changes (a later step). Everything is built and tested with local PGlite, loopback Postgres and fakes.

### PR1: production guards

- A production migration/seed/import target exists and is allowed only when `GITHUB_ACTIONS=true`, `GITHUB_REF=refs/heads/main` and the deployment environment marker `DEPLOYMENT_ENVIRONMENT=production` are all present. Any other context (a laptop, a preview-labelled run, another ref) is refused with the stable code `PRODUCTION_CONTEXT_REFUSED`. Restore stays development/test only. The development/test targets and the loopback-only mailbox and fixture rules do not change.
- `verifyProductionBranch` requires the branch id to equal `NEON_PRODUCTION_BRANCH_ID`, the branch to be ready, and the host to be the unique read-write endpoint of that branch (direct host for migrations, pooler derived from it for runtime). The Neon control-plane client is injected.
- Runtime gap closed: production runtime pins its host with `DATABASE_PRODUCTION_HOST` (pooled) and migrations pin `DATABASE_DIRECT_PRODUCTION_HOST` (direct), so the running application needs no Neon API key. `sslmode=verify-full`, libpq host-override refusal and the direct-endpoint requirement for migrations are kept. A production runtime also requires `VERCEL=1` and `VERCEL_ENV=production`, so `next start` on a laptop cannot reach production.
- Stable codes: `PRODUCTION_CONTEXT_REFUSED`, `PRODUCTION_PIN_MISSING`, `PRODUCTION_HOST_MISMATCH`, `PRODUCTION_DIRECT_REQUIRED`, `PRODUCTION_POOLER_REQUIRED`, `PRODUCTION_NEON_CONFIG_MISSING`, `PRODUCTION_NEON_UNREACHABLE`, `PRODUCTION_NEON_INVALID`, `PRODUCTION_BRANCH_MISMATCH`, `PRODUCTION_BRANCH_NOT_READY`, `PRODUCTION_ENDPOINT_MISMATCH`.

### PR2: `pnpm db:check:production`

Read-only remote sanity check (`BEGIN READ ONLY`, an allow-list of statements, rollback at the end). It prints only stable codes and counts, never a configuration value or URL. Checks: configuration well-formed (pooled and direct URLs agree on database and credentials, `BETTER_AUTH_URL` is https and equals `PRODUCTION_ORIGIN`, mail variables present, no bootstrap secret or fixture variables, sync/reminder/vault flags false); Neon control plane (project, production branch, ready, endpoint); connectivity and server version; migration ledger against `db/postgres-migrations` (exact, pending N, divergent); schema drift against the drizzle snapshot matching the applied ledger; library seed version against the local `/data` fingerprint; age of the newest `pre-deploy-` snapshot branch.

- `--phase=pre-migrate`: pending migrations are allowed, a stale library and a missing snapshot are warnings. `--phase=pre-deploy` (default): ledger must be exact, library current, and a snapshot younger than 60 minutes must exist. A divergent ledger always fails.
- Outside GitHub Actions the command requires `--remote-read-only` and refuses a role that can write (superuser, or INSERT/UPDATE/DELETE on the library table, or CREATE on `public`).

### Acceptance

1. `pnpm typecheck`, `pnpm test`, `pnpm validate` and `NEXT_DIST_DIR=.next-build pnpm build` pass.
2. Unit tests: laptop refused, preview-labelled refused, wrong ref refused, wrong branch, pooler vs direct, host mismatch, missing pins, happy path in the CI context.
3. PGlite tests exercise every check code, prove the transaction is read-only, and prove that no secret or URL value appears in output.
4. No workflow, Vercel or external-service change in this stage; wiring the check and approvals into GitHub Actions is the next stage.

### Gotchas

- `DEPLOYMENT_ENVIRONMENT` is a marker set by the (future) workflow job, not a GitHub built-in; it is a guard against mistakes, and GitHub environment approval remains the real control.
- Pre-deploy snapshot branches are expected to be named `pre-deploy-<timestamp>`.

## Revised product direction: public library and email-first households

User-directed change, 2026-10-24: public visitors browse recipes/ingredients/details with a top menu; signed-in people use the full application within their own household. Anyone can sign up without invitation/bootstrap codes or choosing a cook/owner role. A household adds members by email from day one. This supersedes the single-household-per-deployment and invite-only product assumptions below, not their existing privacy protections. **This section is an implementation plan, not completed functionality.**

### Current hosted acceptance and next bounded slice, 2026-10-25

Protected preview is live at
https://protein-kitchen-preview-nitin27mays-projects.vercel.app,
application SHA `f0b9fe44b587009a6f01fa1dd360ce17f122d173`,
successful aggregate CI `40168258902`. Hosted browser acceptance verifies
anonymous denial, five real routes, recipe technique expansion, private-account
redirect and no uncaught errors. Vercel Authentication protects **all**
deployments/aliases; implicit first-deployment production promotion is refused
by the runner. The initial automatically classified bootstrap deployment was
removed after creating/inspecting the real preview. Runtime uses isolated
`protein_kitchen_hosted_preview`: all 20 migrations, library-only seed, empty
non-library tables, private read-only empty storage, no development-branch
expiry. Production Neon and blocked production release policy are unchanged.
These facts supersede the historical deployment blockers below.

**Status: H3 household creation UI accepted and deployed, not open signup.** Expose the already
accepted `createSessionHousehold` primitive through a verified-session Server
Action and hydration-safe onboarding form. A verified account with no
membership may name a new empty household, automatically become its manager
and continue to its own profile without a code or role selection. Keep pending
association accept/decline visible; explain that creating does not join another
household. Preserve legacy invitation/bootstrap compatibility and existing
profile/household selection. Do not enable new-account signup, live mail,
production deployment, household import, profile reassignment or extra-household
creation for existing members.

**Dependencies and permission boundaries:** accepted protected deployment,
verified email/session identity, existing session-bound creation transaction,
membership/session locking, existing profile action and H4 recipient consent.
Recheck identity and membership on the server; hiding the form is not authority.
An expired/unverified/anonymous session or any existing/quarantined membership
must refuse without adopting legacy rows. Reuse the existing service; no schema,
mail-provider or nutrition-data changes.

**Acceptance before completion:** actual action tests for normalized name,
automatic owner/session selection, profile continuation, invalid name,
anonymous/unverified/expired identity and existing-membership refusal; retain
the service's native contention/quarantine cases. Retained phone browser journey
creates a household without entering a grant, handles failed submit/retry,
finishes a profile, reloads, confirms selection and preserves an independent
household. Run affected authorization/action tests, full serial coverage and
browser acceptance, types, validation and database-free production build.
This slice was developed after initial hosted acceptance, then passed its own
exact-commit Linux CI and was deployed as the current application SHA above.

Full browser acceptance exposed the same first-click readiness gap on shared
shopping/prep checkboxes: the trace contained a GET but no mutation POST after a
visible checkbox was clicked before hydration. Apply the existing shared
hydration signal to grocery/pantry/manual-item and prep completion controls,
without changing persistence or authorization. Retain a deliberately
script-delayed browser case proving disabled-before/usable-after hydration and
first-change persistence on both pages; do not hide the failure with a sleep or
forced click.

**Acceptance result:** 2,015 tests / 101 files including 42 native cases,
38 retained browser journeys, all critical coverage gates, strict types,
library validation and production build pass. The new browser covers disabled
pre-hydration controls, server field errors, network failure with preserved
input/retry, grant-free creation, duplicate replay refusal, profile completion,
reload and unchanged independent household data. Actual workflow guard programs
also execute against synthetic CLI fixtures and refuse partial protection,
wrong project, unready output and implicit production classification.
`PREVIEW_ALIAS` pins the auth origin and is assigned only after target checks.
Current ready preview `dpl_4mHAXeMCPb2BNzUs4Axiu7MJsEYw` passed the retained
hosted read-only browser acceptance. No synthetic account/household was created
in the cloud; the full creation journey uses only disposable loopback fixtures.
Vercel's `--skip-domain` flag is production-only and is omitted from preview
commands; the operator exercised the supported preview arguments successfully.

### Required experience

- Anonymous home is the public library/landing experience, with Recipes, Ingredients, Sign in and Create account in a responsive top menu. **Superseded 2026-10-25** by "Open signup and anonymous app shell" below: anonymous visitors now get the same app shell. Direct private URLs still require authorization; hiding links is not enforcement.
- Public recipe/component/ingredient/technique pages expose library content and computed nutrition, not household feedback, saved views, profile-based targets, plans, notes, links, uploaded photos or other human-owned content. Private image routes remain private. Initial public cards can be image-free rather than republishing household photos. Public catalogue filtering must not use household banned/tested/favourite choices.
- **Superseded in part 2026-10-25:** signup is email-first and open (email, then a six-digit code, magic link as fallback); there is no password at signup. See "Open signup and anonymous app shell". Original text: signup asks for ordinary identity details, never a bootstrap key, invitation code, cook role or ownership selection. Member association uses normalized email. No manual household grant/code is required. Use email links rather than asking users to copy a numeric email code; verify the installed Better Auth email-link contract before changing providers/hooks. Keep working self-managed Better Auth and its rate limits/origin protections. Mail must be wired and exercised from the first auth slice, not deferred until deployment.
- Prove email ownership before showing membership/household associations or granting private access. Before proof, return a generic "Check your email to continue" response; do not expose whether an address has an account or belongs to someone else's household. After proof, show "This email has been added to a household. Finish setting up your account to join" (without disclosing private household details before acceptance).
- A verified person with no household sees a simple create-household start point and personal-profile onboarding. A verified person with a pending email association sees an explicit accept/decline choice; acceptance requires no copied token/code. Never silently move an existing account, copy its data or merge households when another person adds its email.
- Household settings adds an email, an optional display name and optional relationship label such as partner/spouse/roommate. Relationship labels are not authorization roles, are not required and must not be inferred. Existing and future accounts can accept the same pending association after verified sign-in/signup. Only the recipient may accept; the sender can revoke pending associations.
- Internal owner/member permissions remain for safe member management and destructive controls; signup does not ask users to choose a role. The household creator receives management permission automatically. Shared plans/shopping/prep remain shared within the household; each member keeps their own profile/targets and existing private-field protections.
- Multiple-household behavior was asked but the user was unavailable and subsequently directed autonomous decisions. Use explicit multiple memberships and a household switcher: accepting a second household never reassigns a profile, copies data or merges households. Require recipient acceptance, keep the current household selected until an explicit switch, and reauthorize that selection on every private request.

### Open signup and anonymous app shell (direction set 2026-10-25)

This supersedes the earlier rule that anonymous visitors see only a reduced navigation and that signup needs an invitation or claim key.

**Direction**

- Anonymous visitors get the same app shell as signed-in users: Today, Plan, Recipes, Groceries, Profiles and the rest of the navigation are visible.
- Browsing recipes, parts, techniques and ingredients is open. Public pages still show library content and computed nutrition only, never household feedback, notes, links, uploaded photos or profile-based targets.
- Generating a plan works on the device with no server writes. The draft lives in the browser only.
- Any persisting action asks for email signup and carries the draft through: save plan, favourite, rate, tick groceries, add a photo, add a link, save a profile.
- Signup is open. There is no invitation, claim key, household form or role choice. The user enters an email, receives a six-digit code (an email link is the fallback), and a verified email creates the account. A household is created automatically, named "<name or email local-part>'s kitchen".
- A password can be set later in account settings; password sign-in for existing accounts continues. `/sign-up/email` is disabled.
- Before proof of the email, responses are generic and identical for existing and new addresses. Tenant enforcement, origin checks and rate limits stay.
- Admission after verification, in order: existing membership is selected; pending email associations show accept/decline plus "Start my own kitchen instead"; the verified email equal to the server-only `HOUSEHOLD_OWNER_EMAIL` binds to the imported household while `household_bootstrap` is empty (email proof replaces the claim key); otherwise a household is created automatically.
- The profile step after admission is short: name, protein target, optional weight and kcal target. Sex, birth date and height become optional where generation does not need them.

**Anonymous vs account**

| Capability | Anonymous | Account |
| --- | --- | --- |
| Browse recipes, parts, techniques, ingredients | Yes | Yes |
| Computed nutrition on library pages | Yes | Yes |
| Generate a plan | Yes, on device, draft kept in the browser | Yes |
| Save a plan to the server | Asks for email, draft carried through | Yes |
| Favourite, rate, ban, tested | Asks for email | Yes |
| Tick groceries, pantry, prep | Asks for email | Yes |
| Upload a photo, add a link, add a note | Asks for email | Yes |
| Profile and targets | Asks for email | Yes |
| Household feedback, photos, links of others | Never | Own household only |
| Invite or associate other emails | No | Household owner |

**Acceptance criteria**

1. The sign-in and create-account screens have no invitation, claim key, role or household-name field.
2. A new email, a code and verification produce a verified user, a household with that user as owner, and a selected session, with no further form before the profile step.
3. The request-code and request-link responses are byte-identical for existing and new addresses.
4. `/sign-up/email` is refused; a user cannot be created without a proven code or link.
5. A user with a pending email association is shown accept/decline and "Start my own kitchen instead", and is not given an automatic household first. If an automatic creation races with the association, the association remains acceptable and no data moves.
6. `HOUSEHOLD_OWNER_EMAIL` binds the imported household only for the matching verified email and only while `household_bootstrap` is empty; the value is never logged or returned.
7. Anonymous visitors see the full navigation; private data routes still authorize every request; no anonymous action writes to the server.
8. A persisting action by an anonymous visitor opens email signup and, after verification, completes with the carried draft (delivered in a later step).
9. Browser and unit tests use loopback fixtures and the test mailbox only, with no real mail and no remote database.

Implementation order: step 1 is this record; step 2 is the signup and admission change; later steps deliver the anonymous shell, the on-device draft and the carry-through.

### Why changing only signup is unsafe

Current `household_bootstrap` is a deployment singleton, `household_members` is keyed only by user id, and plans/people/shared feedback/photos/saved views/sync state have no tenant boundary. `listPeople`, `listPlans`, `latestPlanId` and plan access currently assume every admitted member belongs to the same household. Removing `authorizeSignup`'s invitation check without replacing admission and scoping would expose existing household data. Public recipe pages also currently read private feedback, profiles, plan choices and photo/link rows. Do not remove their guards and reuse their private payloads.

### Ordered implementation stages, plan before each stage

1. **H1: household schema and compatibility migration.** Inventory every tenant-owned table/query/mutation, including manual groceries/pantry/prep/habits, personal and shared feedback, saved views, links/photos/decisions, routines, reminders, sync/recovery/export/reset and account removal. Add explicit households, memberships and household-scoped email associations/uniqueness. Backfill all existing human data into one legacy household without changing human decisions or losing profile links; library rows stay global. Design composite keys/foreign keys and per-household locks to prevent cross-household joins and last-owner races. Model active household as a session preference that is reauthorized on each request, never a client-supplied access grant. Keep admission unchanged until scoped consumers are complete.
2. **H2: complete tenant enforcement.** Carry authoritative household membership through page/action/route access, all private query reads and writers, planner/groceries/prep, profiles, exports, images and operational jobs. Every requested id must belong to that household; an owner is not a deployment administrator. Scope recipe feedback, notes, links/photos, defaults and human exporters/importers. Scope sync jobs/revisions/targets and scheduler traversal; legacy deployment-wide exports/vault/reset commands must be explicitly operator-only and never exposed as ordinary household-owner data access. Preserve human writer/export invariants and add backward-compatible format/version rules instead of mixing tenants into the old export. Prove two unrelated households cannot read/write/export one another's rows or blobs, even using guessed ids and valid owner sessions. Unscoped paths must fail closed.
3. **H3: email-first self-service admission.** After H1-H2 acceptance, replace grant-required signup and singleton bootstrap with ordinary signup, verified email-link continuation and transactional household create/join. Implement expiring hashed one-use links, fixed-origin redirects, persistent throttling, safe generic responses and replay/refusal cases using the installed provider's supported APIs, not a parallel token system. Test real app HTTP -> synthetic mailbox -> actual link -> verified session/onboarding, including send failure/retry, expiry/replay, reload and installed-iPhone/Safari cookie-boundary behavior. A link opened in another context must establish/complete that context's authenticated flow rather than report false success in the original window. Live Resend/domain delivery requires separately configured owner credentials; no actual delivery is claimed from local tests.
4. **H4: household member email UX.** Replace manual invitation-code management with add-by-email, pending/sent/revoked/accepted status, verified recipient confirmation and profile onboarding. Support both already-registered and future signups, normalized email matching and concurrent/replayed accept/cancel requests. Add explicit household selection/switching without merging plans, reassigning profiles or granting authority from the selection cookie alone. Keep at least one verified manager; revocation/removal invalidates access/registrations without deleting shared plans. No household identity or member list appears in unauthenticated email-lookup responses.
5. **H5: public library and navigation.** Build public payloads from library-only data/helpers, reuse display components only after separating private controls/props, and keep private feedback/photos/links out of public RSC/HTML/metadata. Add anonymous top navigation at phone/desktop widths; preserve the full signed-in app navigation. Anonymous `/` is library/landing; signed-in `/` resolves through onboarding/active-household context to the plan. Public pages must render without auth/mail/household database configuration; unknown slugs return 404. Public read access must never implicitly grant write, photo review or private cook/plan state access.
6. **H6: acceptance and plan reconciliation.** Add retained Playwright journeys for anonymous lists/details/navigation/404/private-route refusal; fresh signup/email-link/create-household/profile/reload; pending email -> signup -> association prompt -> accept; existing account -> sign-in -> pending association; decline/revoke/expired/replayed links; two members sharing one plan/list with different targets; two independent households with cross-id access refusal; desktop/phone layouts and email failures. Native Postgres tests cover migration/backfill, household creation, membership/last-owner races and cross-tenant writes/exports/jobs. Maintain critical coverage gates, typecheck, library validation and database-free build. Update the deployment preflight and old invite-only/PWA-code documentation only alongside their actual implementations. No public deployment or real data/cloud transfer follows merely from these local changes.

Each stage requires its own bounded implementation plan, verification and saved tests. Do not claim self-service signup safe until tenant enforcement and verified admission are complete. This work takes priority over deployment of the old invite-only product; existing cloud provisioning/content consent gates still apply.

### Next bounded slice: H4 email associations and recipient confirmation

**Status: implemented and accepted locally.** This is the first H4 vertical slice and
does not open public signup. It replaces copyable invitation grants with a
household-scoped pending email association that an already-registered,
email-verified recipient can explicitly accept or decline. Future signup must
reuse the same pending association in a later H3 slice.

**Dependencies:** H1/H2 household ownership and session-bound household
selection are implemented locally. The current authenticated email-link flow,
profile onboarding and account controls are available. Preserve the
single-use-provider-link behavior and the existing signup gate until recipient
associations and fresh-account onboarding are both complete.

**Scope:**

1. Evolve `household_invitations` in a new forward-only Postgres migration:
   allow legacy `token_hash` values to be null for new associations; replace
   deployment-wide pending-email uniqueness with `(household_id, email)`; keep
   pending-email uniqueness within each household and pending-profile
   reservation for legacy rows; add optional display name and relationship
   label columns. Preserve existing rows, accepted/revoked timestamps and the
   old schema's ability to migrate without rewriting household data.
2. Add transactional owner operations to add an email association and revoke
   it, and recipient operations to list only associations matching the
   verified session email, then explicitly accept or decline one. Normalize
   addresses identically at insertion and comparison. Accepting may add a
   second membership; it must not link a profile, move data, merge households,
   change existing memberships, or change the active household selection.
   Decline/replay/revoke/expired and wrong-email requests fail generically.
   Serialize conflicting accept/revoke operations and keep at least one
   verified owner.
3. Replace the owner-facing invitation-code form with add-by-email and
   pending/revoked/accepted state. Show the recipient only a generic
   association prompt before acceptance (no household name, sender identity,
   profile name or member list); acceptance routes through explicit selection
   before any private household content is loaded. Preserve account actions and
   profile privacy. Send a notification using the existing mail transport;
   use the same response regardless of whether the address already has an
   account, never include a membership token, and surface delivery failures.
4. Retain legacy grant acceptance only as a compatibility path for already
   issued invitations during this stage; do not issue new copyable codes from
   the UI. Do not loosen `authorizeSignup`, expose bootstrap secrets, enable
   signup, or claim future-account association support yet.

**Permission boundaries:** association creation/revocation requires a verified
owner in the selected household. Listing/acceptance/decline requires the
verified account's own current session and normalized email. An association id
or selected-household id alone grants no access. A recipient with an existing
membership may accept another household without affecting their current
selection or household data. No unauthenticated endpoint returns association
existence or household details.

**Acceptance:** migration replay and populated/empty-target tests; native
Postgres and PGlite tests for same email in two households, same-household
duplicate refusal, wrong-email refusal, concurrent accept/revoke, acceptance
with preserved existing membership and session selection, generic decline,
and account-removal cleanup. Retain Playwright coverage for owner add/revoke,
verified recipient prompt without private household details, accept/decline,
selection of the newly joined household, and reload. Run the full serial native
coverage, all retained browser cases, typecheck, data validation and
database-free production build. No live mail credential, remote schema change,
deployment or production transfer is in scope.

**Local acceptance:** 1,976 tests across 98 files, including 42 native Postgres
cases, and all 36 retained Playwright journeys pass. Typecheck, data validation,
production build and unchanged critical coverage gates pass. Overall coverage:
statements 72.81%, branches 62.73%, functions 62.84%, lines 74.12%.
Migration `0019` adds tokenless, household-scoped associations and decline/label
fields without changing human-owned rows. Native accept/accept and accept/revoke
races admit exactly one winner while preserving existing session selection.
The browser covers add/revoke, notification delivery, undisclosed recipient
confirmation, first-household acceptance and decline from incomplete-profile
onboarding in an existing household. Signup and household-creation UI stay gated.

**Deployment request follow-up:** the user subsequently requested deployment to
Vercel and Neon after the changes work, then continuation to the next stage.
The account inventory is read-only so far: the existing Meal Planner Neon project
has distinct production and development-rehearsal branches; no Protein Kitchen
Vercel project is linked or present in the authenticated team's project list.
Local configuration still lacks the server-side branch-verification API key,
mail credentials/from address and private cloud-photo credentials. GitHub has
no configured deployment environments or secret names. Do not reinterpret the
request as permission to bypass preflight, use the production branch as a
development fixture, replace self-managed auth, or publish incomplete signup.
Complete acceptance first, then D2-D5 prerequisites and protected hosted
verification; production cutover remains subject to D7's exact-target and
recovery requirements.

**D2 setup update:** the user explicitly authorized a new Vercel project and
GitHub Neon configuration. Created/linked `protein-kitchen` with Next.js,
Node 22, pnpm and authenticated previews. Reused existing Neon branches;
transferred pooled/direct URL secrets plus separate project-scoped API keys
to GitHub `preview` and `production`, with branch/project/host and Vercel IDs
as environment variables. No SQL migration, source upload or deployment ran.
Preview is restricted to the current trusted work branch. Required reviewers
are unsupported by this private repository's plan; production is therefore
fail-closed with no permitted deployment branches, not silently downgraded.
The existing rehearsal branch expires on 2026-10-31. Runtime Vercel settings,
mail/private storage, protected migration workflow and hosted acceptance remain
pending. Local `.env.local` was not populated with the new GitHub API keys.

### Delivery extension: GitHub Actions, Vercel, Neon, notifications and release

**Next bounded D3/D5 slice: protected preview runner.** Add a manual-only
workflow on the trusted work branch, requiring successful credential-free CI
for the identical push SHA before any deployment credential is used. Pull the
existing Vercel preview settings, compare its database/branch pins with the
GitHub preview environment, then run the unchanged live preview preflight.
Refuse pending or divergent migration hashes using a read-only ledger check;
do not bypass the development-only migration command or apply SQL in this
slice. Build and upload only prebuilt output after every gate passes. Pin
actions and CLI versions, serialize deployments, never upload pulled settings
as artifacts, and delete temporary environment/build output on exit. Production,
mail/push enablement, source-data transfer and automatic deployment from PRs
remain excluded. Retain workflow-contract tests for triggers, exact-SHA CI
checks, secret boundaries and gate ordering. Missing Vercel runtime variables
must block the runner explicitly, not produce a successful placeholder deploy.

**Runner slice accepted locally:** `.github/workflows/preview.yml` implements
the bounded contract above without SQL writes or production deployment.
The 58 targeted workflow/CI/preflight tests pass; retained cases parse both
actual inline programs, execute missing-setting refusals and run the actual
runtime verifier against an isolated invalid fixture, proving refusal before
database access without printing secret values. Typecheck, YAML/shell syntax
and patch checks pass. Changes remain uncommitted/unpushed; this is not a
registered or executed hosted workflow. Register manual dispatch through a
reviewed default-branch change and obtain exact-SHA push CI. Vercel runtime
settings, the separately protected preview migration contract, private storage
and hosted acceptance remain pending; no environment-label bypass is allowed.

**D4/D5 continuation scope before implementation:** configure only the existing
schema-only development rehearsal branch and Vercel preview target. Create a
private empty photo bucket and branch-scoped read-only runtime storage
credential; generate a preview-only auth secret and project-scoped metadata
key, transferring values via stdin without exposing them. Keep mail, push,
sync and vault disabled and production untouched. Use a fixed preview alias.
Add a separate operator preview migration command rather than relaxing the
development/test command: require explicit preview mode, exact branch
acknowledgement and live pooled/direct branch verification; serialize with an
advisory lock; require the existing ledger to be an exact prefix of reviewed
migrations and reject any target containing human-owned state before writes.
Use transactional Drizzle migrations, verify final ledger parity, and never
seed/import household state. Retain target/refusal/ledger tests, run accepted
CI for the published work-branch SHA, then deploy that SHA to protected preview
and verify actual protected/public-library responses through authenticated
Vercel access. No production cutover, signup/mail acceptance claim, source
import, reset, release or unrelated product slice is included.

**Preview auth dependency:** the existing eager mail configuration prevents
provider/session initialization when preview correctly has no live mail key.
Keep email disabled explicitly in protected preview: construct a sender that
throws a clear configuration error on every delivery attempt, without network
I/O, rather than failing provider construction or pretending delivery succeeded.
Test refusal with absent and accidentally supplied credentials; preserve all
non-preview mail validation and receipts. This is not hosted mail acceptance.
For operator deployment from this macOS machine, upload a clean archive of the
exact CI-accepted commit for Vercel's Linux build; do not upload local test
fixtures, pulled env files or macOS-built server binaries. The committed
Actions runner continues to use Linux prebuilt output when registered.
The first remote CI run exposed an unavailable `postgresql-client-17` package
in the runner's default apt sources. Pin its native recovery job to Ubuntu
24.04 and add the official HTTPS PGDG repository with a scoped `signed-by`
key, keeping client/server major version 17 and verifying both binary versions.
Do not skip recovery tests or weaken the aggregate gate to deploy.
Retain an operator-only hosted browser smoke command, separate from loopback
fixtures: explicit HTTPS preview origin plus server-only protection bypass;
confirm anonymous denial, public library/sign-in rendering, private-account
redirect and no uncaught browser errors. Inject the bypass only into requests
for the exact origin, never into third-party requests; no writes or fixture
reset are performed.
The application also requires the exact library version before opening
database-backed auth. Add a separate explicit preview library-seed command
using the same live target, advisory lock, complete migration ledger and
empty-non-library-state guards; validate disk data first and seed only library
data through the existing transactional helper. Never seed at request/build
time or relax the existing development/test seed guard.
Live rehearsal found that the shared seed helper initializes empty legacy
feedback rows. Preserve that default for existing callers, but explicitly omit
feedback initialization for the isolated preview seed and prove every
non-library table stays empty. Keep the first synthetic preview database
untouched and use a fresh empty hosted-preview database rather than deleting
human-owned-class rows to repair the rehearsal.
The first complete hosted browser attempt exposed fixed-navigation overlap
when scrolling a feedback control into view, and a plan assertion that treated
streamed HTTP headers as completed mutation work. Reserve top/bottom scroll
padding matching the existing navigation and wait for terminal plan navigation
with a bounded 60-second assertion instead of treating streamed headers as
completion. Dev-server RSC streams can remain open after rendering, so do not
wait on `Response.finished()` as the completion signal. Keep real pointer clicks and all
journeys; the subsequent auth failure depended on the interrupted prior
password-reset journey. The native coverage job was making steady progress
without failed cases when its 15-minute job deadline cancelled it: raise that
bounded runner deadline to 45 minutes rather than omitting database tests.
Full local rerun also exposed a reminder fixture comparing the current day
against hard-coded October 25, which collided when the clock reached that
date. Make both days of that calendar-independence case explicit; preserve
live-clock dispatcher cases and all admission assertions.
Linux evidence confirms the scroll fix lets the full owner/cook journey reach
sign-out and its cold PDF-route authorization check, but that long journey
exhausts its two-minute total deadline before password reset. Allow four
minutes for that retained multi-account journey; do not retry or suppress its
assertions. Dependent password-reset/deletion coverage must still complete.

User direction, 2026-10-24: finish and test the product, then deploy using GitHub CLI, Vercel CLI and the existing Neon account; configure GitHub Actions secrets and create a release later. This adds the following ordered delivery work, not authorization to publish the current incomplete build. Reuse existing projects/accounts and self-managed Better Auth. Confirm exact target projects, domain, costs and any real-data transfer before provisioning or cutover. Never delete/reset a Neon branch or change an existing production resource as an implicit setup step.

1. **D1: reconcile and finish feature acceptance.** Complete H1-H6 first. Audit the actual reminder/push implementation rather than rebuilding it: timezone controls, session-bound subscriptions, test-send controls, persisted device receipts and the authenticated POST scheduler already exist and pass local synthetic acceptance. Still required: household-scoped eligibility and plan/prep selection, revocation/switching behavior, hosted scheduling, real provider delivery and physical-device acceptance. Retain tests for two unrelated households, same-household cooks, timezone/DST, duplicate scheduler calls, successful-device suppression, expired/revoked registrations, explicit retries and ambiguous sends. Run full coverage/native/browser/build acceptance before any release candidate.
2. **D2: inspect accounts and define deployment contracts.** Use `gh` to inspect repository environments/rules/checks and secret names, `vercel` to inspect the existing team/project/domain/environment scopes, and Neon CLI/account metadata to verify project/branch/endpoint identities. Check installed command help before mutations; never print connection strings or secret values. Produce a reviewed variable manifest with name, purpose, required environment, consumer and secret-versus-variable classification. Do not claim a setting exists merely because it appears in `.env.example`. Stop for authentication/target decisions rather than creating substitute projects.
3. **D3: implement protected workflows.** Preserve independent secret-free PR checks: strict types, data validation, all critical coverage gates, disposable loopback Postgres/native recovery tests, retained Playwright journeys, production build and secret scan. Never give fork/PR code deployment credentials or use `pull_request_target` to execute it. Pin reviewed action/CLI versions, minimize permissions, serialize migrations/deployments per environment and retain sanitized acceptance artifacts. Separate test, preview, migration, deploy, scheduler and release jobs; deploy only the exact tested commit. Preview uses a schema-only/synthetic database and private isolated storage, no household source copy or production credentials.
4. **D4: configure secrets and validate without disclosure.** Use protected GitHub environments (`preview`, `production`, and an operator recovery environment if enabled), with appropriate reviewers/branch restrictions. Write approved credentials using `gh secret set` through safe stdin/private input, not command-line literals; use GitHub variables for nonsensitive configuration. Install the corresponding runtime values in the correct Vercel environment using its CLI. GitHub secrets alone do not configure Vercel runtime. Separate environment credentials, fail on missing required values and verify names/scopes plus redacted application preflight. Do not dump, commit or upload pulled env files; no `NEXT_PUBLIC_` secrets. Keep offline recovery identities out of GitHub and Vercel.
5. **D5: protected preview rehearsal.** Resolve the current preflight conflict explicitly: the existing protected-preview mode intentionally forbids mail, push and outbound jobs. Keep that mode; define and test a separate restricted synthetic acceptance mode before exercising hosted signup/mail. Do not silently relax preview safeguards. Verify migrations with the approved direct connection on an isolated target, seed library data explicitly, then build/deploy with Vercel CLI. Startup/build must never migrate or seed. Current migration tooling rejects preview/production targets: implement and test a separate protected release migration contract before attempting either, not an environment-label bypass. Exercise actual hosted public browsing, signup/mail-link/onboarding, household joins, isolation, private photos and exports; verify outbound jobs remain disabled outside the designated acceptance target.
6. **D6: finish hosted reminders and push.** Configure a stable HTTPS origin, VAPID keypair/contact and opt-in permission UI; keep private VAPID material server-only. Use a scheduler with adequate frequency for per-person timezone windows, verified against the chosen provider plan/cost. The existing endpoint accepts authenticated empty POST requests: do not point an incompatible GET-only cron at it or change the auth contract to make scheduling appear successful. Use a dedicated scheduler credential, durable receipts and safe aggregate failure monitoring. Enable only after tenant isolation and explicit recipient opt-in. Verify subscription, test notification, actual scheduled notification, click/deep link, unsubscribe, denied permission, logout/revocation and expired-device cleanup on Android and installed iPhone/PWA. Retain browser/provider-fixture cases; record physical-device results separately, never infer delivery from HTTP success.
7. **D7: production cutover after acceptance.** Verify backups/private-storage restore and operator custody, mail domain/DNS, fixed auth origin, environment secrets, branch pins, production migration contract, monitoring and deployment protection. Obtain approval for the exact production target and any source import. Take a verified recovery point, apply reviewed backward-compatible migrations through the protected runner, deploy the tested commit, smoke-test public and authenticated paths, then enable approved schedules separately. Document rollback of application aliases and database compatibility; never automatically reverse data migrations or overwrite household state. Keep destructive reset disabled until its distinct recovery gate passes.
8. **D8: release later, not on every push.** After hosted and device acceptance, choose a version/tag for the exact deployed commit. Use `gh release` to prepare a draft with completed features, migration/configuration notes, known limitations and rollback guidance. Publish through an explicit protected approval; verify tag/commit/deployment correspondence. No secrets, private data, dumps or pulled env files in release assets. A successful CI run or preview is not a published release.

#### Required environment inventory (to verify at D2; names are not values)

| Group | GitHub storage and consumer | Vercel/runtime boundary |
|---|---|---|
| Deployment access | Protected deployment secret `VERCEL_TOKEN`; project/team ids as reviewed variables (`VERCEL_PROJECT_ID`, `VERCEL_ORG_ID`) | Token is deployment-runner-only, not an application runtime variable |
| Database | Environment secrets `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `NEON_API_KEY`; reviewed ids/hosts and `DATABASE_ENV` as variables | Pooled runtime URL; direct migration URL only for approved consumers. Keep project/development/production branch pins distinct and live-verified |
| Identity/mail | `BETTER_AUTH_SECRET`, `RESEND_API_KEY` secrets; fixed `BETTER_AUTH_URL`, `AUTH_EMAIL_FROM` variables | Separate by environment; no bootstrap secret in the final self-service flow; fixture mailbox flags forbidden in deployment |
| Private photos | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` secrets; `BLOB_STORE`, `BLOB_BUCKET`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` variables | Explicit private branch-bound store; preview restrictions retained; no filesystem fallback on Vercel |
| Push/reminders | `VAPID_PRIVATE_KEY`, `REMINDER_SCHEDULER_SECRET` secrets; `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `APP_TZ`, `REMINDER_SCHEDULER_ENABLED` variables | Private key only where actual sends are approved; scheduler gets only its invocation credential, not database/deploy secrets |
| Optional state sync | `STATE_GITHUB_PRIVATE_KEY`, `STATE_SYNC_SCHEDULER_SECRET` secrets; `STATE_GITHUB_*` target ids, `STATE_SYNC_HOUSEHOLD_ID`, consent classes and enablement variables | Dedicated household-pinned private target/least-privilege App; disabled until content consent passes |
| Optional vault/recovery | `VAULT_GITHUB_PRIVATE_KEY` and explicit runner database credential as protected secrets; vault target ids and public `BACKUP_AGE_RECIPIENT` as variables | Operator runner only, not Vercel. Private age identity never uploaded; production backup support/retention/pre-reset gates still require implementation and acceptance |

Only configure values required by the enabled feature/environment; do not copy all secrets to every job or runtime. Test fixture URLs, `POSTGRES_TEST_URL` and `POSTGRES_E2E_URL` remain disposable loopback CI configuration, not cloud credentials. Environment inventory and runtime validation must be updated alongside any new feature configuration. These stages are pending and do not claim remote secrets, workflows, schedules, deployments or a release were configured.

**Final local configuration, user-directed:** once feature acceptance is complete,
consolidate the actual local runtime configuration in one ignored, owner-readable
`.env.local`: isolated Neon development pooled/direct URLs, matching project/branch
pins and hosts, branch-verification API access, local auth origin/secret, timezone,
and the mail/push/storage variables needed by enabled features. Preserve existing
values; never guess live credentials, use production as a development fallback,
or enable outbound services merely to fill the file. The initial local file is
already present with development URLs and a local auth secret; API/mail credentials
are still absent. Verify real local startup and enabled account flows before
calling this setup ready. CLI commands still require explicit trusted environment
loading and disposable test targets; do not make test runners inherit the cloud
database as their fixture. GitHub/Vercel environment setup remains separate.

### Public-library implementation slice

The independent, read-only portion of H5 was implemented before H1-H4 because it neither opens registration nor changes household admission. Anonymous `/`, `/recipes`, `/ingredients` and their library details use dedicated library-only server renderers, with query-string search, linked components/ingredients, computed macros, methods/cues/tips, embedded technique cards, storage and ingredient sources. Routines are not publicly listed or served as recipe details. No household photos, saved links, feedback, personal targets or saved views are passed to these renderers. Public navigation has Recipes, Ingredients, Sign in and Create account; authorized members retain the existing app shell and loaders. Authenticated routines retain their existing route behavior.

Requests without the installed provider's session-token cookie do not initialize auth, mail or the database. Requests presenting a cookie still resolve membership server-side; expired/unverified/nonmember sessions receive only the public projection, and infrastructure failures are not hidden as anonymous success. Private routes/actions/image bytes/exports remain guarded. Actual built recipe/ingredient requests were also exercised with deliberately unavailable database/auth configuration.

Saved tests cover every library recipe/component and ingredient renderer, alias/cuisine search, routine exclusion, source-computed macros, public/private loader imports/order and optional-auth refusals. Two new Playwright journeys cover anonymous navigation, search/details, no household/photo controls or payloads, desktop/phone overflow and 404s; the existing anonymous-protection test now distinguishes library pages from private pages. **H1-H4 and self-service signup/email association are still not implemented.** This slice does not remove invitation/bootstrap gates or make the deployment multi-household safe.

### H1 expansion migration plan

Start H1 with a compatibility expansion, not an unsafe flag-day admission change:

1. Add `households` and nullable indexed household foreign keys on ownership roots: members, pending associations, people, plan setups/plans, shared feedback, prep state, pantry, saved views, sync state/jobs, recipe links, photos and photo decisions. Child rows inherit their parent plan/person/job and will get cross-parent checks with H2. Global content, auth identities/sessions/rate limits and the historical bootstrap audit are not tenant-owned library content.
2. In the same migration, if any legacy ownership-root row exists, create exactly one "Existing household" and assign all pre-migration root rows to it. Fresh empty targets stay empty so guarded SQLite import remains possible. Do not alter ids, human uids/timestamps/choices, existing membership roles, blob keys or frozen SQLite checksums.
3. During expansion, old code may still create null-owned rows; do not give these rows a guessed default household or mistake nullable columns for tenant enforcement. H1's next backfill/import integration and H2's scoped writers must remove this transitional state before making ownership non-null or opening signup. Preserve current conflict keys until their writers are scoped, then replace deployment-wide unique keys with household composite keys in the contract migration.
4. Exercise the actual generated migration on a populated pre-migration database and an empty database, checking every root's backfill, unchanged frozen checksums/human exports, repeat migration idempotency, foreign-key rejection and preservation on failure. Include native Postgres as well as PGlite and keep the existing browser/private acceptance intact. No live database migration is authorized or needed for this local slice.

**H1 expansion implemented locally:** migration `0010` adds the household identity table and fourteen nullable indexed ownership-root foreign keys. Populated databases backfill into one legacy household; empty/identity-only databases remain unclaimed and empty for guarded import. All 33 frozen SQLite table checksums remain identical. SQLite import dependency ordering now ignores target-only nullable foreign keys that are not part of the frozen source contract. The real migration journal passes empty/repeat/populated/failure-and-retry checks on PGlite and populated/failure-and-retry/repeat checks on native Postgres. **Acceptance: 1,752 tests in 86 files, thirty native checks and twenty-three retained browser cases**, with existing coverage gates, typecheck and database-free build passing. Overall statements 67.57%. No existing membership/role or human decision is changed; no live migration ran. **H1 is not finished:** post-migration imports/legacy writes still produce nullable ownership, and composite membership/shared-state keys and cross-parent constraints must be wired alongside scoped consumers before contract/admission.

### H1 import ownership integration plan

Guarded SQLite import is an operator migration, not household self-service. After its existing empty-target check, row insertion, frozen checksum verification and identity restarts, bind all imported ownership roots to one legacy household in the same transaction. Keep the binder in `lib/human/`, refuse an existing household or any already-owned root instead of merging/reassigning, and preserve every human field/uid/timestamp and existing source checksum. No generic request-time auto-backfill, signup bypass or new export of account/household identity is introduced. Test every imported root, failure rollback through an injected update error, refusal to bind existing households, no-op for empty input, unchanged human export/restore behavior and native imported ownership. Keep destructive-reset and live-transfer gates unchanged.

**H1 import integration implemented locally:** source restore now calls `lib/human/household-migration.ts` inside its existing exclusive transaction after verification/identity restarts. Empty/identity-only inputs remain unclaimed; an existing household is refused, and imported ownership roots receive one legacy identity without account membership or changes to human fields/source checksums. An injected ownership-update failure rolls back the whole import and new household, then a clean retry succeeds. The binder has a permanent 100% coverage gate. **Acceptance: 1,756 tests in 87 files, thirty native checks and twenty-three browser cases**, existing coverage gates and typecheck pass; overall statements 67.62%. This does not bind later legacy request writes, replace deployment-wide keys or authorize open signup; those remain in H1/H2.

### H2 scoped-consumer implementation plan

1. Add a separate authoritative household resolver that takes a session-derived user id and an explicit household selection, verifies current email/membership and household ownership of the linked profile, and rejects null/transitional or mismatched rows. Never derive permission from a household cookie/form id alone.
2. Add explicit household-scoped read/write building blocks, starting with people, plans, setup/profile/portion relationships and id checks. Require scope arguments, test two owners in distinct households and reject cross-household ids before mutation. Keep transitional one-household callers unchanged until the entire private surface is wired; do not expose new admission ahead of complete enforcement.
3. Wire shared feedback, pantry, prep, saved views, links/photos/decisions, routines and person-derived data, exports/sync/recovery/reset and reminders. Replace deployment-wide shared primary/unique keys and membership uniqueness only with their corresponding consumers. Last-owner and invitation acceptance locks become household-specific; account deletion handles all owned memberships explicitly.
4. Move page/action/route entry points to scoped access, verify all direct loaders and mutation guards in the inventory, backfill transitional rows only through a reviewed operator migration, and enforce non-null/composite cross-parent constraints. Prove the production call path, not only helper behavior, with retained native/browser cross-tenant tests. Only then open registration and email-first onboarding.

### H1/H2 first cross-parent constraint slice

Before widening the scoped APIs, add database enforcement for already-owned references: a plan and its setup must share a household; a membership or pending association and its selected person must share a household. Add reviewed composite parent uniqueness and foreign keys through Drizzle. Nullable transitional ownership still bypasses the new composite checks, so this is not the final non-null contract or permission to open admission. Bind imported people before dependent membership/association rows and setups before plans so immediate constraints preserve atomic import. Keep existing single-column delete behavior and frozen SQLite data/checksums unchanged. Test wrong-household parent rejection, same-household success, supported profile deletion, legacy-null compatibility, actual migration replay and native enforcement. Update strict schema parity only for these specifically reviewed additions.

**Scoped-core and first cross-parent slice implemented locally:** `resolveHouseholdAccess` resolves a server-authenticated account against a selected household, current email verification and its linked profile ownership. Its immutable, server-only scope is revalidated within mutations; membership and verification rows stay share-locked until commit. Explicit scoped APIs cover household people, individual profiles, plan lists/detail headers, atomic creation/regeneration/deletion and ingredient preferences. Owners cannot use foreign profiles/plans; portions/routine snapshots must reference selected household profiles. Existing atomic persistence is reused, with ownership written at initial setup/plan insertion rather than patched afterward.

Migration `0011` adds reviewed composite parent keys for memberships/invitations to profiles and plans to setups. Existing profile deletion still clears the optional person link without clearing household ownership. Immediate constraints require imported people before dependent rows. The generated SQL was reordered to create referenced unique indexes before adding their foreign keys. Upgrade tests refuse inconsistent owned rows, prove complete DDL rollback at each invalid relationship, and retry only after an explicit fixture repair; no automatic reassignment occurs. Native Postgres confirms cross-parent refusal and concurrent membership/verification revocation blocking. **Acceptance: 1,779 tests in 89 files, thirty-one native checks and twenty-three browser cases**, strict typecheck/database-free build and coverage gates pass. The new resolver/scoped-core modules are gated at 100% across statements, branches, functions and lines; overall statements 67.93%.

**H1/H2 remain incomplete:** these APIs are building blocks, not yet adopted by the existing page/action/route loaders. Legacy-null writers and global shared-state/membership keys remain, as do unscoped feedback/photos/exports/jobs. Current single-household callers/admission intentionally remain unchanged until complete private-surface enforcement. There is no claim of end-to-end multi-household safety or working code-free signup yet. Next bounded slice: scope person/plan-derived state and shared human-data writers with compatible key/export changes, then adopt the authoritative request boundary and prove production cross-tenant journeys.

### H1 legacy admission ownership / H2 member-management adoption plan

First close the remaining ownership gap in existing guarded admission; this is not the open-signup slice. The configured bootstrap claim creates one household on an empty target or explicitly claims the one already-migrated/imported legacy household. Refuse ambiguous multiple-household targets instead of guessing, and do not assign unowned human rows during a request. Persist household ownership when creating membership, invitation and onboarding-profile rows. Route existing profile save/delete actions through scoped writers so adding an unlinked household profile cannot reintroduce null ownership or permit an owner to edit a foreign profile. Scope existing owner actions, available/reserved profiles, last-owner checks, invitation resend/revoke/accept and target accounts to the acting household, preserving the current code-required admission until all other surfaces are isolated. Scoped account deletion must never count an owner in another household as its replacement. Preserve global membership/pending-email uniqueness for now; multiple-membership admission/switching needs its later coordinated schema/consumer contract. Add two-household owner mutation/refusal and rollback tests, and update synthetic fixtures to explicitly own their rows instead of relying on null ownership. Re-run existing auth/onboarding/account browser journeys and critical household coverage.

**Private-read adoption extension:** use the same verified scope on profile list/detail, account member/invitation/profile projections and onboarding existing-profile choices. Owners can read only their household; members retain own-profile privacy. Preserve first-call page guards and reauthorize selection from server session identity. Onboarding may resolve an incomplete membership, but must never redirect a null-owned/corrupt membership into an access loop or expose global profile choices. Add explicit refusal UI for transitional ownership requiring operator migration. Retain real browser list/detail/account assertions while foreign synthetic profiles exist, plus owner/member/stale-scope tests on the projection helper. Remaining planner/shared-state loaders stay explicitly unfinished until separately adopted.

**Adoption acceptance:** guarded bootstrap claims bind one existing migrated/imported household or atomically create one; ambiguous targets refuse. Invitation/member/profile writes retain ownership, role/removal/profile-link/invitation controls reject foreign targets, and final-owner checks never count another household's owner. Profile save/delete and private profile/account/onboarding reads now use verified household scope. Account-before-membership lock order matches account management. Full pre-read-extension acceptance passed **1,794 tests / 89 files / thirty-one native checks**; the read extension passes **199 targeted tests**, resolver/household/scoped-plan/account modules at **100% coverage**, all **twenty-four browser cases**, typecheck and production build. Browser cases include real owner foreign-id read/edit/delete refusal, profile create/edit/reload/delete, account-list privacy and existing signup/device flows. Unscoped planner/shared-state/photos/export/jobs and multiple-membership keys remain unfinished; signup remains intentionally gated. Deployment extension D1-D8 is recorded above, not executed.

### Household-safe reminder context plan

Remove the deployment-wide latest-plan/private-query dependency from the real dispatcher. Traverse only verified, currently session-backed household/profile associations; null or mismatched ownership is ineligible. A dedicated read-only system loader selects the latest plan/setup for the recipient's household and validates all selected profiles, portions and routine snapshots before building prep with the existing shared pure helpers and library data. Scope completed-task reads by household and plan key; do not run tick migration or other human-state writes during scheduling. Do not use personal preferences/feedback to build a notification. Recheck ownership in batch admission, device claim and manual test-send eligibility. Preserve existing timezone/window, daily claim, durable receipt/retry/ambiguity semantics and no-network-in-transaction rules. Explicitly update disposable reminder/native/browser fixtures to own rows. Add two-household task isolation, corrupt-reference refusal, unowned/revoked account and provider dispatch coverage, and rerun actual scheduler browser journeys. Hosted scheduling/provider/device acceptance stays pending.

Freeze the source household on each new reminder batch and require the same
profile/membership household at admission and device claim. Add a nullable
foreign key through a generated migration; historical batches remain null and
cannot be sent because their message source cannot be established safely.
Do not backfill old messages from the recipient's current household. Read each
plan/task projection in a repeatable-read transaction so concurrent plan
regeneration cannot mix setup, slots, portions and routine snapshots.

**Regression repair within this slice:** production plan creation now requires
owned profiles, so its wizard must load only the request household's people and
last setup. Cover these query boundaries with two-household fixtures. Browser
shared-plan fixtures must explicitly belong to their synthetic household, and
the synthetic authorized member must join that same fixture household rather
than implicitly accessing another household's imported plan. Scope prep tick
migration and reads by the plan's household so scheduled and interactive task
completion agree without rewriting another household's legacy ticks. Retain
the real shared-owner/member prep and plan-generation/reload browser cases.

**Acceptance:** all 1,824 tests in 92 files pass with native Postgres and all
configured coverage gates; all 24 retained browser cases and typecheck/build
pass. Context and delivery coverage is 100% across statements/branches/functions/
lines. Additional prep edge cases cover scoped legacy migration, rollback on a
foreign completion collision, owned merge, missing/unowned-plan refusal and
task projection; prep now has a permanent 100% gate. The first full browser run
caught the unscoped wizard/incorrectly owned fixture regressions; these were
repaired without restoring cross-household access. Hosted schedules remain off.
The independent D3 credential-free aggregate CI gate and immutable action pins
are documented and tested in `plan-ci-delivery.md`; they do not enable deployment
or change protected-branch requirements.

## Current delivery status

### Next H2 slice: request-owned plan projections

Before opening admission, replace request-facing global latest-plan, plan-list
and plan-view reads with verified household scope. Reuse the existing scoped
header/list helpers; a foreign plan id must return the same missing result as a
nonexistent id, including export and RSC callers. Validate every selected profile
and portion before returning the full plan view. Routine snapshots, grocery
checks, part modes, milestones and batch-prep ticks must verify the owned parent
before reading children. Foreign/corrupt references must not be silently dropped
or rendered. Keep library data unchanged and preserve household members' shared
plan access; individual profile editing rules are unchanged.

Acceptance: two-household backend cases for latest/list/view and child
projections, revoked membership and malformed cross-parent references; actual
browser requests for foreign plan detail/prep/export and parameterized groceries
must not reveal the foreign household's plan. Retain valid same-household
generation, swap, regeneration, prep and file-export flows, and rerun native
coverage, types/build and the saved browser suite. This slice does not claim
unconverted mutation/shared-state/photo/sync consumers are isolated; admission
remains gated until those and the schema contract are complete.

**Plan-read acceptance:** 1,830 tests / 92 files pass including native Postgres
and all coverage gates; all 25 browser journeys, typecheck and production build
pass. The retained foreign-household browser case checks a newer unrelated plan,
detail/prep HTML and RSC, parameterized groceries, PDF/XLSX export, home and setup.
Backend cases cover revoked verification/ownership, invalid selected profiles,
foreign portions/routines and scoped child loaders. No deployment occurred.

### Next H2 slice: transactional plan and shopping mutations

Adopt an authoritative owned-plan transaction around slot locks, portions,
swaps, grocery/manual items, prep completion, plan milestones and part modes.
Resolve request membership first, refresh it and lock the same household's
plan/setup inside the write transaction, then run existing child consistency
checks. Reuse scoped regeneration/deletion helpers; do not move a plan or
reinterpret a foreign child id as an owned one. Manual-item operations derive
the parent from the persisted row, not a client claim. Keep finite portion
limits and avoid partial shake enablement if regeneration fails.

Add direct transaction tests for cross-owner refusal, stale membership,
callback non-execution, rollback and valid writes. Retain and extend actual
captured-action replay cases for foreign household ids, plus same-household
swap/lock/regeneration/shopping/prep reload flows. Run targeted backend coverage,
full native regression, types/build and saved browser cases before committing.
Photo/feedback/saved-view/sync writers and the membership/schema contract remain
separate pending slices; open signup stays blocked.

**Mutation acceptance:** 1,836 tests / 93 files pass, including native Postgres
contention checks that membership revocation, verification changes and a
competing plan write cannot pass the active mutation transaction. All 25 saved
browser journeys, typecheck and production build pass. The captured-action case
replays a real lock action against another household and verifies refusal without
a write; existing same-household editing/shopping/prep flows still persist.
Corrupt selected profiles, stored portions/routines, stale membership and
foreign/missing children are refused before writes; failed shake regeneration
rolls its setup change back. Household core coverage retains its 100% gate;
overall statements are 70.25%. No public admission or deployment was enabled.

### Next H2 slice: profile preferences, routines and daily habit requests

Dependencies: reuse verified household resolution, scoped profile lookup, the
existing routine validator/human writer and transaction lock order. No schema,
remote resources, admission or human-data export format changes belong here.
Replace global request profile/preference/routine/today-habit reads with an
owned-profile boundary. Household members may read household profiles for shared
planning; missing/foreign details must be unavailable, never an empty
success-shaped preference or routine projection.

Add an owned-profile mutation transaction that refreshes verification/membership,
requires a linked profile, enforces owner-or-self editing, locks the selected
household profile and only then invokes the existing writer. Adopt it for routine
choices and daily habit completion. Preserve routine validation, human sync
marking, schedule defaults and existing profile rules; expected ownership failures
are explicit action errors, while infrastructure errors propagate.

Acceptance: two-household request-loader tests for detail/preferences/routines/
today habits, missing profiles and stale verification; real action cases for
foreign-owner refusal, member self-only edits, valid household-owner edits,
rollback and existing routine validation. Native contention must hold membership
and verification stable during the profile callback. Retain a browser journey
that changes/reloads a routine, replays its captured action against a foreign
profile and verifies no foreign write. Run focused tests, full native coverage,
saved browser cases, types and build before committing. Feedback, pantry, saved
views, photos/links, exports/jobs and composite/non-null schema remain separate
pending boundaries; this slice does not enable open signup.

**Profile-request acceptance:** 1,840 tests / 93 files pass with all existing
coverage gates, including the household core's 100% gate. Overall statements are
70.57%. All 26 retained browser journeys, typecheck and production build pass.
Exact owned preference/routine/today-completion payloads and the other
household's independent empty state are covered, alongside foreign/missing
profile refusal and stale verification. Actual actions cover owner/member-self
rules, routine validation and rollback of both the choice and sync marker on a
database failure. Native contention blocks concurrent membership revocation,
verification changes and profile edits during the callback. The new mobile
journey taps the routine label, reloads persisted state, replays the action
against another household, confirms no write and restores the original toggle.
No deployment, schema contract or admission gate changed.

### Next H2 slice: household saved list views

Scope: isolate recipe/ingredient saved defaults and list reads without changing
filter syntax, anonymous browsing, human export bytes or the existing operator
import/export path. Request reads must use authoritative household scope; writes
must refresh verified membership and require a linked profile. Serialize changes
on the household row so simultaneous saves cannot create two defaults for one
list. Extend the existing human writer with explicit ownership predicates and
persist ownership on inserts; legacy operator calls address null-owned rows,
never another household's default. Keep all writes through lib/human and retain
its atomic sync marking. Sync marker composite keys and operator export isolation
remain separate gated work; this stage does not claim them complete.

Acceptance: two-household saved/default reads, independent save/update/clear and
stable uid; unowned legacy rows must not become request defaults or be rewritten.
Cover stale membership, incomplete profiles, transaction rollback and concurrent
native saves. Retain real browser save/reload/clear plus captured foreign-context
checks where applicable (actions accept no household id). Run focused tests,
full native coverage, browser suite, types and build before committing. No remote
resource, credential, production data or signup changes.

**Saved-view acceptance:** 1,843 tests / 93 files, all 27 retained browser
journeys and production build pass. Follow-up focused coverage and typecheck
pass with a permanent 100% statements/branches/functions/lines gate on
`lib/server/saved-views.ts`. Native six-way concurrent saves produce one
household default; clearing it preserves the other household's default.
Actions preserve uid on update, ownership/creator on insert, explicit validation
and stale/unverified/incomplete-profile refusal. Database failure rolls back
save/clear and sync marking together. Mobile save/reload/clear preserves a
separate household's private default. Unowned rows are neither adopted nor
changed by requests; operator import/export and sync-marker ownership remain
pending. No remote changes occurred.

### Next H2 slice: household recipe feedback and candidate filtering

Dependency: recipe feedback still has a recipe-only primary key. Replace that
key with a unique household/recipe key that treats null ownership as one legacy
namespace; preserve every row, uid and reference in a generated migration.
Personal feedback remains keyed by profile/recipe. Scope shared read/updates and
candidate filters to the verified request household and validate selected
profiles before reading their personal choices. Never apply another household's
hidden/tested state or ratings to a plan.

Wire the real feedback action to an owned-profile transaction using its
authoritative linked profile, and keep personal choices plus shared tested/notes
changes and sync marking atomic through lib/human. Serialize shared feedback
changes on the household row, retaining stable uid and update semantics.
Legacy human writer/operator calls address the null-owned namespace explicitly;
operator multi-household export/import/rename support remains gated and must not
silently flatten duplicate household records.

Acceptance: migration preservation/replay and same-recipe independent household
rows, scoped personal/history/candidate payloads, foreign selected-profile and
stale-member refusal, valid rating/hide/tested changes and rollback. Add native
concurrent same-household feedback changes and a real-browser same-recipe action
case proving the other household's feedback stays unchanged. Preserve existing
rating/testing semantics and human round-trip tests. Run targeted tests, full
native coverage, browser acceptance, types/build before committing. No signup,
cloud migration, secret or deployment changes.

**Feedback acceptance:** migration `0013` preserves existing feedback and replaces
the recipe-only primary key with `UNIQUE NULLS NOT DISTINCT(household_id,
recipe_id)`, retaining a single legacy null namespace. Drizzle generated a
placeholder for the old constraint name; its baseline name was verified against
native Postgres and recorded explicitly in the migration. Seed does not invent
null-owned duplicates for already-owned feedback.

All 1,848 tests / 93 files pass, including native concurrent partial feedback
changes and independent same-recipe household rows. All 27 saved browser
journeys, types and production build pass. Feedback projection and personal
writer modules retain 100% statements/branches/functions/lines; shared human
writer coverage is 98.66% lines, overall statements 70.99%. Request cases prove
foreign selected profiles cannot influence candidates or personal/history
payloads; actual actions revalidate profile ownership and commit personal/shared
changes atomically, including rollback on sync failure. Browser replay preserves
another household's same-recipe history and never renders its private note.
Unscoped duplicate-history reads, operator exports/imports and renames fail
explicitly rather than flattening household rows. Multi-household operator
formats and scoped sync remain pending; no hosted migration or admission change.

### H3 slice: single-use email-link continuation

Installed-provider findings: Better Auth 1.7.12's built-in verification link is a
signed stateless JWT, not a hashed atomic single-use record. Its magic-link
plugin supports `storeToken: "hashed"` and atomic consume, establishes a session
in the browser context that opens the link, and can keep signup disabled. For an
unverified pre-existing account it deliberately revokes pre-proof passwords and
sessions before marking the mailbox verified. Preserve that protection rather
than silently restoring an unproven password.

Scope this stage to verified continuation for existing accounts, before opening
new account admission: install the provider magic-link plugin with signup
disabled, five-minute hashed single-use records and persistent rate limits.
Wire separate required link delivery through the existing fixed-origin mail
transport and synthetic-only local mailbox; no credential or logging fallback.
Use fixed application callbacks for onboarding and explicit sign-in error pages.
Do not disclose account or household existence through the send response; send
the same generic response for missing accounts. Bound failure/retry explicitly
and do not leave a usable unsent token after a delivery failure.

Add "Use an email link" to the existing sign-in UI without removing password,
OTP recovery or the still-gated signup flow in this preparatory slice. A reloaded
page can resend a link; the link itself establishes the opening context's real
provider session. Keep tokens out of React props, app URLs beyond the provider
verification endpoint, logs and public payloads.

Acceptance: real HTTP send -> synthetic mailbox -> distinct browser context ->
provider verification -> selected/incomplete onboarding; no original-window
false success; expiry/replay/concurrent consume, wrong/foreign callback refusal,
missing account, unverified account cleanup, send failure/retry and persistent
throttling. Retain browser cases and backend/provider transport tests, preserve
critical coverage gates, then full/native suite, all browser cases, types/build.
No live mail, credential provisioning, public signup or deployment.

**Local acceptance, 2026-10-24:** implemented the existing-account continuation
slice. Full suite: **1,963 tests / 96 files**, including forty native Postgres
cases; all **34 retained browser journeys** pass, as do types, production build
and unchanged critical gates. Overall coverage: statements 72.63%, branches
62.61%, functions 62.50%, lines 73.97%. The browser opens a real synthetic
mailbox link in a separate context, verifies session restoration/incomplete
profile onboarding, proves the original window is still anonymous, then
exercises replay refusal and a real resend. Native independent providers consume
one link into exactly one session. Transport tests verify code/link content and
private synthetic mailbox storage. Unknown accounts receive the same send
response but cannot create an account in this slice. Fresh signup, verified
email associations and the household-creation UI remain pending. No new
migration, live delivery, credential provisioning or deployment occurred.

**Linked lifecycle follow-up plan:** include pending magic-link proofs in
confirmed account deletion's existing token revocation transaction. Otherwise a
previously issued link could outlive deletion and target a later account using
the same email. Match the installed provider's JSON email record only inside
the `magic-link:` namespace, guard malformed non-JSON rows, and preserve other
mailboxes' proofs and shared household state. Add an actual provider
send/delete/recreate/replay test plus an unrelated recipient's still-usable
link, extend deletion rollback fixtures, and repeat full/native/browser/type/
build acceptance before closing the follow-up. No change to signup gates or
remote permissions.

**Acceptance blocker / corrective plan:** the full browser suite exposed
pre-hydration plan clicks being discarded: an SSR-visible Generate control
returned no navigation in one run; after reload an SSR-visible Lock control
sent no POST in another. The retained trace confirms the click without its
mutation; the unchanged isolated flow passes. Fix the user-visible race, not the
test timeout: reuse/extract the profile form's hydration signal for plan controls
and keep setup controls disabled until its existing stored-draft restoration
finishes. Retain an intentionally script-delayed browser case proving controls
are disabled before hydration, become usable after release and actually
generate/lock/reload. Preserve layout, draft restoration and existing mutation
behavior; rerun the full acceptance suite without relaxing retries or timeouts.

**Corrective acceptance / session handoff, 2026-10-24:** token revocation now
handles mixed-case provider email records safely and preserves other recipients'
usable links, including through native final-owner contention. The actual
browser deletion flow refuses a previously issued link. Setup/plan controls
wait for readiness; the shared profile/plan hydration signal has a 100% gate and
a retained deliberately script-delayed browser case. Final serial pipeline
passed **1,965 tests / 97 files**, all **35 browser journeys**, types/build and
all critical gates. Coverage: statements 72.68%, branches 62.61%, functions
62.62%, lines 74.00%. Public signup, email associations and household creation UI
remain pending. See the resume section at the top of `docs/handover.md`.

### H1/H3 foundation: isolated household creation and legacy quarantine

**Local acceptance:** a new server-only session primitive validates the name,
locks the verified account before the live exact session, refuses every existing
membership and atomically creates an empty household/owner membership/selection.
Null legacy rows remain quarantined; no profile, plan, photo, feedback, bootstrap
or other-session row is adopted or changed. Unit tests cover invalid identity,
names, existing/quarantined/plural membership, failed writes and selected-profile
completion. Native twelve-way creation across different sessions of one account
produces exactly one household, leaves losing sessions unchanged and permits a
separate account's independent household. All **1,949 tests / 95 files**,
**33 retained browser journeys**, types/build and existing critical gates pass;
session service remains **100%** on all metrics; overall statements **72.61%**.
No public action/UI exposes creation and signup remains gated pending the
email-link/association stage.

Decision: retain nullable ownership as an explicit operator-staging/quarantine
namespace, not as an implicit first user's household. Existing verified request
resolvers exclude it; legacy binding remains an exclusive empty-target operator
import operation. Do not rewrite historical/null human rows or use "first
household" adoption during self-service creation. A future physical NOT NULL
contraction would require migrating operator staging/import contracts first.

Implement the transactional creation primitive before exposing admission. It
takes an exact server-derived provider SessionIdentity and a validated household
name, locks/rechecks the verified account and live database-clock session, and
serializes creations for the same account across sessions. Refuse any existing
membership (including quarantined/null); create a fresh household with only that
account's owner membership and select it in that session with a monotonic version.
Do not create/move a profile, claim bootstrap state, copy shared human data,
touch other sessions or implicitly accept pending associations. Profile setup
continues through the already selected-household writer. Other accounts may
independently create their own household. Signup and invitation gates remain
unchanged and this primitive has no action/UI until the email-admission stage.

Acceptance: missing/unverified/wrong-owner/expired/deleted sessions, invalid names,
existing/null/multiple memberships, exact source-row and other-session
preservation, atomic rollback on membership/session-write failure, successful
profile completion in the fresh selected household and no adoption of quarantined
people/plans/feedback/photos. Native concurrent attempts from multiple sessions
of one account produce exactly one household; independent accounts remain
isolated. Preserve permanent 100% session-service gates. Run focused tests before
full/native coverage, retained browser compatibility, types and build. No remote
database operation, open signup, cloud credential or deployment is authorized.

### H2 slice: household-preserving operator recipe renames

**Local acceptance:** shared feedback moves only to a target in the same
household; human target choices remain unchanged. Links and photos append using
that household's positions and cover state. Personal conflicts remain per person.
Every moved class updates the actual household revision, including null legacy
rows. The entire operator rename map is transactional, so a later class failure
also restores earlier in-place slug changes. Two-household-plus-legacy tests
check exact row identity, creators, creation timestamps, cover/order conflicts,
owned revisions and idempotence; native trigger failure proves cross-class
rollback. All **1,939 tests / 95 files**, **33 retained browser journeys**,
types/build and existing critical gates pass; overall statements **72.58%**.
No human choices were edited outside synthetic fixtures, and no remote seed,
migration or deployment ran. Null-ownership contraction and code-free admission
remain pending.

Before admission, complete the library seed's operator rename path without
granting household owners global library authority. The public slug is global,
but human feedback conflict decisions, link/photo ordering and photo-cover
decisions must remain per household, including the explicit null legacy
namespace. A target's feedback/cover in one household must never suppress or
overwrite another household's source. Preserve uid/creator/created timestamps,
existing target human choices, photo bytes and plan recipe references.

Use the existing human classes rather than another rename engine. Group shared
class moves by their stored household, and mark each changed household revision
in the same transaction. Personal feedback keeps per-person conflict semantics;
derive its revision namespace from the person's stored household. Make the
complete applyRenames operation transactional so a later class failure rolls
back earlier class changes and slug/deletion changes. Keep current seed's
transaction nesting and historical unclaimed round trips compatible.

Acceptance: two households plus null legacy namespace, same source/target
recipes, mixed touched/untouched target feedback, independent link positions and
photo covers, per-person conflicts and exact owned revisions. Add whole-operation
failure injection/idempotence and native transactional rollback. Existing native
seed and all retained public/private browser journeys must remain green alongside
full coverage, types and build. No data-file edit, remote seed/migration,
household write endpoint or manual human decision is part of this stage.

### H2 slice: fail-closed legacy human-bundle boundary

**Local acceptance:** legacy export now refuses multiple households before
serialization; legacy import refuses every claimed target. Catalogue SHARE locks
cover all class work, and all legacy import/export writes are transactional.
Native contention proves household creation is blocked through both operations,
then succeeds after commit. New tests cover refusal without stamps, v1/v2 claimed
import denial, scoped compatibility and rollback of earlier writes when a later
class fails. All **1,936 tests / 95 files**, **33 retained browser journeys**,
types/build and critical coverage gates pass; the new boundary has a permanent
100% all-metric gate. Overall statements **72.54%**. An initial concurrent
build/native/browser run hit existing setup/interaction timeouts; serial native
and browser reruns passed unchanged. This is not a namespaced multi-household
bundle format or completion of operator renames/null-ownership contraction.

Scope: the version-1/version-2 human-file bundle has no household identity and
cannot safely represent multiple households. Before opening admission, refuse
unscoped legacy export whenever the database contains more than one household;
keep verified explicitly scoped shared exports unchanged. Refuse legacy import
into a database containing any household, even if recipe slugs happen to match.
Legacy imports remain available only in an unclaimed operator staging target.
Whole-instance encrypted SQL backup/recovery retains its separate existing
identity-preserving format; do not replace it with a flattened human bundle.

Dependencies and permission boundary: existing exporters/importers and the
verified household export service remain in use. No new route/action, operator
credential, cloud operation, namespace format or household-owner import is added.
Hold a Postgres SHARE lock on the household catalogue inside the same transaction
as serialization/import, so concurrent household creation cannot race the
preflight. Keep all class writes atomic, including legacy export stamps and
imports that encounter malformed later files. Do not silently skip mixed tenants
or guess an import destination. Operator library renames and null-ownership
contraction remain distinct follow-up work.

Acceptance: retain v1/v2 byte-stable/idempotent unclaimed round trips and existing
single-household operator export compatibility; prove two-household export
refusal before stamping, claimed import refusal before writes, scoped export
compatibility and complete rollback on later serialization/import failure.
Native TCP tests must show a concurrent household insert blocked until legacy
bundle work commits. Run focused backend coverage first, then full/native
coverage, existing retained browser journeys, typecheck and build. There is no
new browser surface; retain and rerun the existing private download/chooser
journeys rather than invent an operator UI.

### H2 slice: visible selector and selected-household management

**Local acceptance:** Account now links to a verified household chooser; ambiguous
onboarding uses the same chooser. Selection is session-bound, explicitly retried
after network/revocation errors, and replaces the document to discard old router
state. Profile creation/linking and member management revalidate the selected
capability in their write transaction. Invitations issued by plural-household
owners resolve the issuer in the invitation's household, never by first match.
The real browser journey exposed pre-hydration profile edits being discarded;
profile controls now remain disabled until client state is ready. Retained cases
cover that first edit, reload, incomplete-profile completion, foreign selection,
switch-back without profile/plan changes, mobile overflow/tap targets and two
independent provider sessions. Browser fixtures identify their actual cookie-bound
session instead of assuming there is exactly one database session after retries.
All **1,930 tests / 95 files**, **33 retained browser journeys**, types/build and
critical coverage gates pass; overall statements **72.51%**. No admission, remote
migration, deployment or release is enabled by this slice.

Before widening admission, expose selection only to verified provider sessions.
Add a dedicated household page reachable from Account, and show the same chooser
on onboarding when multiple memberships need selection or a stored selection was
revoked. List names only after verified session/database checks. Select through
a validated Server Action using server-derived identity, return only the
household/profile-completion result, and replace the document on success to
discard the prior household's router cache. Surface transport and revoked-target
errors explicitly with retry. Preserve each other session's selection.

Onboarding resolves the selected session for incomplete profiles. Extend existing
profile creation/link and invitation/member management functions to accept a
verified household capability, refresh it in their existing transaction and
reject account/scope mismatch or a stale session selection. Legacy operator
callers remain exactly-one only. Carry selected access through the actual
onboarding actions, including owner actions; no user can supply actor identity
or an arbitrary profile grant. Keep final-owner and cross-household checks.
Normal signup/second-household admission remain unchanged in this slice.

Acceptance: backend real-action selector validation, anonymous/expired/foreign
refusal and selected profile/management operations with two memberships;
transaction/stale-selection rollback and unchanged foreign rows. Retained real
browser chooser selects an incomplete household, creates a profile, reloads,
switches back to original shared data, and proves a second session is unchanged;
network failure/retry, revoked choice, mobile overflow/tap targets and captured
foreign-id actions are covered. Run full/native coverage with critical gates,
all browser journeys, strict types and production build before committing.
No live database, secrets, remote deployment or destructive reset changes.

### H2 slice: session-bound private request adoption

Dependencies: session selection storage/capabilities passed full local acceptance.
Carry that verified capability out of the authoritative member guard, without
returning session ids in any response or accepting them from a form. Resolve the
provider session once at the boundary; independently recheck database account,
exact session/expiry, selected membership and linked profile. Convert expected
household refusals into the existing uncached access-denial/page redirects, while
unexpected infrastructure failures continue to propagate.

Replace single-membership guesses in private plan/profile/shared-state queries,
actions, private photo bytes, account projections and interactive sync with a
shared member-to-household resolver. Preserve the session/version binding through
transaction refresh. Trusted internal callers without a bound request capability
remain constrained to exactly one household; this is transitional compatibility,
not a client-controlled fallback or support for ambiguous memberships. Reject a
capability whose account, role or profile disagrees with the member projection.

Acceptance: actual guards refuse missing/expired/foreign/unverified sessions;
selected membership drives role/profile and all adopted private surfaces.
Backend tests exercise bound-scope mismatches and preserve legacy trusted test
callers. Retained browser coverage uses two genuine provider sessions for the
same synthetic account, selects separate households in fixture SQL, verifies
isolated account/profile views and captured foreign-plan action refusal, then
cleans only the synthetic fixture. Also retain the unselected-ambiguity refusal
journey. Run full coverage/native locking, browser, types and build.

This slice does not expose a switcher or change admission. Onboarding management
and selector UX remain the next coordinated slice; no second membership is
created by a normal user yet. No cloud operations or secrets changes.

Acceptance complete locally: the authoritative member guard derives exact
provider identity and carries a verified session-bound capability; all adopted
private reads/actions/photo delivery/account projections/interactive sync use
the shared resolver rather than guessing a membership. Expected scope/session
refusals retain private denial semantics, and unexpected failures propagate.
All **1,924 tests / 95 files**, **32 retained browser journeys**, types and build
pass; existing critical gates remain intact, overall statements 72.61%. The new
real-provider two-session browser case verifies separate account/profile views,
correct private download and captured foreign-plan write refusal for one account
in two selected households. The revoked-membership case now asserts the current
selection-required message rather than the old onboarding copy. Selector and
onboarding-management UX remain pending; no normal-user admission was widened.

### H1/H2 slice: session selection storage and verified capability

Dependencies: composite membership identity is accepted locally. Before wiring a
switcher, add an internal nullable active-household preference to each Better Auth
session and a nonnegative selection version. Existing sessions retain null/zero;
do not change tokens, expiry, provider identity, memberships or profile links.
Manage both columns through Drizzle; the active household foreign key clears on
household deletion. The Better Auth adapter need not expose these server-only
columns or accept them in login/signup input.

Implement transactional services taking only identity obtained from a verified
provider session (user and session ids). Recheck the database account, exact
session ownership and database-clock expiry; lock account before session before
membership. List only current owned memberships. Resolve an explicit stored
selection only if membership still exists; never silently switch after revocation.
Null selection may use the existing exactly-one-membership compatibility rule.
Selecting an available household may lead to incomplete profile onboarding, but
never creates/moves a profile or joins a household. Only a changed selection
increments its version; never alter another session's preference.

Bind resolved household capabilities to session id, selected preference and
version. Refresh inside existing mutation/export transactions must recheck that
session and reject expiration, revocation, switching (including A-B-A), and an
ambiguous formerly-single membership before invoking any callback. Independent
operator/test capabilities without a session retain their explicit scope.

Acceptance: actual migration preserves preexisting session bytes plus null/zero
defaults and enforces preference/version constraints. Backend coverage includes
two sessions of one account, completed/incomplete memberships, no-membership
and stale selection, unverified/foreign/deleted/expired session, idempotent switch,
switch-away-and-back, mutation rollback and injected selection-update failure.
Native tests exercise selection-vs-mutation locking. Run existing auth/browser
journeys to verify provider compatibility, strict coverage, types and build.
This bounded foundation intentionally exposes no switch action/UI and changes
no current request consumer/admission; the next slice wires the selector and
all private request surfaces together. No remote operations or secrets changes.

Acceptance complete locally: migration `0018` adds server-only session preference
and version without changing provider fields. Transactional list/select/resolve
services recheck verified identity, exact session/expiry and membership; refreshed
capabilities retain their session binding and reject stale selection, including
A-B-A, expiration/deletion and newly ambiguous default selection. Existing
explicit operator capabilities remain compatible. All **1,923 tests / 95 files**,
**31 retained browser journeys**, types and production build pass; the new session
service and existing resolver retain permanent 100% gates, overall statements
72.58%. Native mutations hold the session selection lock through commit and
refuse old capabilities after a switch. No selector HTTP action/UI or private
request adoption is claimed; those remain the next coordinated slice.

### H1/H2 slice: plural membership identities and fail-closed compatibility

Dependencies: scoped private consumers, reset/export/sync boundaries and owned
profile foreign keys are already present. Before introducing session selection,
replace the deployment-wide membership user primary key with null-safe uniqueness
on household and user. Preserve every existing row, profile link, role and date;
keep the unique profile/account link and composite profile ownership constraint.
Use Drizzle generation and test the actual upgrade journal, including nullable
legacy memberships. Do not enable second-membership admission or open signup yet.

Permission boundaries: single-household request and management entrypoints must
refuse multiple memberships, including an incomplete second membership, rather
than choosing the first complete profile. Role changes, removals and profile
links must update only the actor's resolved household even when the target
account has other memberships. Removing one membership may still invalidate all
account sessions conservatively, but must preserve other memberships, profiles
and devices. Account deletion is deliberately account-wide: validate a replacement
owner in every affected household before deleting any personal feedback/devices
or the account. Keep the existing deployment admission lock during this bounded
compatibility slice; per-household admission and explicit selection follow.

Acceptance: migration preserves pre-upgrade membership bytes and permits the same
user in distinct households while rejecting duplicates in each namespace,
including null. Backend tests exercise ambiguous actors, incomplete second
profiles, isolated target role/link/removal updates and account-wide last-owner
rollback/cleanup. Native Postgres proves concurrent composite uniqueness. Retained
Playwright cases replay the real request boundary with an additional membership
and verify refusal without private content or mutation, then recover after its
removal. Run critical coverage gates, types and build alongside the existing
browser journeys. No live migration, remote changes, secrets or deployment.

Acceptance complete locally: migration `0017` preserves membership bytes and
permits independent null-safe household/user identities without weakening profile
ownership. Single-membership management/request boundaries refuse ambiguity,
including an incomplete second profile; role/link/removal writes stay in the
actor's household. Account deletion validates replacement owners in every
membership before account-wide cleanup. All **1,901 tests / 94 files**, **31
retained browser journeys**, types and production build pass; existing 100%
auth/household gates remain intact, overall statements 72.51%. Native twelve-way
inserts yield three independent winners and nine unique-constraint refusals.
The first browser run exposed an old user-only restoration upsert in its revoked
membership fixture and an ambiguous alert locator; both retained cases now use
the composite key/specific banner, and the full browser suite passes. Explicit
session selection and plural-membership admission are not enabled by this slice.

### H2 slice: household reset boundary, gate still closed

Scope: give the owner Settings action a verified household reset service rather
than the deployment-wide operator helper. Reuse its existing scopes and typed
confirmation; do not enable reset or change backup consent. Resolve membership
before the backup gate and refresh it again in the destructive SQL transaction.
Filter all roots and profile/plan children by ownership; preserve foreign and
null-owned data. Profiles/all must refuse cross-household references rather than
let cascades alter another household's records. Keep auth accounts/household
memberships; deleted profile links become incomplete onboarding as before.

Photo keys must be captured from deleted owned rows and removed only after SQL
commit, outside locks. Never list/delete the whole shared BlobStore from a
household request. Surface cleanup failure as a post-commit partial cleanup,
not "nothing was changed"; keep unexpected infrastructure errors sanitized and
logged. The legacy global reset helper remains operator-only.

Acceptance: every scope tested against two households plus null data, unchanged
library/auth/foreign records and photo bytes, atomic marker/SQL failure, stale
and non-owner refusal, foreign-reference refusal and explicit blob cleanup
failure. The actual Settings action and retained browser case still report the
closed Postgres recovery gate and mutate nothing. All existing backend/native,
browser, types/build gates remain. No real reset or recovery is authorized.

Acceptance complete locally: the actual owner action now resolves verified
household context before the closed backup gate and calls only the scoped reset
service. Human-owned SQL lives in `lib/human/reset.ts`; the service refreshes
membership, serializes household/plan/profile changes, and cleans captured owned
photo keys after commit. Profile deletion refuses foreign plan/setup/routine,
authorship or reminder references. Auth accounts and memberships remain; deleted
profiles require onboarding again. Foreign and null rows/bytes are preserved.
Settings text describes household scope, retained accounts and the closed gate.

All 1,890 tests / 94 files, 30 retained browser journeys, types and build pass.
The human reset writer and server boundary both have permanent 100% coverage
gates; overall statements 72.47%. Native Postgres verifies SQL commits before
owned blob cleanup; failure cases distinguish rollback from post-commit cleanup
failure. The new actual browser test attempts ordinary and typed resets and
verifies the recovery gate leaves plans/profiles/photos unchanged. No real reset,
backup enablement, remote operation, signup or deployment occurred.

### H2 slice: pantry and prep identity namespaces

Scope: replace ingredient-only pantry and date/task-only prep identities with
null-safe household-composite uniqueness. Preserve every existing row and null
legacy ownership; never adopt or reassign rows during migration. Pantry has no
request mutation today: change only its storage identity, not product scope.
Update actual prep completion and legacy-key migration to upsert on owned
identity so a foreign completion does not block an independent owned completion.
All reads remain household-filtered. Retain database-enforced duplicate refusal
within each household and the null namespace.

Dependencies: accepted verified plan reads/mutations and scoped prep migration.
Permission boundaries: selected plan membership refresh and parent validation
remain mandatory; no new endpoint, fixture on cloud, reset, import, credentials
or signup change. Shared plan completion remains shared inside one household.

Acceptance: migration preserves exact bytes; same ingredient/date/task allowed
for two households plus null, duplicates refused within each. Actual action can
set/unset its own completion without changing foreign/null rows; foreign plan
and stale membership still fail. Legacy-key migration cannot consume or alter
another namespace. Retain backend/native coverage, real browser prep rerun and
all saved journeys, types/build.

Acceptance complete locally: migration `0016` preserves pantry/prep bytes and
uses null-safe household-composite uniqueness. The pantry primary-key placeholder
was replaced with its baseline constraint name. Actual completion and legacy
rename upserts target the full owned identity. All 1,871 tests / 93 files,
29 browser journeys, types and production build pass; critical gates remain
intact, overall statements 72.06%. Native twelve-way concurrent upserts retain
exactly one independent row per household/null namespace. The retained browser
prep case copies identical keys into another household, toggles/reloads its own
completion and verifies foreign rows unchanged. No pantry feature, remote
migration, signup or deployment was added.

### H2 slice: shared revision namespaces and pinned sync

Scope: replace class-only sync marker identity with null-safe household/class
uniqueness, preserving existing marker values and legacy null namespace. Shared
feedback, links, saved views, photos and decisions mark their explicit household
in the same transaction as the write. Personal/operator writers keep existing
behavior until their separate operational contract is adopted. Snapshot capture,
acknowledgement and status accept an explicit scope and filter it consistently;
unscoped operator calls must not read or acknowledge owned markers.

Dependencies: accepted scoped shared exports. No network or blob I/O under
locks, no new request endpoint, no target reconfiguration or credential changes.
Runtime adoption is included to preserve usable sync after changing markers:
require a server-only STATE_SYNC_HOUSEHOLD_ID pin; bind target/job identity to
that pin, and refuse household mismatch rather than adopt another job. The owner
action and Settings resolve verified membership and require the pinned household;
the scheduler uses its separate credential and server pin, never client selection.
Snapshot admission revalidates interactive membership inside its transaction.
Existing targets are not automatically reconciled or repointed; a changed target
identity must refuse pre-existing unmanaged/conflicting remote contents. No
per-household GitHub credentials or configuration UI is introduced.
Migration must preserve revisions/timestamps/ownership without
guessing missing ownership; new markers start pending.

Acceptance: native/PGlite migration preservation and namespace uniqueness,
independent same-class household revisions, stale acknowledgement refusal,
foreign/null marker exclusion, shared writer rollback and exact snapshot files.
Retain full backend coverage gates, browser flows, typecheck and build.
Also verify foreign-owner Settings/action denial before target status, blob or
repository access, scoped job ownership and scheduler replay, and remote content
exclusion in the retained browser suite. Whole-instance encrypted backup must
compare every household's photo revision rather than an arbitrary first row.

Acceptance complete locally: migration `0015` preserves marker values and
replaces the class primary key with null-safe household/class uniqueness. The
generated primary-key placeholder was replaced with the baseline Postgres
constraint name. Shared writers, capture/status/acknowledgement, job ownership,
target identity, owner Settings/action and scheduler now use the same namespace.
Legacy unscoped snapshots select only null-owned shared rows, not all households;
explicit operator-wide human export remains separate. Whole-instance backup
compares the complete ordered photo revision vector.

All 1,869 tests / 93 files, 29 retained browser journeys, strict types and
production build pass. Existing 100% critical sync and backup gates remain
intact; overall statements 72.07%. Browser replay checks member and unrelated
household-owner denial, without creating requests or exposing sync controls.
Synthetic signed GitHub publication contains only the selected household, and
scheduler replay retains one success. No real target, migration, credentials,
content transfer, scheduler enablement or deployment was changed. Operator
import/reset/recovery and remaining schema/admission work remain open.

### H2 slice: household shared export foundation

Scope: add an explicit household export context to the registered shared classes
(recipe feedback, links, saved views, photos and decisions). Filter before
serializing or filling legacy uid/timestamps, including photo blob references.
Keep existing slug/uid paths and byte-stable version-2 files; a configured target
will later bind one household rather than place household ids in file names.
Exports without a scope remain explicitly deployment-operator helpers, not
ordinary request APIs. Scoped exports require an explicit supported class
selection and fail for unimplemented classes rather than silently exporting them.

Add a verified household snapshot service using a repeatable-read transaction and
membership refresh; it does not expose a new endpoint or transfer any bytes.
Dependencies: accepted scoped human rows and photo/link identity. Permission
boundary: never infer a target household from whichever row is first. Do not
claim sync UI, receipts, importer/reset or remote target isolation is complete:
those require later adoption and schema work.

Acceptance: two households with the same recipe, URL and candidate produce
independent byte-stable bundles; only selected classes/owned blobs appear, null
and foreign rows are absent and their missing stamps remain untouched. Reject
unsupported selections and stale membership before serialization. Existing
operator round trips, full coverage/native checks, browser journeys, types and
build remain intact. No real export, human decisions, repository transfer,
remote write or signup change is permitted in this foundation stage.

Acceptance complete locally: all 1,860 tests / 93 files, 29 retained Playwright
browser journeys, typecheck and production build pass. The verified export
service has a permanent 100% coverage gate; overall statement coverage is
71.97%. Tests also verify incomplete-profile refusal and transaction rollback
of legacy stamps when a later class fails serialization. There is no new UI or
HTTP endpoint in this prerequisite slice; existing browser flows remain intact.
Deployment-wide sync invocation, receipts/targets/jobs, imports/reset/recovery
and operational blob copying have not adopted this boundary yet.

### H2 slice: Settings household counts

Scope: replace the request's deployment-wide reset-summary counts with explicit
household predicates. Count private roots by household and children only through
owned profile/plan subqueries: profiles, plans, manual/checked groceries, pantry,
habit/prep progress, shared/personal feedback, links, routines, plan parts/steps
and photos. Keep the existing operator helper usable without a request scope;
the request loader must always resolve verified membership before reading counts.
Do not execute resets or backups, alter human decisions or enable destructive
controls. The existing Postgres recovery gate remains closed.

Dependencies: completed private request boundaries and owned parent tables.
Permission boundary: household owners are not deployment administrators.
Acceptance: exact payloads for two households across every count, foreign/null
root exclusion, child-parent isolation and revoked membership refusal. Retain a
Settings browser assertion proving unrelated household profiles/photos do not
change visible counts; preserve layout and existing photo/profile navigation.
Run focused backend cases, full coverage/native checks, browser flows, types and
build. Deployment-wide sync/reset invocation remains a separate, explicitly
unfinished operator boundary, not something this read-only stage claims to close.

Acceptance complete locally: all 1,858 tests / 93 files, 29 retained browser
journeys, strict types and build pass. Exact two-household payloads cover all
summary fields and foreign/null root exclusion; revoked membership refuses
counts. The browser proves unrelated profile/photo creation does not change
Settings descriptions. Overall statements 71.94%, existing gates maintained.
No destructive or operational path was enabled.

### H2 slice: photo requests, decisions and private bytes

Scope: household-filter every signed-in photo index, recipe/ingredient gallery,
candidate-review decision/photo-presence read and credits projection. Add verified
request loaders and adopt them on home, plan creation/detail, groceries, catalogue
and detail pages. Anonymous library payloads stay image-free. Private uid routes
resolve current verified household membership and check uid ownership before
opening BlobStore; foreign, legacy-unowned and missing uids return the same private
no-store 404. Keep uid/blob-key contracts, ordering and credits unchanged.

Dependencies: the accepted household scope and nullable ownership columns.
Compatibility helpers without an explicit household address only the null-owned
operator namespace, never all tenants. Reading only owned rows while retaining
null-owned request writes would make new uploads/approvals disappear, so scope
upload/approval/cover/delete/reject in this same stage. Replace candidate-decision
uniqueness with a null-safe household/subject/candidate key preserving all rows.
Keep image processing, download and blob IO outside database locks: existing human
writers receive a verified commit boundary which refreshes membership and locks
the household around SQL only. Upload failure cleans staged bytes, deletion drops
bytes only after the owned SQL transaction commits, and count/cover/order checks
run under that boundary. Tenant-aware operator exports/sync remain later work.
Signup remains closed. No cloud reads/writes, human approvals or source photos
are needed; all acceptance uses disposable synthetic rows/bytes.

Acceptance: exact two-household recipe/ingredient/index/credits payloads; independent
candidate decisions and only-without-photo filters; null-owned exclusion; current
session scope and revocation refusal. Route tests must prove foreign/unowned/
missing uids never invoke BlobStore, both owned variants return correct private
headers/bytes, and malformed variants fail before storage. Retain a real browser
journey verifying foreign photo metadata/credits/candidate decisions and bytes
remain private. Existing photo behavior, critical coverage gates, types and
database-free production build must stay green. Update handover only after
backend/browser acceptance.

Acceptance complete locally: migration `0014` preserves every existing decision
and enforces null-safe household/subject/candidate identity. All request pages,
photo uid routes and actual photo actions use explicit verified scope; null-owned
legacy data is not adopted. Native concurrent uploads have distinct positions and
one cover; concurrent same-candidate approvals reuse one uid and clean unused
staged objects. Scoped duplicate approvals, independent household decisions,
marker-failure rollback and stale-membership cleanup are covered. All 1,857 tests
/ 93 files, 29 retained phone browser journeys, strict types and production build
pass; photo projections have a permanent 100% statement/line/function gate,
overall statements 71.91%. Browser coverage checks foreign metadata, credits,
private uid bytes, independent rejection and own upload/reload/delete with real
WebP bytes. Operational exports/imports/sync/reset remain outside this completed
request slice. No public admission or remote resource changed.

### H2 slice: shared recipe links

Scope: isolate recipe/part/step links on request reads and every add/edit/delete/
move action. Keep URLs, normalization, stable uid, creator and recipe consistency
validation unchanged. Introduce one reusable verified household-state transaction
using the saved-default serialization pattern, and reuse it for saved defaults
and link mutations. Require a linked profile, refresh membership in the write
transaction and lock the household before allocating positions or reordering.
Pass explicit household ownership through the existing checked action service and
lib/human writers; all selectors, sibling positions and updates must use the same
namespace. Legacy operator calls address null-owned links rather than all tenants.

Acceptance complete locally: 1,853 tests / 93 files, all 28 retained browser
journeys, strict types and production build pass. Native concurrent additions
have distinct positions. Tests cover independent same-URL links, legacy/foreign
refusal, per-household limits, uid/creator preservation, stale membership and
database-triggered rollback of add/edit/delete/reorder plus sync markers. Browser
add/edit/reload/order/delete and captured foreign-id replays pass. A long recipe
technique-button label caused horizontal overflow and mobile dialog hit-target
drift; wrapping it resolves the actual browser failure and a saved viewport
assertion guards it. Overall statements 71.31%; existing critical gates pass.
Operator link exports/imports, tenant sync and photo ownership remain separate
pending work. No admission, remote resources, secrets or deployment changed.
No schema or remote changes are needed; tenant-aware export/import remains a
separate pending slice.

Acceptance: backend real-action add/update/move/delete and foreign-id refusal
even for owners; independent same-recipe household ordering, stable uid/creator,
stale membership and sync-failure rollback. Preserve existing URL/part/step
validation and human round trips. Native concurrent creates must allocate distinct
positions. Browser capture/replay must refuse foreign link edits/deletes/reorder
and show valid add/edit/reload/remove behavior. Run targeted coverage, full native
regression, retained browser journeys, types and build before committing.

GitHub Actions already runs typecheck, validation, tests, build and secret scanning; the latest inspected main-branch run passed both `ci` and `secrets`. Committed local workflow changes add all-branch pushes, manual dispatch, disposable Postgres and browser jobs, and downloadable test results. They will take effect on GitHub only after a push.

The application now uses the guarded node-postgres pool and awaited Drizzle transactions. All 33 legacy application tables retain parity with explicit additive Postgres-only fields; the schema now has 48 tables including households, library versioning, eight identity/rate-limit tables, separate personal recipe feedback and four operational sync/reminder tables. Human sync markers, plan writes, prep/reset internals and seed/renames are awaited; seed and renames share one atomic transaction. Requests check a content fingerprint instead of seeding. Settings reset stays blocked until the approved off-machine recovery/pre-reset failure gate exists. Existing SQLite files were not touched or imported.

PGlite behavior/round-trip coverage and twenty-nine native Postgres 17 TCP checks pass locally, including concurrent regeneration, identity admission, duplicate profile submission, last-owner protection, private feedback/account snapshots, coherent state exports, stale-safe acknowledgement, concurrent sync takeover, cross-target replay-key races, real encrypted native backup/guarded recovery with and without photos and fenced reminder admission/device attempts. All **1,604 tests in 80 files and twenty-one retained browser cases pass**, including per-cook timezone validation/save/reload/export, actual synthetic device enable/test/disable and concurrent reminder HTTP/retry/ambiguity, alongside meal/auth/account/photo and state-sync regressions. Synthetic signed GitHub HTTP verifies private-repository admission, immutable objects and retry-safe publication. Builds succeed without database access and all private pages remain dynamic. CI declares disposable Postgres services and recovery tools, but remote runs require a push. Steps 12-17, the local step-18 adapter, 19A-19C, local 20A-20B recovery and 20D reminders are implemented. Live storage/state-sync/provider/device acceptance, off-machine recovery/pre-reset gate and deployment remain open. `neon.ts` was removed in the launch documentation PR because it declared managed Neon Auth, realtime and a bucket; do not run `neon deploy`.

Next delivery gates, in order:

1. Steps 12-14 and the identity schema are verified locally; approved synthetic Neon rehearsals are complete.
2. Authentication screens, verified household/profile onboarding and basic cook invitations are implemented locally (15 and part of 17); real sending-domain setup remains external.
3. Application authorization (16) and account management (17A-17D) are verified locally. Cloud storage, recovery and deployment gates still block public access.
4. Wire cloud photos, state sync and encrypted backup/restore (18-20).
5. Add environment-scoped deployment automation and cut over to Vercel with protected previews, migrations, scheduler, domain and email DNS (21). Never seed a production database from an ordinary validation workflow.

## Execution plan from the current checkpoint

Original planning baseline: local commit `8974a0d`. The local application adapter/transaction port and acceptance checks below are now implemented; photo/mobile work was saved in `6369e73` and atomic persistence/coverage in `15ad10b`. Remaining cloud/identity/recovery gates are unchanged. Approval of this plan does not authorize deleting cloud services, purchasing plans, importing personal data into previews, or production cutover.

Execute one checkpoint at a time. Finish implementation and its acceptance checks, save a focused commit, update `roadmap.md`, then move to the next unblocked checkpoint. Do not stop merely to announce the next item. If an external service blocks a checkpoint, continue independent local work, state the blocker precisely, and never mark the blocked checkpoint complete. Start no unattended background work unless it has a concrete bounded task or a required service.

Before each stage starts, expand its implementation tasks, dependencies, permission boundaries, negative cases and acceptance tests here. For every feature, add unit/integration coverage, exercise the actual flow in a Playwright browser, and retain reusable Playwright cases so subsequent checks do not require rediscovering selectors or repeating manual steps. Run the smallest relevant regression selection during implementation, then stage-level acceptance before committing. Tests must never select real household data or production credentials.

### Checkpoint 1: Complete the Postgres application port (roadmap 12-13)

**Local implementation and acceptance verified.** The checklist below records the implemented scope, not outstanding async work. Native Postgres was installed for a private synthetic cluster because Docker was unavailable; no shared service or cloud database was used. Workflow changes remain local until pushed.

Start with roadmap step 12's numbered work package and carry-forward register in `roadmap.md`. Do not treat this combined checkpoint as permission to skip step 12. Finish the async-boundary/atomicity work first; only the transaction implementation that requires a new driver crosses into step 13. The existing Postgres schema is supporting groundwork, not the next active task. Earlier photo/mobile changes are saved separately, and human/device/nutrition blockers retain their original status.

1. Inventory database consumers and establish Postgres test fixtures before changing runtime selection. Keep the existing SQLite migrations and source database intact for migration/rollback; do not introduce a second copy of every business operation just to support two drivers.
2. Convert the database boundary and shared transaction types to the async Postgres contract. Port `markChanged`, human-owned feedback/views/links/photos/routines, exporters/importers and slug renames together so human writes and sync markers remain atomic. Await every database operation; no network, blob or file work inside transactions.
3. Port content seeding, plan setup, generation/persistence, swaps, portions, prep, groceries, routine snapshots, Today queries, exports and push subscription helpers. Replace SQLite-specific SQL and synchronous `.run()`, `.get()` and `.all()` calls on query builders. Preserve return values, ordering, idempotency and existing UX.
4. Separate destructive reset and backup: require the Postgres backup prerequisite before allowing a destructive reset. Until checkpoint 6 supplies a tested backup, reject destructive Postgres reset explicitly rather than silently skipping its backup.
5. Wire a single reused pool into `lib/server/context.ts`, with reviewed target configuration and runtime-environment checks. Fail loudly on missing/mismatched configuration; never fall back from a failed Postgres connection to SQLite or seed during a request.
6. Move library validation/seed to an explicit release command. A normal Next build is read-only against databases. Detect library-version mismatch explicitly; counts alone cannot detect changed content with unchanged row counts.

Acceptance: existing pure/unit tests pass; database behavior tests run against PGlite; node-postgres integration tests run against a disposable PostgreSQL service in CI; human export/import/export bytes match; commit/rollback and concurrent-write cases pass; the app builds and synthetic-data browser checks cover plan creation, swap, groceries, prep, routines, review decisions and exports. No production access is needed.

### Checkpoint 2: Safe Neon development and import rehearsal (roadmap 14)

Local importer implemented: `pnpm db:import:sqlite` reads all 33 legacy tables without changing the source, verifies per-table canonical counts/checksums before commit, restores original human metadata through `lib/human/sqlite-restore.ts` and repairs identities transactionally. It refuses nonempty destinations. Remote rehearsals additionally require an explicit `SQLITE_IMPORT_NEON_BRANCH_ID` matching the development branch and successful live metadata verification before pool creation. Synthetic PGlite/native Postgres tests cover two fresh rehearsals, concurrent imports, interrupted writes, checksum mismatch, identity-repair rollback/retry and human export preservation after explicit seed.

Live branch verification is now wired before remote non-production runtime, migration and seed pool creation. It checks explicit project/branch ids, rejects production/default/primary/protected branches and maps direct/pooler hosts against authoritative read-write endpoint metadata. The read-only `db:verify:postgres runtime|migration` command exercises the same gate without opening Postgres. API failure is an explicit refusal; local targets remain independent of Neon credentials. Concurrent startup shares verification and retries after failure. Verification lasts for the process's pool lifetime; branch/endpoint configuration changes require a restart.

Cloud execution approved 2026-10-24: created schema-only `dev-step14-rehearsal` (`br-odd-flower-b43d2ryu`, expires 2026-10-31 04:30 UTC) without production rows. Live direct/pooled mapping passes. Two fresh development databases produced identical counts/checksums for all 33 synthetic tables; all 17 identity sequences and human exports through explicit seed were verified. A project-scoped rehearsal API key and URLs are stored only in private session artifacts, not existing local credential files. Production data/configuration remains unchanged.

Checkpoint 2 acceptance complete: phone-width live Neon browser checks passed plan creation, swap/reload, locked regeneration, groceries/prep persistence, Reject success/failure/retry and XLSX/PDF payloads. Five saved Playwright cases now pass against a guarded disposable local Postgres database, with a credential-free CI browser job and failure traces. Full unit/native suite: 805 passing; build/typecheck and source immutability/production/nonempty refusal checks passed. This is development acceptance only, not household cutover or public deployment.

1. Inspect the linked Neon project's branch identities and endpoint mapping without printing connection secrets. Select or create an isolated development branch with synthetic/empty data; do not copy personal production data into an unprotected environment.
2. Reconcile environment-variable names with the pool and migration commands. Separate pooled application traffic from direct migration/import traffic. Verify the actual branch-to-host mapping; an operator-supplied host name alone is not proof of branch identity.
3. Implement a read-only SQLite source importer and deterministic canonical per-table checksums. Preserve ids/references and human metadata, normalize dates/booleans/JSON, order inserts by dependencies, reset identity sequences and verify counts/checksums. Keep this distinct from ordinary library seeding.
4. Reject an unexpected nonempty destination; do not truncate it automatically. Make interrupted-import recovery explicit and rehearse it with synthetic fixtures before touching household data.
5. Apply baseline and library seed to dev only, rehearse import twice into disposable targets, and run application smoke checks.
6. Save the observed browser flows as Playwright tests: deterministic fixture import/seed, plan creation, swap persistence, lock-preserving regeneration, grocery/prep completion and exports. Use an explicitly named loopback-only database separate from unit/native integration databases; refuse remote/production targets before any test write.
7. Add a dedicated CI browser job using a disposable Postgres service and Chromium. Capture failure traces/screenshots privately as artifacts; no cloud credentials in ordinary CI. Allow individual spec/grep selection for faster reruns.
8. Recheck source immutability, second-import refusal and production-target rejection on the actual approved dev setup. Stop temporary services and record branch expiry, credential handling and acceptance evidence before checkpoint completion.

Acceptance: dev startup against a production endpoint is refused; migrations use the direct dev endpoint; imported relationships and checksums match; the next generated id does not collide; source SQLite remains unchanged. Real household import waits for the final backup/cutover gate.

### Checkpoint 3: Authentication and household identity (roadmap 15 and schema portion of 17)

**Required product model:** one household per deployment, multiple login accounts per household, and separate meal profiles (including people who never log in). Household members prepare and follow the same meal plan, shopping list and prep tasks; per-person targets, portions and routine choices remain linked to the correct profile. Never generate one independent plan per account. Account identity/email is separate from meal profile data; an invitee may link an existing unclaimed profile or create a new one without duplicating it.

Detailed execution slices, to implement in order after checkpoint 2:

1. Capability decision: verify current Better Auth password/email-code, verification/reset, session revocation, invitations and transactional adapter support. Preserve existing Neon services during investigation. Keep test mail delivery isolated; a real sending domain is a later external gate.
2. Schema and pure rules: auth users/accounts/sessions/verifications, household, memberships/invites and optional unique account-to-profile linkage. Define bootstrap and invite state transitions with expiry, single-use tokens, normalized emails, atomic membership creation and anti-enumeration responses. Migration tests preserve current plans/profile ids and cannot grant roles by request input.
3. Signup and onboarding: initial owner signup is allowed only through an explicitly configured one-time bootstrap claim. Later signup requires a valid invitation; signing up alone never creates an owner or a second household. Verify email, complete account details, link or build a meal profile with the existing target/diet validation, then land on the existing shared household plan or its first-plan wizard.
4. Login and recovery: password and email-code sign-in, email verification, resend/rate limits, forgotten/reset password, sign-out and session revocation. Preserve a safe same-origin return path. Expired/reused/wrong tokens, delivery failures and interrupted onboarding have explicit UI/error behavior.
5. Household collaboration: owner invites another cook, member accepts using a second browser context, links their meal profile and opens the exact same plan/grocery/prep state. Individual portions/targets are shown under the linked profile; a shopping tick or shared plan change by either cook appears to the other after reload. Keep private profile fields behind the server-side permissions defined in checkpoint 4.
6. Retained acceptance suite: owner bootstrap signup -> email verification -> profile onboarding -> first plan; invited member signup -> profile link -> same plan/list; existing member login and recovery; duplicate-profile prevention; invalid/expired/reused invitation/code, concurrent bootstrap/claim attempts, unauthorized/public signup, sign-out and cached-private-data checks. Cover phones and two independent sessions. Add pure transition/DB rollback tests before browser checks and save the browser flows as runnable specs.

Do not expose a partially protected app: complete the server-side authorization inventory in checkpoint 4 before deploying even an authenticated preview with household data.

**Capability decision, 2026-10-24:** select self-hosted Better Auth 1.7.12 on the existing Next.js host with the Drizzle adapter and Neon Postgres. Current [Managed plugins](https://neon.com/docs/auth/guides/plugins) and [Organization support](https://neon.com/docs/auth/guides/plugins/organization) do not expose the custom signup/server hooks required by the invite-only/bootstrap admission rules; upstream [hooks](https://better-auth.com/docs/concepts/hooks) and [Drizzle adapter](https://better-auth.com/docs/adapters/drizzle) document those capabilities. Installed-version types/source must confirm them before wiring routes. Do not disable Neon Auth or migrate any of its users.

Slice 3A execution plan (database/admission foundation, before login/UI):

1. Pin Better Auth/adapter compatibility with Next 16, Drizzle 0.45, pg 8 and the existing Zod 3 app. Generate/review the core auth schema using the installed CLI/config conventions; keep auth tables distinct from the preserved SQLite/library tables.
2. Add one singleton household bootstrap row, owner/member memberships with a unique optional `person_id`, and email-bound invitations with hashed random tokens, expiry, inviter and optional reserved profile. A household is the deployment, not one generated per login. No email is added to `people`.
3. Admission functions require a verified account. Bootstrap compares a server-configured high-entropy secret in constant time, serializes competing claims, and creates exactly one owner. Invitation creation requires a current owner; acceptance locks the invitation and membership, checks normalized email/expiry/one-use and consumes it atomically with membership/profile linking. Reject role input, duplicate profile ownership and foreign/missing profiles.
4. Put identity writes in a dedicated auth module, not pages/scripts or human state exporters. Auth credentials/tokens/membership are operational identity data, excluded from plaintext human-state sync; future encrypted backup covers them. Do not enable destructive auth reset or delete the last owner.
5. Generate Drizzle migrations, verify fresh and upgrade application tables/ids, and test admission success plus wrong/unverified/reused/expired/parallel claims, rollback, owner-only issuance and unique profile linkage. Run existing browser regressions against the extended schema to prove meal flows still work.
6. Slice 3B then wires Better Auth password/email-code/verification/reset and signup admission hooks, local test mail, session helpers and protected auth routes. Slice 3C adds complete account/onboarding/profile-link screens and retained owner/member Playwright flows; checkpoint 4 closes every action/route and cache/privacy boundary before public use.

Slice 3A does not claim authentication is enabled or the app is protected. Each following slice must satisfy the larger signup/onboarding/shared-household acceptance list above.

Slice 3A completed locally: migration `0002` adds seven identity tables without changing legacy table shapes. The installed Better Auth adapter creates password credentials/sessions against that schema; household admission has 100% statements/branches/functions/lines with a permanent gate. All 836 tests (11 native TCP checks) and five retained phone-browser regressions pass. Native concurrency proves exactly one bootstrap and one invitation acceptance commit; import refuses existing auth data and human-state export omits identity. Auth `Date` timestamps use `timestamptz`; legacy ISO-string row contracts remain unchanged. pnpm reports an optional Better Call/Zod peer warning against the app's Zod 3, but the lockfile/runtime bind Better Auth and Better Call to their own Zod 4, and actual signup/login integration succeeds; no app-wide schema upgrade is needed.

Slice 3B execution plan (signup/session/recovery backend, before onboarding screens):

1. Build a lazy, explicitly configured Better Auth factory over the existing guarded database. Require a server-only secret and fixed trusted app origin; keep database access out of imports/builds. Map the generated auth models and disable social signup, implicit email-code signup and account deletion.
2. Guard every user creation with a database hook: only a still-unclaimed deployment bootstrap secret or an unexpired, unconsumed invitation matching the signup email permits registration. Recheck admission after verified login using slice 3A; registering an auth account alone never grants household access.
3. Enable password signup/login and six-digit email codes for verification, login and password reset, hashed at rest with short expiry/attempt limits. Require verified email, revoke sessions after password reset, do not put one-time codes in URLs, and disable persistent cookie session caching.
4. Use persistent database rate limits, including signup, OTP send/verify, login and reset. Check the installed adapter's atomic consumption behavior and configured trusted-IP boundary; rate-limit tests must call the actual HTTP handler (server API methods bypass its limiter).
5. Await injected mail delivery and return an explicit sanitized error if it fails. Use in-memory test delivery for integration tests. Runtime Resend delivery requires explicit sender/API-key configuration; no real email is sent during implementation. For real Next.js browser acceptance, add an explicit local-only test mailbox restricted to the disposable `protein_kitchen_e2e` database and reserved `example.test` addresses, never an internet-readable OTP endpoint. Slice 3C will reuse it for the actual signup/onboarding screens.
6. Add a no-store auth catch-all route and test real signup -> verification -> password/code login -> session reload -> reset -> old-session refusal. Include bad admission, revoked/expired invites, wrong/reused/expired codes, resend, missing configuration, failed mail and allowed/foreign origins. New auth routes are not a substitute for checkpoint 4's complete authorization inventory; keep the app private.

Slice 3B completed locally: all 903 tests, including 12 native checks, pass with coverage gates; the auth modules have 99.51% statement and 98.63% branch coverage. Seven retained browser cases pass, including real Next signup, verification, password/code login, cookie restoration and password reset revoking both browser sessions. Typecheck, library validation and database-free build pass. Runtime mail needs explicit Resend configuration; no real mail was sent. Installed Better Auth catches awaited mail errors internally, so a request-local delivery boundary converts them into explicit sanitized 503 responses. Its admission hook also requires the installed nested context shape; integration tests assert actual persisted users and delivered verification codes rather than a success-shaped response alone.

Slice 3C execution plan (account entry and verified onboarding, before global authorization):

1. Add accessible phone-first signup, password/code sign-in, verification/resend and password-reset screens using existing controls. Surface pending, invalid-code, delivery/network and configuration failures; clear secrets after use. No password, code or admission token in URLs, browser storage or logs. Interrupted flows allow email/code re-entry.
2. Signup collects either the bootstrap key or an invitation code and calls the existing rate-limited HTTP handler. Do not persist the admission secret across verification; ask for it again during verified onboarding. Treat auth identity creation and household membership as separate transitions.
3. Add a server-session-bound onboarding action that invokes atomic bootstrap/invitation admission. Never accept user ids or roles from forms. Already admitted users resume profile setup without consuming the grant again; expired/revoked/reused grants show explicit errors.
4. Reuse the existing profile form and extract its validation/row mapping into a shared module. Create and link a member's new profile in one serialized transaction, rejecting duplicate submissions and existing-profile overwrites. Owners may explicitly link an available existing profile; invitees inherit only their owner-reserved profile, never browse or claim arbitrary profiles.
5. Add an authenticated account/household entry with sign-out and owner-only invitation creation/revocation. Display only account identity, membership and profile names/targets needed for onboarding; no other person's private body fields. Invitation delivery remains a separately visible owner action, not an implicit email success.
6. Retain actual UI Playwright flows for owner signup -> verification -> login -> bootstrap -> profile, a separately invited cook -> reserved/new profile -> the same plan/groceries/prep, sign-out/reload, code login and recovery. Add unit/DB/action tests for anonymous/unverified/member denial, reservations, rollback, concurrent/double submission, safe return paths and failed requests. Run focused selections during development, then all acceptance checks before a focused commit.

Privacy prerequisite pulled forward from checkpoint 4: replace service-worker page caching with public static assets only and retire the old cache on activation. Account/onboarding pages and server-component/API responses must never enter an offline cache. Offline private meal/grocery access is intentionally unavailable until a separately designed session-bound offline policy exists. Owner invitation codes are displayed once for private manual sharing; no invitation email is claimed or sent in this slice.

Slice 3C completed locally: all 939 tests (13 native checks) and all nine retained browser cases pass. Session-bound onboarding actions, atomic profile creation/linking, shared profile validation and browser transport/return-path helpers have 100% statements, branches, functions and lines with permanent gates. Typecheck, library validation and database-free production build pass. Real UI checks at 375 px and in a separate desktop browser cover owner signup/verification, wrong-code/resend, interrupted onboarding, profile failure/retry, reserved-profile admission, revoke/reissue, shared plan/grocery/prep state, sign-out, code login and password recovery. Native competing profile submissions create exactly one profile. A mobile navigation overlap found by the browser test was fixed. Owner-issued invitation codes are shared manually for now; account export/deletion and full authorization remain checkpoint 4 work.

Slice 3C is not complete application protection: checkpoint 4 must still close legacy actions/routes, profile privacy, exports, push and session-bound browser history/offline behavior. The service worker now caches public static assets only. Keep local synthetic data only and do not publish.

Acceptance: session expiry/revocation works; invite-only access and bootstrap races are tested; wrong/expired/reused codes are refused; email failures are visible; phone-width sign-in works. Real email delivery requires the owner's verified domain/account.

### Checkpoint 4: Authorization and account UI (roadmap 16-17)

Detailed execution plan, prepared after slice 3C and before authorization changes:

1. **4A, permission boundary:** inventory currently contains 33 legacy Server Actions in `app/actions.ts`, five session-bound onboarding actions, 22 pages and five non-auth route files (six handlers). Keep the four auth-entry pages public; onboarding needs a verified session but may precede membership. Normal application access requires current verified membership and completed profile linkage. Centralize request/session/member/owner/profile guards without putting auth inside `getDb` (auth initialization itself needs that database and would recurse). Recheck authoritative membership on each request; no request-supplied roles or user ids.
2. **4B, actions and object checks:** protect every legacy action, including read-only swap/feasibility actions. Members may work on shared plans, portions, groceries, prep, recipe links/photos and cooking feedback. Profile body fields and routine choices are editable by that profile's linked member or an owner; creating other household profiles, invitations, profile reassignment and destructive reset are owner-only. Retain the backup-before-reset refusal. Check slot-to-plan, portion-to-slot/person, grocery-to-plan and part-to-plan relationships before writes; reject mismatched, missing or invalid objects without partial mutations. Expected denials use the existing `Result` error shape.
3. **4C, page and payload privacy:** protect private page loaders before personal reads, not just navigation/layout. Restrict member profile-detail access to their linked profile. Shared planning may expose names, computed targets, portions and agreed food preferences, but never send another person's birth date, sex, height or weight in HTML, server-component payloads or client props. Audit Today, recipe/ingredient nutrient views, the plan wizard, existing plan views and exports together; calculate targets privately server-side and use explicit shared view types rather than passing raw `PersonRow` values.
4. **4D, routes and devices:** authorize both export formats and photo bytes, with private no-store responses including errors. Bind push subscribe/status/test/unsubscribe to the session's linked profile and scope endpoint deletion accordingly; a request-body `personId` is not authority. Review shared-device sign-out and password-reset behavior so another account cannot inherit private notifications. Preserve real file payloads and photo metadata stripping. Add direct route tests for anonymous, incomplete, revoked-member, member/owner and mismatched-object cases.
5. **4E, cache and request policy:** static-only service-worker caching is already implemented and tested, including retirement of the old private cache. Add remaining private response/security headers after checking image/video/font dependencies. Test logout, expiry/revocation, history/back navigation, server-component requests and replayed mutations; no offline response may bypass identity checks. Keep CSRF/origin checks on HTTP mutations and Next Server Actions.
6. **4F, account completion:** after the permission boundary is wired, finish owner/member management and account export/deletion, preserving the last owner and shared household plans. Introduce agreed per-person feedback/export versioning with backward-compatible round trips separately from authorization, not as a data migration hidden in access guards. Invitation email needs the verified sending domain; the manual-code path stays explicit until real delivery is tested.
7. **Acceptance and CI:** add a durable inventory test so new actions/routes cannot silently escape the guard matrix. Run denial/rollback cases on disposable databases, including revoked roles and stale sessions. Update existing Playwright fixtures to authenticate synthetic household members; keep actual signup/onboarding tests independent. Exercise two different members sharing one plan while attempts to access the other's private fields/actions fail. Re-run phone/desktop meal, photo, export and recovery flows before each slice commit. No public preview or real-data migration during this checkpoint.

1. Define an owner/member permission matrix, including profile privacy and shared plan visibility. Authorize every Server Action, route and export server-side; middleware/proxy alone is insufficient.
2. Verify child-object membership for swaps, portions, grocery mutations and similar operations; bind push subscriptions to the session rather than a trusted request-body person id.
3. Add invitation, role/profile-link, account export/deletion screens. Preserve at least one owner and prevent role escalation.
4. Migrate ratings/favourites to the agreed per-person model, keeping tested/banned household-wide; version the human export format and test legacy imports.
5. Stop caching personal responses in the service worker; clear private caches on sign-out. Add appropriate response/cache/security headers and session-bound offline mutation handling.

Acceptance: anonymous, member, owner and foreign-object negative cases pass; members cannot obtain another person's private profile fields through pages, actions or exports; logout removes cached personal content. Complete an authorization review before any public deployment.

**Step 16 / slices 4A-4E completed locally:** all 33 legacy actions check authoritative verified membership before data access, alongside the existing session-bound admission actions. Seventeen private loaders require membership; profile creation is owner-only and private profiles/routines/habits are owner-or-self. Shared plan, portions, groceries and prep remain household-wide. Missing/mismatched slot/plan/portion/manual-item ids fail explicitly; prep ticks must match a task/session generated from the actual plan. Linked profiles cannot be deleted through the legacy profile action. Exports expose only the existing explicit meal-plan DTO, not raw body measurements/birth dates.

All five non-auth route files check membership, including export files, photo bytes and push status. Mutating push requests require the configured normalized Origin, use only the session-linked profile, cannot take over another account's endpoint, and return no-store errors/successes. Registration refresh is atomic; removal is owner-scoped. Successful logout/reset removes the linked profile's registrations; sending also rechecks verified membership and an unexpired account session, so revoked/expired identities do not receive private prep reminders. Logout replaces the document rather than retaining the client router's private state. Static-only service-worker caching remains unchanged.

Acceptance: **1,024 tests in 61 files pass, including all 13 native TCP checks; eleven saved Playwright cases pass.** The browser suite uses real signed-in synthetic accounts and proves shared state, owner/member profile separation, anonymous HTML/RSC/export/photo refusal, logout/back refusal, manipulated real Server Action payload refusal and immediate denial after membership removal. Critical access, private-response, plan-child and subscription helpers have permanent 100% statements/branches/functions/lines gates; overall repository coverage is 60.92% statements, not 100%. Typecheck, library validation and database-free production build pass; no lint script exists. Build inspection caught static auth redirects on Account/New profile: explicit dynamic rendering plus request-header resolution before auth configuration now prevents build-time identity decisions, with an inventory regression check. No real mail, remote migration, push or deployment occurred.

#### Step 17 execution slices, after authorization acceptance

Keep account management separate from access guards. Finish and verify each slice before starting the next. One deployment remains one household: account changes must not fork or delete its shared plans, shopping list or prep.

1. **17A, household membership management.** Add owner-only role changes and removal on Account, with explicit confirmation and pending/error/retry UI. Derive the actor from the server session, validate the requested role, and serialize changes with the same deployment-wide advisory lock as bootstrap/invitations/profile linking. Refuse a missing target and demotion/removal of the final owner, including two simultaneous requests. A member cannot promote themselves. Removal revokes that account's sessions, linked-profile device registrations and outstanding invitations it issued in the same transaction; preserve its profile and all shared household data. Demotion revokes outstanding owner-issued invitations, but keeps the account/profile and shared plan. Show the owner current members using only account display name, email, role and profile display name; members see only their own account details.
2. **17A acceptance.** Add transaction rollback/failure-injection, stale-role, missing-target and owner/member permission tests. Add native concurrent final-owner tests. Retain browser cases for owner promotion/demotion, member refusal, confirmed removal, immediate denial in an already-open second session and unchanged shared plan/groceries/prep. Keep the last-owner rule in the database write path, not just disabled controls.
3. **17B, per-person feedback and export versioning.** Separate a person's rating/favourite from household-wide tested/banned status. Plan an explicit migration from the current household feedback format before modifying it; do not silently assign historical human choices to whichever account runs the migration. Preserve notes and stable slug/uid keys, use `lib/human/` plus transactional sync markers, and version exports/imports with documented legacy behavior. Require byte-identical export/import/export tests and two-person browser isolation checks.
4. **17C, personal account download.** Add a no-store, session-bound download of the requesting account's display identity and linked meal profile, preferences/routines and personal feedback. Never export passwords, hashes, session or invitation tokens, rate-limit state, another person's private fields, or a full operational auth dump. Keep shared meal-plan file exports separate. Test exact allowed output keys, another-user-id injection, revoked sessions, download bytes and browser retry/error behavior.
5. **17D, account deletion and retained household data.** Require recent credential verification and an explicit typed confirmation. Last-owner deletion is refused until another verified owner exists. Remove account credentials/sessions, membership/device registrations and pending invitations atomically; resolve bootstrap/invitation provenance foreign keys explicitly rather than dropping constraints. Preserve shared plans, portions and shopping/prep state; explain whether the now-unlinked meal profile remains before confirmation. Profile erasure is a separate, owner-controlled operation while saved plans depend on it. Include failure injection, concurrent deletions, no-reentry with stale cookies, and a retained two-browser deletion flow.
6. **Checkpoint closeout.** Run focused coverage while implementing, then the full native-enabled suite, reusable Playwright suite, typecheck, library validation and database-free production build. Update the handover/roadmap with actual counts, commit locally, and proceed to cloud photos/state sync. Real invitation email remains gated on the verified sending domain; no production identity writes, push, public deployment or personal-data import is implied.

**17A complete locally:** Account now lists household cooks for owners and provides confirmed promotion, demotion and removal, with pending/error/retry controls. Role and removal operations share the admission lock, enforce current owner authority and retain at least one verified owner with a completed profile. Demotion revokes pending invitations; removal atomically revokes sessions, linked-profile push registrations and pending invitations while retaining auth accounts, profiles and shared meal data. The original bootstrap row stays as admission provenance; account deletion is still separate work.

Acceptance: **1,040 tests in 61 files pass, including sixteen native TCP checks.** Three native concurrent demote/remove/mixed cases preserve exactly one final owner. Household/account action modules retain 100% statements/branches/functions/lines coverage, including failure injection at each removal write. Eleven retained Playwright cases pass with expanded owner promotion/demotion, failed-request retry, final-owner refusal and second-session removal checks; shared plan/grocery/prep state survives removal. Phone layout was visually inspected. Typecheck, validation and database-free production build pass; lint is unavailable because the repository has no lint script. Step 17B must resolve historical rating/favourite ownership without inventing human attribution before a migration is written. No real account or remote data was changed.

**17B preservation decision and implementation plan:** the owner is unavailable for clarification, so take the non-attributing option: keep all existing household feedback rows and their original exports unchanged. Do not assign historical ratings/favourites to a person. Display meaningful old choices separately as “Earlier household feedback”; they remain historical input to shared planning, not a new account's personal rating.

Add a separate per-person recipe-feedback table with a stable uid, timestamps, nullable author-profile reference, a unique person/recipe pair and database rating constraints. All new writes go through `lib/human/` with the class sync marker in the same transaction; the public action derives the person from the session, never from transport input. A rating may still mark the recipe tested household-wide, but changing household tested status must not clear anyone else's personal rating. Personal and household updates from one request commit/roll back together.

Keep legacy `feedback/<slug>.json` files and the v1 importer; export new bundles as v2 with `personal-feedback/<personKey>.json`, sorted entries keyed by recipe slug/uid. Match people using the existing routine `personKey`, skip unmatched people/missing recipes explicitly, reject unknown future versions, and retain byte-identical v2 round trips. Slug renames, profile/rating resets and changed markers must cover the new table. Do not rewrite source SQLite files.

Recipe cards/detail and their filters use the signed-in person's choices; show household tested/banned and unassigned history distinctly. Shared planner scoring aggregates only selected eaters' personal choices: any low rating (1-2) excludes that recipe for their plan, otherwise use their mean rating and any favourite. Retain earlier household scoring when no selected eater has a personal choice. Pass selected profile ids through generation, preview, regeneration and swap paths so the cook who clicks Generate cannot change whose preferences are used. Tests must cover two-person isolation, legacy preservation, transaction failures/concurrent patches, filtered planning, rename/reset and both export versions; retain actual favourite/rating browser interactions in two independent signed-in contexts.

**17B complete locally:** additive migration `0004` introduces `person_recipe_feedback` without modifying or attributing old household feedback. New personal choices are session-bound, independently upserted and atomically committed with any shared tested/notes changes and sync markers. Cards, detail, favourites filters and all selected-eater planning paths are wired. Tested/banned/notes stay shared; removing household tested status does not erase personal ratings. Legacy ratings/favourites are shown as unassigned history. A failed feedback request rolls its optimistic UI back and offers retry.

Exports now emit manifest v2 and `personal-feedback/<personKey>.json`; legacy v1 imports and `feedback/<slug>.json` remain supported. Unknown future versions fail before writes. Missing people/recipes are reported, ambiguous profile keys never merge or silently claim feedback, and new personal-class imports roll back together on write failure. Slug renames, profile deletion and resets preserve the class's sync semantics. Database constraints and shifted-id byte-identical round trips are covered.

Acceptance: **1,069 tests in 63 files pass, including seventeen native TCP checks; twelve retained Playwright cases pass.** Personal feedback writers/exporters/importers and planning/personal query helpers have permanent 100% statements/branches/functions/lines gates. Overall repository coverage is 61.75% statements, 50.67% branches, 53.04% functions and 63.04% lines, not 100%. Browser checks exercise independent owner/cook ratings, favourite filters, shared tested-state changes, personal rating clearing, network failure/retry and real forged-author/extra-argument Server Action requests. Phone layout was visually inspected; typecheck, validation and database-free production build pass. No lint script exists. The browser test waits for action completion via enabled controls, not stale `networkidle` or indefinitely open development RSC streams; one stale Turbopack cache panic was resolved by clearing only the synthetic test cache and rerunning. No remote migration, real mail, push or deployment occurred.

**17C detailed implementation plan, before code:** keep this as a personal download, not a household backup or state-sync export. Add a session-bound `GET /api/account/export` that rejects all query parameters, rechecks the authoritative user/profile membership inside a repeatable-read, read-only snapshot, and selects an explicit allowlist. The versioned JSON contains only export metadata, account display name/email/verified status/role, the caller's linked meal-profile fields, their ingredient/recipe preferences, routine choices by habit slug and personal feedback by recipe slug/uid. Do not include operational account/session/verification/invitation/rate-limit rows, shared notes/history/plans, foreign people, database ids or passwords/hashes/tokens.

Return an attachment with a fixed safe filename and private no-store headers on success and every expected failure. Anonymous/revoked/configuration failures use existing auth boundaries. Account gains an explicit download button, a warning that the file includes private profile data, pending protection, connection/server-error feedback and retry. Create and revoke any temporary browser object URL; do not put the download in local/session storage.

Add exact-key and two-account exclusion tests, empty-collection and stale-membership tests, and direct route tests for no-store, injected person/user ids, missing membership and auth denials. Add permanent coverage gates for the reader/route. Retain browser checks that click the actual button, inspect downloaded JSON bytes for the correct account/profile only, retry failed network/server responses and verify revoked/anonymous requests cannot download. Verify phone layout, the full native-enabled suite, reusable browser suite, typecheck, validation and database-free build before committing 17C and starting recent-auth deletion in 17D. No provider or remote database change is needed.

**17C complete locally:** Account provides a private JSON download with an explicit private-profile warning and retryable failures. `/api/account/export` authenticates first, rejects every query selector, rechecks the user/profile pair in a repeatable-read read-only transaction and returns only allowlisted personal fields. The attachment and expected auth/input/membership failures are no-store. Operational credentials, sessions, verification/rate-limit/invitation data, database ids, foreign profiles and shared household notes/history/plans are excluded. This personal-file format is intentionally separate from both household backups and human-state export bundles.

Acceptance: **1,081 tests in 64 files pass, including eighteen native TCP checks; twelve retained Playwright cases pass.** The personal snapshot reader and download route have permanent 100% statements/branches/functions/lines gates. Exact allowed keys, profile binding, nullable fields, member/owner downloads, secret/foreign-data exclusion, stale membership and parameter injection are covered. Actual browser clicks download both cooks' files and inspect their bytes; network errors, server errors, non-JSON success responses, revoked sessions and anonymous requests are tested. Phone layout was visually inspected. Typecheck, validation and database-free production build pass. Overall coverage is 61.71% statements, 50.71% branches, 53.01% functions and 63.03% lines; no lint script exists. No remote migration, real mail, push or deployment occurred.

**17D detailed implementation plan, before code:**

1. Keep self-managed Better Auth. Installed 1.7.12 labels `/verify-password` with server scope metadata, but an actual HTTP rehearsal shows it is callable: do not treat metadata as access control. Add a small authenticated `/delete-household-account` plugin endpoint through the existing HTTP handler, same-origin enforcement and persistent five-attempts/minute limit; apply that same guessing limit to `/verify-password`. Require a bounded current password and exact typed `DELETE` in the same deletion request; reject extra fields. Use Better Auth's configured password verifier, not a second hash implementation or a mutation `.api`. The ordinary provider `/delete-user` remains disabled.
2. Serialize deletion with admission/role/removal under the existing household advisory lock. Recheck verified user, current membership, unexpired session and current credential inside the transaction. Lock the credential while verifying it. Refuse deletion of the final usable owner, including concurrent demotion/removal/deletion. Never accept a target user/profile id from the browser.
3. Preserve the bootstrap admission tombstone and its original timestamp without attributing its creation to another cook: an explicit local migration makes its creator reference nullable with `ON DELETE SET NULL`. Delete operational invitations issued by, addressed to or accepted by the deleted account rather than inventing historical authorship. Remove its email OTP/password-reset verification records, linked-profile push registrations and personal ratings/favourites through the human-data writer; delete the auth user with cascading credentials/sessions/membership. All database effects and the personal-feedback sync marker commit or roll back together.
4. Preserve shared plans/portions, grocery/prep state, shared notes/photos and the unlinked meal profile, including its meal requirements, preferences, routines and existing profile history. State this retention clearly before confirmation; deleting login access is not erasing a profile needed by saved household meals. Profile erasure remains a separate owner-controlled operation. Offer the existing personal download before deletion. On success expire provider cookies and replace the document with sign-in; stale cookies must not regain private access.
5. Retain automated cases for strict input/credential/session/role refusal, provider endpoint/rate-limit/origin checks, migration preservation, exact retained/deleted data, every transactional failure boundary and concurrent last-owner operations over native TCP. Exercise actual two-browser confirmations, cancellation, wrong password, network/server retry, cookie/session denial and surviving shared meal/shopping/prep state. Add permanent coverage gates, inspect phone layout, and run the full native-enabled suite, saved Playwright cases, typecheck, validation and database-free build before local commit. No remote migration, real email, push or public deployment is part of this slice.

**17D complete locally:** current-password verification and typed `DELETE` run together through a same-origin, persistently rate-limited Better Auth HTTP endpoint. Its transaction rechecks the authoritative user, membership, unexpired session and locked credential; the shared household lock prevents concurrent deletion/demotion/removal from eliminating the final usable owner. Migration `0005` retains the bootstrap tombstone/timestamp with a nullable deleted-creator reference instead of assigning another cook's identity. Account credentials, sessions, membership, invitations, known verification records, linked-profile devices and personal feedback are removed atomically; feedback uses its human writer and sync marker. Shared meals/portions, shopping/prep, notes/photos and the unlinked meal profile remain, as explained before confirmation. Success expires provider cookies and replaces the document; malformed success responses do not produce a success-shaped redirect.

Acceptance: **1,111 tests in 65 files pass, including twenty-one native TCP checks; thirteen retained Playwright cases pass.** Household deletion, plugin and browser auth transport retain permanent 100% statements/branches/functions/lines gates. Ten injected write failures preserve the complete database snapshot. Native races cover deletion/deletion, deletion/demotion and deletion/removal. Actual browser member and original-owner deletion include cancellation, last-owner refusal, wrong password, network/server retry, stale-cookie refusal and surviving shared plan/grocery/prep state. An upgrade from pre-existing bootstrap data preserves its timestamp and keeps admission closed. The callable provider `/verify-password` is also explicitly rate-limited; its metadata alone was not treated as an access barrier. Phone layout was visually inspected. Typecheck, validation and database-free production build pass. Overall coverage is 61.76% statements, 50.86% branches, 53.00% functions and 63.08% lines. No remote migration, real mail, push or deployment occurred.

### Checkpoint 5: Cloud photos and state sync (roadmap 18-19)

**18 detailed implementation plan, before code:**

1. Official storage quickstart/S3 compatibility docs were checked on 2026-10-24. Read-only CLI metadata confirms the existing project is in supported Ohio (`aws-us-east-2`) and the approved synthetic `dev-step14-rehearsal` branch has a branch-specific S3 endpoint. This is capability evidence, not permission to provision storage or transfer household photos. Do not run the existing broad `neon.ts` deployment: it also declares managed Auth/Realtime.
2. Implement the existing five-method `BlobStore` with the official AWS S3 client, path-style SigV4 requests, explicit branch credentials/region/endpoint, private no-store object metadata and a fixed app namespace. Reuse the repository's abstraction rather than adding a second Files SDK abstraction and its extra peers. Keep object keys in Postgres, never credentials or signed URLs. Check owner-only bucket ACL before first access, caching success and retrying a failed privacy check; use actual S3 XML decoding in tests. Keep privacy-check failures outside object-not-found handling. Handle object-not-found separately from access/bucket/network errors, paginate listings completely and reject malformed pagination rather than hiding missing objects.
3. Add lazy explicit filesystem/Neon selection. Vercel must refuse local upload storage or incomplete cloud configuration rather than falling back to its ephemeral filesystem. Validate the cloud endpoint against the configured deployment branch and supported region. Keep authenticated no-store `/photos/<uid>/<variant>` delivery: use server-side signed S3 requests, not browser bearer URLs, so membership revocation takes effect on the next image request and no signed-URL lifetime outlives authorization.
4. Disable all photo mutations in preview by default and enforce read-only blob access there, including cleanup scripts. Retain explicit pending/error feedback. Update `photos:check` to inspect the configured store; Postgres backup/photo recovery stays separately blocked until step 20. Preserve resizing, WebP/EXIF removal, approval/licensing and existing human-owned writers.
5. Cover partial master/thumbnail upload failures and database failures with cleanup of both keys; preserve both the original failure and cleanup failures, and leave any unresolved object discoverable by `photos:check`. Validate cloud read/write/delete/list behavior against a disposable loopback S3 HTTP fixture with signed requests, as well as exact config/preview/error cases. Extend retained browser checks for image privacy and photo upload/display/reload/delete/retry. Run targeted tests, full coverage, native TCP checks, actual Playwright, typecheck, validation and database-free build.
6. After local acceptance, request explicit approval for a private bucket/scoped credential and synthetic-only upload/read/delete rehearsal on the existing isolated branch. Do not create a credential, change services, upload real photos, expose a public bucket or mark remote cloud acceptance complete without that approval.

**18 implemented and verified locally; remote acceptance pending:** the lazy configured BlobStore refuses hosted filesystem fallback, incomplete credentials, wrong-branch/region endpoints and preview put/delete. All five photo mutations also refuse preview writes after authorization and before data/image/blob work. Cloud operations use namespaced path-style SigV4 requests with bounded retries/timeouts and private no-store metadata. A first-access owner-only ACL check fails closed, and a failed lookup cannot masquerade as a missing object. This is a startup guard, not continuous monitoring or proof that Neon access mode is private. Actual live API access-mode inspection and anonymous refusal remain part of remote acceptance. Authenticated `/photos/<uid>/<variant>` delivery remains no-store and rechecks membership; the browser never receives presigned bearer URLs. Partial uploads/database failures attempt both-key cleanup and preserve original plus cleanup errors; `photos:check` inspects the configured store. Raw originals, image approval and licensing rules are unchanged.

Acceptance: **1,168 tests in 67 files pass, including twenty-one native TCP checks; fourteen retained Playwright cases pass.** Config, S3 and lazy store selection retain permanent 100% statements/branches/functions/lines gates. Real signed loopback S3 HTTP covers ACL refusal/repair, missing objects versus failed privacy lookup, missing buckets, access denial, bounded service retries, bytes/metadata, complete pagination and malformed keys/listings. Actual phone-browser synthetic JPEG upload verifies WebP/metadata stripping, authenticated private bytes, anonymous denial, reload, deletion and network retry; its screenshot was visually inspected. Typecheck, library validation and database-free production build pass. Overall coverage is 62.29% statements, 51.68% branches, 53.45% functions and 63.56% lines. No live bucket or credential was created, no cloud object was uploaded/deleted, no real photo or household data was transferred, and nothing was pushed or deployed. Local filesystem browser acceptance is not a live Neon storage rehearsal. Cloud photo backup/restore remains step 20 work; stored lifecycle/versioning configuration is not enforced by Neon.

#### 18R bounded live storage rehearsal plan, approval required before execution

1. Obtain explicit approval for a private synthetic-only bucket and named storage-scoped credential on `lively-breeze-25685764` / `br-odd-flower-b43d2ryu` (`dev-step14-rehearsal`). Recheck live branch/project/endpoint metadata, supported Ohio region, development-only identity and branch expiry before any write. Refuse a paid-plan upgrade, production/default branch, unknown mapping or an expired/missing branch; do not silently select a replacement.
2. Inspect existing storage metadata without revealing credentials. Create only the approved private rehearsal bucket and branch-scoped read/write credential, using explicit project/branch arguments, never broad `neon deploy` or a local environment pull. Keep credentials in private operator artifacts, not tracked files, existing application environment files, output or browser code. Credential expiry is not enforced by Neon; do not rely on it, and obtain explicit revocation/cleanup authorization when destructive provider tools require it.
3. Inspect actual API bucket access mode and exercise owner-only ACL admission. Use a fresh namespaced synthetic photo, never household bytes. Verify signed put/get/head/list and processed master/thumb hashes, private no-store headers, anonymous known-object read refusal, app-authenticated delivery and reload, plus anonymous app denial. If live ACL/permission behavior differs from the locally tested S3 contract, stop and fix/test that boundary rather than weakening privacy admission.
4. Save a retained opt-in rehearsal script/test with exact branch/bucket/namespace guards; ordinary CI/browser tests must continue using local synthetic HTTP without cloud credentials. Delete only explicitly authorized rehearsal objects, confirm namespace emptiness/consistency, and record safe access-mode/hash/outcome evidence. Bucket/credential deletion/revocation is a separately explicit action, not blanket cleanup permission. No real photos, public access, provider sends, schedules, deployment or production changes.

**Remaining checkpoint work:**

1. After explicit approval, provision a private bucket and scoped credential only on the existing synthetic rehearsal branch. Inspect actual access mode and anonymously refused reads; rehearse synthetic upload/read/reload/delete and inspect configured-store consistency. Do not apply broad service declarations or transfer household photos.
2. Add GitHub App integration scoped to a dedicated private state repo. Export only the agreed non-health data classes using stable slugs/uids; do not send profiles, weights or plans in plaintext.
3. Implement incremental sync, explicit conflict/error handling, retry-safe commits, "Sync now", last-success/failure status and an authenticated scheduled endpoint.

Acceptance: unauthorized photo access fails; approved photo upload/display survives reload; export/import round trips remain stable; retries do not duplicate changes; synthetic sync creates the expected private-repo content. GitHub App credentials and target repository are owner-provided gates.

**19 detailed implementation plan, before code:**

1. **19A, local export and acknowledgement boundary.** Reuse registered human exporters, but require an explicit nonempty class selection for state sync and reject unknown classes before reading or stamping rows. The initial plaintext-capable allowlist is shared recipe feedback, recipe links, saved views, photos and photo decisions. Personal feedback and routines stay out of this boundary pending an explicit privacy decision; profiles, requirements, weights, identity/session records, plans and history never enter it. Free-text fields and approved photo bytes still require owner consent before any real sync; an allowlisted class is not proof its user-written content contains no sensitive information. Preserve the existing full local export/import format for encrypted recovery and do not invent human choices.
2. Capture selected exports and their change receipts in one repeatable-read transaction, with no blob/network I/O inside it. Add an explicit additive migration with monotonic per-class change and acknowledged revision counters: millisecond timestamps alone cannot distinguish concurrent edits or two writes in the same millisecond. Every existing human writer already calls `markChanged` atomically; increment the counter there. A receipt may acknowledge only the captured revision after remote success, never a newer edit. Acknowledgement is transactional, idempotent, cannot move backwards and must not be triggered by an ordinary local backup/export.
3. Retain byte-stable selected exports and full-export round trips. Test empty/unknown/duplicate/prohibited selections, malformed paths, legacy uid stamping, deleted/empty classes, same-timestamp edits, stale/out-of-order receipts, rollback at every acknowledgement write, unchanged failure markers and migration upgrade of existing sync rows. Add permanent critical coverage gates and a native TCP concurrency case. Run focused checks first, then the full native-enabled suite, retained browser regression, typecheck, validation and database-free build before committing 19A. This slice has no new UI/network surface; the actual sync UI/browser cases belong to 19C.
4. **19B, GitHub App transport.** Use short-lived installation credentials from owner-provided server-only App configuration, bound to the exact dedicated private repository and branch. Verify installation/repository privacy and write permission before sending any content; no PAT fallback, guessed target, repository creation or inherited broad credential. Preserve unmanaged files, commit only changed managed files, represent deletions explicitly, and fast-forward without force. Verify immutable Git trees/acknowledgements, detect out-of-band edits/conflicts and retries after an ambiguous success without duplicating commits. Exercise actual HTTP against a synthetic GitHub fixture, including pagination/truncation, auth expiry, throttling, malformed responses and upstream failures. Mirror only verified processed photo bytes, never raw originals; missing/corrupt blobs fail the run.
5. **19C, orchestration and actual UI.** Add a persisted run/lease/checkpoint boundary that serializes concurrent workers without holding a transaction during remote I/O. Record explicit last attempt/success/error and retryable conflict state; acknowledge class receipts only after a verified remote commit. Add owner-only "Sync now" and status UI plus an authenticated, replay-safe scheduler endpoint. Derive permissions from the session, disable preview side effects, never accept target repo/identity/receipts from the browser and never leak App secrets or export contents into logs. Retain actual browser cases for owner/member/anonymous access, pending/retry/conflict/success status, privacy exclusions, duplicate invocation and edits arriving during sync.
6. **Remote gate.** No GitHub App is created or installed, no repository is created/pushed to, no real content is exported remotely and no cron is enabled without the owner's explicit target/credentials/consent. Approval for the Neon database rehearsal does not authorize storage resources or GitHub writes. Step 18's live storage rehearsal remains blocked independently; continue synthetic local work rather than assuming approval or waiting idle. Full private state-sync acceptance remains open until 19B/19C and an explicitly approved synthetic remote rehearsal pass.

**19A complete locally:** selected human exports validate class selection before reads/stamping, preserve manifest v2 and deterministic bytes, reject unsafe paths and leave the existing full recovery export available. The state-sync boundary requires an explicit nonempty subset of the five permitted shared classes; personal feedback/routines and structured account/profile/health/plan data are excluded. No class is automatically consented for a real remote export, and free text/photo content still needs owner review. Snapshot files and change receipts are read together under repeatable-read isolation; blob/network I/O stays outside the transaction.

Migration `0006` adds positive change revisions and bounded nonnegative acknowledged revisions to `sync_state`, with an enforcing constraint. Existing markers start pending at revision 1/acknowledged 0, even if an earlier local export has a timestamp. Existing human transactions increment the revision atomically through `markChanged`. Only an exact current receipt can advance acknowledgement; duplicate, old, future or missing receipts cannot clear newer work. A later acknowledgement-write failure rolls back all earlier acknowledgements. Legacy `exported_at` is not an authoritative remote-run status; 19C must persist and display actual remote success/failure separately. The SQLite importer now selects/checksums the frozen source columns and lets new Postgres-only fields use defaults, preserving all 33 source digests without changing the legacy files or silently accepting extra source columns.

Acceptance: **1,205 tests in 68 files pass, including twenty-three native TCP checks; fourteen retained Playwright cases pass.** Selected export and snapshot/acknowledgement modules have permanent 100% statements/branches/functions/lines gates. Tests cover privacy exclusions, legacy stamping, unsafe paths, empty/deleted classes, byte-identical full round trips, same-millisecond edits, out-of-order receipts, transactional failures, old-marker migration and frozen-source import parity. Native connections prove eight concurrent timestamp-identical changes retain distinct revisions, a racing acknowledgement leaves the next write pending, and files/receipts remain coherent while another connection edits the class. Typecheck, library validation and database-free build pass. Overall coverage is 62.63% statements, 52.13% branches, 53.89% functions and 63.90% lines. There is no new sync UI/network endpoint yet; actual sync UI/browser cases remain 19C work. No remote migration, GitHub write, real export, cron, cloud storage change, push or deployment occurred. Step 19 is not complete; 19B-19C and approved remote acceptance remain.

**19B complete locally:** the server-only GitHub client creates a real RS256 App JWT from an explicitly configured RSA key, verifies the installation/App/owner and requests a short-lived installation token restricted to the single pinned repository id with contents write (plus optional metadata read only). It verifies exact repository id/name, private/non-fork/unarchived/enabled status before content operations. No PAT/ambient credential fallback, guessed repository, repository/branch creation, forced update, redirect-following or automatic write retry is provided. Credentials and upstream response bodies never enter errors. Expired credentials require a new run. All URLs are fixed to `api.github.com`; a fetch injection remaps them solely in synthetic tests.

Selected payloads validate class manifests/checksums and paths, include a deterministic checksummed manifest, and mirror only processed metadata-free WebP master/thumbnail bytes. Master bytes match the stored SHA-256, both variants decode successfully and meet the existing pipeline's size limits; missing/corrupt/raw/metadata-bearing images stop the run. Git blob bytes/ids, commit ancestry, ref identity and complete non-truncated trees are verified. Publication retains unmanaged entries, uploads only changed blobs, explicitly deletes removed managed files and advances without force. A server-supplied prior commit anchors conflict detection; managed out-of-band changes refuse publication, while unrelated edits survive. Identical retries make no new commit, and an ambiguous successful branch update is reconciled by its immutable managed tree. Truncated trees fail explicitly instead of pretending pagination is complete. Installation repository-list pagination is unnecessary because the minted token must contain exactly one pinned repository.

Acceptance: **1,318 tests in 70 files pass, including twenty-three native TCP checks; fourteen retained Playwright cases pass.** The new transport/publication modules retain permanent 100% statements/branches/functions/lines gates. Actual loopback HTTP verifies JWT signatures, token scope/privacy/target refusal, HTTP/network/redirect/malformed failures, expiry, blob/tree/commit verification, deletions, unmanaged-file preservation, conflicting writers, ambiguous-success reconciliation and idempotent retry; synthetic photo tests cover checksums, full decode, WebP limits and metadata removal. Typecheck, library validation and database-free production build pass. Overall coverage is 63.72% statements, 53.74% branches, 54.72% functions and 64.97% lines. This transport is not wired to users or cron yet: persisted lease/checkpoint/run status, owner controls, scheduler authorization and actual sync UI/browser cases remain 19C. Live App setup, private target/credentials/consent and remote acceptance remain owner gates. No real App credential was minted, no GitHub API write or real export occurred, and no remote database/storage, cron, push or deployment was changed.

**19C execution detail, before code:** persist operational job/checkpoint/lease state separately from human exporters, with one job per pinned private repository/branch and persistent idempotency receipts. Acquire/renew/release short database transactions only; every network/blob operation renews and checks lease ownership before proceeding. Store the attempted managed-file Git hashes and exact revision receipts before publication. On retry after lost response or process failure, compare the actual immutable remote tree against that persisted attempt first, acknowledging it only if it matches; otherwise refuse divergent managed state or safely recapture if the old checkpoint still matches. Do not clear a pending attempt merely because a later run failed. Keep authoritative last-success separate from local export timestamps. Owner-only Settings controls derive permission from the current session and accept no target/receipt input. Explicit server enablement and selected classes are required; preview stays disabled. A POST scheduler requires a strong distinct bearer secret and bounded idempotency key, rejects query parameters, and has no implicit cron deployment. Add transactional fault injection, lease expiry/takeover, concurrent native workers, stale-worker refusal, success/error/conflict/replay cases, action/route permission tests and actual retained phone-browser owner/member/anonymous/retry flows. Any browser synthetic GitHub transport must enforce the same explicit local/disposable-database boundary as the auth test mailbox, with no hosted/production fallback.

**19C implemented locally:** migration `0007` adds operational jobs and idempotency receipts, outside the human exporters. A hash of the exact private repository id/name/owner and branch isolates checkpoints and per-target acknowledged revisions. Database-clock leases renew before remote/blob operations, expire after 120 seconds, and fence every pending-intent/checkpoint/status write; no transaction spans external I/O. Concurrent admission serializes on the job row, and a reused request id cannot bind to a different target, even when two connections race. A stale worker cannot clear newer local work or overwrite another worker's result. GitHub's non-force updates remain the separate protection against in-flight remote writes; this is not a distributed lock inside GitHub.

The pending attempt stores only managed-file Git hashes and captured revision receipts, not file contents or credentials. Recovery reconciles that attempt first, without requiring old photo bytes. If it already landed, checkpoint, target receipts, exact-current human acknowledgements and request success commit atomically; newer changes remain visibly pending. If remote still matches the baseline, a new snapshot may be captured; divergent managed contents remain an explicit conflict. Failures preserve pending intent and last-success, emit fixed error codes, and never log upstream/database content. Owner-only Settings controls expose pending/success/interrupted/error/conflict state, retry and last success; member/anonymous action replays are denied before configuration or transport. Explicit `STATE_SYNC_ENABLED=true` and a nonempty permitted `STATE_SYNC_CLASSES` are required. Preview refuses side effects. The POST-only scheduler requires a separate strong bearer credential and UUID idempotency key, accepts no query/payload, and does not provision cron.

**Operating the local implementation:** configure the exact App/installation/repository/branch server variables in `.env.example`, then explicitly select reviewed classes in `STATE_SYNC_CLASSES` (comma separated). Leave sync disabled until target/privacy/content consent are approved. The optional scheduler calls `/api/state-sync` with an empty POST, `Authorization: Bearer <STATE_SYNC_SCHEDULER_SECRET>` and a UUID `Idempotency-Key`. Reuse that key only when retrying the same invocation; use a fresh key for later work. A completed key is a replay receipt, not a request to export later edits. An interrupted run is recoverable after its lease expires. Recovery may acknowledge an earlier snapshot while newer changes remain pending; sync again to publish those. For conflicts, inspect the pinned repository and restore the managed namespace to its last verified contents with a reviewed non-force commit before retrying. Do not bypass conflict checks by editing job checkpoints or deleting pending receipts. There is no automatic destructive conflict resolution.

Acceptance: **1,401 tests in 73 files pass, including twenty-five native TCP checks; eighteen retained Playwright cases pass.** All sync modules, the owner action and scheduler retain permanent 100% statements/branches/functions/lines gates. Fault injection proves checkpoint/acknowledgement/request-status atomicity and recovery of an already-published snapshot without duplicate commits or old photo bytes. Native connections prove single live admission, expired-worker takeover, stale-worker refusal and cross-target request-key isolation. Four saved phone-browser scenarios use the actual Server Action, scheduler, database and signed loopback GitHub HTTP, not mocked success responses; screenshots were visually inspected. Full typecheck, data validation and database-free production build pass. Whole-repository coverage is 64.32% statements, 54.60% branches, 55.18% functions and 65.58% lines. No real GitHub App token, repository write, household export, remote migration/storage change, cron enablement, push or deployment occurred. The local implementation is not remote acceptance; approved live storage/state-sync rehearsals and step 20 recovery remain open.

### Checkpoint 6: Recoverable backups and reminders (roadmap 20 and part of 21)

**20 detailed execution plan, before code:**

1. **20A, local encrypted recovery artifacts.** Keep legacy SQLite backup explicit and unchanged. Add a separate opt-in Postgres backup command using the direct, verified development/test target, never an application-URL fallback or build/request side effect. Use native `pg_dump` custom-format output and the standard age CLI with an operator-provided public recipient. Stream database output directly into encryption: no plaintext dump file, private key, connection secret or sensitive stderr in artifacts/logs. Each processed photo and the recovery manifest are encrypted too; externally visible artifact names are opaque. Write privately into a new staging directory and publish it atomically only after every command, stream, checksum and photo invariant succeeds. Partial failure must leave no success-shaped artifact.
2. Capture photo references plus their monotonic class revision coherently, then dump/copy outside transactions and recheck that revision before completion. A concurrent add/delete, including an add-then-delete cycle, invalidates the attempt rather than producing a dump with missing photos. Validate the existing processed-byte checksums and variants. Do not require all household writes to stop: native `pg_dump` supplies a coherent database snapshot; the photo revision fence supplies matching bytes or an explicit retry. Preserve the blob abstraction for both local and private cloud sources.
3. **20B, isolated restore rehearsal and runbook.** Restore only explicitly selected, trusted encrypted artifacts into an empty disposable development/test destination. Validate checksums/manifest/path limits before any database write. Decrypt in memory/streams with an operator-owned offline identity; do not save/upload it, expose a restore HTTP endpoint, or allow archive paths/SQL to choose the destination. Use `pg_restore` with explicit failure/transaction behavior, verify schema/row/foreign-key/human-data parity and restore processed photo keys. Test corrupt ciphertext, wrong identity, missing/changed blobs, interrupted child processes, failed outputs and cleanup, wrong destination/nonempty refusal and round-trip recovery on native Postgres. An age-encrypted file is not proof its source is trustworthy; restore only an owner-approved source.
4. **20C, private vault publication and retention.** Reuse exact-target GitHub App/private-repository verification with a separately approved vault target, encrypted files only, immutable checksums, retry-safe jobs and explicit retention/failure reporting. Do not put a large dump in a Vercel request; use an operator/runner with PostgreSQL and age tools, protected environment-scoped credentials and no fork/PR secret exposure. Rehearse entirely with synthetic data first. Keep destructive Settings reset disabled until the backup/restore path and its pre-reset failure gate have passed; do not label a local encrypted artifact as an off-machine backup.
5. **20D, reminders.** Replace the in-process interval with a separately authenticated, persisted retry-safe scheduler. Retain each cook's timezone/window and active session/membership checks; serialize claim/send receipts and explicitly handle ambiguous provider delivery. Add native concurrency and actual HTTP/browser controls where a UI exists. Real phone delivery, owner recipient/identity custody, vault credentials/consent and remote schedule enablement remain external gates.

1. Implement direct-connection Postgres dump/restore tooling and age-encrypted vault backup. Use the owner's public encryption recipient; never upload or retain the owner's private decryption key.
2. Provide a scheduler-compatible backup runner with PostgreSQL tools, explicit retention and failure reporting. Do not assume a Vercel request can safely perform a large dump.
3. Rehearse decrypt/restore into an isolated database, verify checksums and relationships, and verify photo recovery separately. Only then enable destructive resets backed by this path.
4. Replace `setInterval` reminders with an authenticated, retry-safe scheduler endpoint. Preserve per-person timezone/window behavior and prevent duplicate sends across concurrent invocations.

Acceptance: a synthetic encrypted backup restores successfully; backup failure blocks reset; scheduler retries do not duplicate reminders; private data never appears in logs or plaintext git artifacts. Real Android/iPhone delivery remains a device check.

#### 20A local acceptance and operator runbook

`pnpm backup` remains the legacy SQLite command. The separate **`pnpm backup:postgres`** requires an explicitly configured direct `DATABASE_URL_UNPOOLED`, matching development/test environment and the same live remote-branch verification as migration/import. No application URL fallback, Vercel/preview execution, production support, HTTP endpoint or automatic schedule exists.

Install age plus a compatible PostgreSQL client; optionally select trusted executables with `AGE_BIN` and `PG_DUMP_BIN`. Supply **only** `BACKUP_AGE_RECIPIENT`, the classic public recipient produced by the operator's offline age-keygen, and optionally `BACKUP_OUTPUT_DIR` (defaults to ignored `backups/`). Keep the private identity offline; it is not a backup input. Commands do not load `.env.local` automatically. Explicitly configure the intended `BLOB_STORE` and its existing filesystem/private-S3 settings; the photo copy reads that store, not an assumed uploads directory.

The final `backup-<random UUID>/` contains encrypted `database.dump.age`, encrypted `manifest.json.age`, opaque encrypted photo entries and a clear index of ciphertext-only checksums/sizes. Direct libpq credentials are isolated from ambient service/options/target overrides and never passed as a connection URL argument. Remote TLS uses verified system roots; local non-TLS fixtures do not set a contradictory system-root option. Operational sync job/request rows are excluded from the dump; restored private exports must be deliberately configured afresh. Photo references/revision are read together; any intervening photo mutation refuses the attempt, including add/delete ABA. Failed streams/tools/photo reads clean only their owned staging entries; cleanup failure is explicit, never reported as a completed backup.

**Acceptance: 1,423 tests in 74 files, twenty-six native TCP checks and eighteen retained Playwright cases pass.** The real CLI uses native pg_dump and real age; a fresh isolated synthetic database restored with pg_restore matches every non-operational application table digest and human export, while both processed variants match their hashes. Wrong identities and corrupt authenticated ciphertext fail. Synthetic private identities and artifacts are removed after the test. Unit fake tools exercise orchestration/failure boundaries only, not encryption claims. Backup/shared-photo modules have permanent 100% statements/branches/functions/lines gates; whole-repository coverage is 64.71% statements, 54.91% branches, 55.55% functions and 65.96% lines. Typecheck, data validation and database-free build pass; no lint script exists. CI tool prerequisites are declared but have not run remotely. No real household backup or remote publication occurred.

**At the 20A checkpoint:** this was a local artifact, not an off-machine backup or an operator-safe restore command. 20B below adds bounded manifest/path verification and guarded empty-destination recovery; 20C still needs separately approved encrypted-only vault publication, retention and the pre-reset failure gate. Settings reset remains blocked, and no owner private identity, vault credential, remote schedule, push or deployment is enabled here.

#### 20B detailed execution plan, before code

1. Add an explicit trusted-artifact restore command, separate from application startup/migration/seed. Require the operator's explicit trust flag, artifact path, existing offline identity path, new photo directory and a dedicated `RESTORE_DATABASE_URL`; never fall back to an application/backup source URL. First delivery is loopback-only, matching development/test environment, and an explicitly named `protein_kitchen_restore_<32 lowercase hex>` database. No remote restore/provisioning, production support, identity generation/storage/upload, HTTP endpoint or reset enablement.
2. Strictly validate the versioned index and authenticated manifest, identifiers, exact file membership, duplicate/path refusal and ciphertext/plaintext hashes/sizes. Refuse symlink/nonregular entries. Bound index to 1 MiB, manifest to 4 MiB, each decrypted file to 64 MiB, file count to 5,002 and aggregate encrypted bytes to 256 MiB. Oversized archives fail explicitly rather than writing plaintext temp dumps. Complete decryption/authentication and processed-photo checks before any database write.
3. Refuse a nonempty database and an existing photo destination; reserve a new private directory and stage only allowlisted processed-photo keys in private files. Restore with isolated libpq settings, native pg_restore single-transaction/exit-on-error, no owner/privilege restoration and bounded owned child processes. Native restore validates constraints; additionally verify the expected application table set and exact restored photo UID/checksum/variant correspondence before publishing photos.
4. Do not pretend database commit and filesystem rename are one atomic transaction. Clean only owned files/directories after failure; explicitly warn that a failed post-restore verification/publication may have left an unverified database. Never automatically clear or overwrite it; require a new empty destination for retry.
5. Retain unit cases for malformed/oversized/duplicate/path/symlink/changed artifacts, wrong identity, subprocess/output failure and clean refusal; extend native acceptance to exercise the actual restore CLI, full table/human/photo parity and nonempty/wrong-target refusal. Keep coverage gates on critical modules, rerun retained browser regressions and database-free build, then update measured status/runbook and commit. Operator real identity/source approval and all off-machine gates remain separate.

#### 20B isolated operator restore runbook

Use only a known owner-approved artifact. **Age authenticates encrypted bytes, not the identity of whoever encrypted them; anyone with the public recipient can create a new encrypted artifact.** The explicit trust flag is not permission to restore an arbitrary download. Native dump SQL can execute database code. This command is a local trusted-recovery tool, not an untrusted-SQL sandbox.

Prepare a **new empty loopback database** named `protein_kitchen_restore_<32 lowercase hex characters>` with a local operator role, never a source/application database. Do not migrate/seed it. Set `DATABASE_ENV=development` or `test` and the separate `RESTORE_DATABASE_URL`. There is no `DATABASE_URL`/`DATABASE_URL_UNPOOLED` fallback. Supply the artifact directory, existing private offline identity path and a **nonexistent** photo destination whose parent directory exists:

```
pnpm restore:postgres '<trusted artifact directory>' '<existing offline identity file>' '<new private photo directory>' --trust-artifact
```

The command does not generate, copy or upload an identity. Its existing file must be regular, nonsymlinked and owner-private (no group/other permissions). Optional `AGE_BIN` and `PG_RESTORE_BIN` select trusted installed executables; commands do not load `.env.local` automatically. Only local dev/test database recovery and a new local filesystem photo store are supported here. Remote/production recovery and direct restoration into live cloud storage require a separate reviewed cutover plan.

The strict version-1 index/manifest accepts only opaque encrypted filenames and exact `database.dump`/processed-photo keys. Checksums, sizes, complete file/key membership, private identity/file boundaries, WebP bytes and both variants are verified **before database writes**. Files use no-follow opens and bounded streaming reads, including a file that grows after its initial stat. Limits: 1 MiB index, 4 MiB decrypted manifest, 64 MiB each decrypted file (65 MiB encrypted input), 5,002 encrypted entries and 256 MiB aggregate ciphertext. Oversized recovery explicitly fails; it never falls back to plaintext dump files.

Any existing non-system relation, function, type or schema refuses the database. Any existing photo destination is preserved/refused. Native pg_restore uses isolated libpq settings, a single transaction and exit-on-error; owner/privilege restoration is disabled, and owned processes have hard timeouts/output limits. Expected application tables and exact database photo UID/hash correspondence are checked before publishing the staged photo directory. Native FK/index/constraint restoration validates relationships. Successful output contains only random artifact id and counts, not private rows, paths, identities, URLs or stderr.

**Failure handling:** database commit and photo publication are not one cross-resource transaction. A failure can leave a committed but **unverified** isolated database; the safe error says so, removes only owned staging/reservation directories, and never automatically clears that database. A concurrent external photo-directory write is preserved, with explicit cleanup failure. Inspect/discard the failed isolated attempt and retry using a **new** empty destination, rather than running against a partial restore. Keep app access disabled until success and owner inspection. Off-machine backup/vault jobs and destructive Settings reset remain disabled.

**20B acceptance:** all **1,477 tests in 75 files**, including **twenty-seven native TCP checks**, and **eighteen retained Playwright cases** pass. Fifty-three retained recovery unit cases exercise strict preflight, changed/growing/oversized/symlink/path/duplicate inputs, bounded child failures, empty destination guards, post-restore mismatches, private publication and external-write preservation. Real backup/restore CLIs recover every non-operational table digest, human exports and the filesystem photo store with and without photos. Actual wrong-target/trust/identity/corrupt-ciphertext/nonempty-function/repeated-invocation refusal is retained. Read/process/recovery modules keep permanent 100% statements/branches/functions/lines gates, alongside existing critical gates. Whole-repository coverage is 65.34% statements, 55.46% branches, 55.97% functions and 66.54% lines. Typecheck, validation and database-free build pass; no lint script exists. No real identity/household source, remote write, off-machine backup, reset enablement, cron, push or deployment occurred.

#### 20D reminder execution slices, before code

Inspection found two current limitations: `checkReminders` ignores whether its `ON CONFLICT DO NOTHING` actually inserted the person/day claim, so two callers that both read "not sent" can both send. Also, profiles currently store only `reminderTime`; all clocks use household `APP_TZ`, not a per-cook timezone. Neither the interval worker nor provider outcomes are durable delivery orchestration.

1. **20D1, atomic admission first.** Extract the existing person/day insert into a small database helper that returns true only for the inserted row. The dispatcher must stop immediately on a lost claim. Preserve the existing schema, historical daily claims, timing/window, current membership/session checks and conservative at-most-once-attempt policy. Database errors must propagate, not masquerade as an acquired/refused claim. Add retained actual-dispatch concurrency tests with synthetic transport, per-person/day/legacy/error cases and native pooled-connection contention. Gate the new helper at 100% coverage. This slice fixes duplicate admission; it does not claim durable scheduling, delivery acknowledgement or per-cook timezone support.
2. **20D2, persisted delivery receipts and timezone controls.** Add nullable per-profile IANA timezone with household fallback, shared validation and self/owner-authorized onboarding/profile/export wiring. Define an additive operational batch/device receipt model, freeze eligible registrations for each scheduled local day and use database-clock claims. No open work or eligible device must mean no claim, allowing later additions inside the window rather than burning the day. Preserve the existing 30-minute window, explicitly test DST/midnight behavior, recheck current ownership/session before each external send and keep network I/O outside transactions. Known rejected/retryable responses may retry without re-sending successful devices; timeouts, interrupted sends or uncertain acceptance must become explicitly ambiguous, never blindly auto-replayed. Preserve legacy daily-log suppression. Exclude operational pending delivery rows from recovery dumps, so isolated restores cannot accidentally resume outgoing notifications.
3. **20D3, authenticated scheduling and acceptance.** Replace interval startup with a disabled-by-default POST-only endpoint using its own strong scheduler secret, preview refusal, bounded empty-body/query checks and safe aggregate results. Extract existing scheduler boundary helpers if needed rather than copying the state-sync route. Retain native multi-connection/expired-worker/revoked-session cases and actual browser HTTP flows against a guarded synthetic transport. Verify registration/test-send/profile controls with saved Playwright cases; actual phone delivery remains an owner/device gate. No VAPID provisioning, provider send, external cron or deployment is authorized by this local work.

**20D1 implementation:** the dispatcher now continues only when `INSERT ... ON CONFLICT DO NOTHING RETURNING person_id` returns its inserted claim. A losing caller cannot enter `sendToPerson`; historical daily timestamps are not overwritten and other cooks/days remain independent. The current policy remains **at most one provider attempt per person/day**, not guaranteed delivery: a crash or provider failure after admission is not automatically retried. The interval worker, shared household timezone, non-durable provider outcomes and missing authenticated scheduler are explicitly still 20D2-20D3 work. No delivery-status or cloud-scheduling completion is implied by this race fix.

**20D1 acceptance:** **1,483 tests in 76 files**, including **twenty-eight native TCP checks**, and **eighteen retained Playwright regressions** pass. Five added unit cases include actual `checkReminders` concurrency with a synthetic provider, historical/per-cook/per-day separation and failed database admission; eight native pool requests admit one winner while preserving an imported legacy claim. The new claim helper has a permanent 100% statements/branches/functions/lines gate. Whole-repository coverage is 65.59% statements, 55.60% branches, 56.15% functions and 66.80% lines. Typecheck, validation and database-free build pass; no lint script exists. No new reminder HTTP/browser scheduler exists yet: that actual browser integration belongs to 20D3, not this unit/native race proof. No real provider/cloud/schedule/reset/push/deployment action occurred.

**20D2 timezone slice:** nullable `people.reminder_timezone` is validated through the shared profile schema, editable during onboarding/profile maintenance, visible in profile summaries and included only in the requesting account's private export. Blank uses household `APP_TZ`; existing rows and frozen SQLite imports default to null. Dispatch uses the cook's local day/window for suppression while shared plan/prep dates remain household dates. Migration `0008` preserves existing profiles and daily claims. Acceptance: **1,497 tests in 77 files**, including twenty-eight native checks, and **nineteen retained Playwright cases**. Coverage gates pass (65.61% statements overall); unit cases cover valid/invalid/trimmed/null zones, midnight, DST repeated-hour suppression and actual dispatcher day keys. Chromium verifies invalid-input feedback, save/reload/private export and clearing back to household time. Typecheck, data validation and database-free build pass; no lint script exists. Durable device receipts and authenticated scheduling remain unfinished; no real provider or cloud changes occurred.

**20D2 delivery-receipt implementation plan, before code:**

1. Add operational person/day batches with a frozen message/deadline and device receipts keyed by batch/registration. Keep registration keys out of receipts; fingerprint endpoint and keys so a replaced registration cannot receive an old batch. Exclude both operational tables' data from native backups and preserve historical `reminder_log` suppression.
2. Serialize batch admission on the profile row. Read the database clock for eligibility/expiry and require open tasks, verified membership, a live session and at least one eligible registration before claiming a day. Freeze the device list on first admission; additions belong to a later day. Existing batches may resume only their known-rejected device attempts inside the original window.
3. Atomically move one pending/retry receipt to sending with an unguessable attempt token before network I/O. Persist accepted/gone/cancelled/retry/ambiguous outcomes only for that token. Successful devices are terminal. HTTP 429/503 explicitly rejected requests may retry after a bounded delay, at most three attempts. Other errors, timeouts and interrupted sends are ambiguous and never automatically resent; abandoned sending receipts become ambiguous. Recheck registration fingerprint and current membership/session at each admission.
4. Keep provider calls outside transactions, set an explicit request timeout, and remove dead registrations only when their original fingerprint still matches. Preserve manual test-push behavior separately from scheduled receipt orchestration. Do not expose message content, endpoints, credentials or provider exceptions in scheduler results/logs.
5. Retain unit/PGlite cases for no-work/no-device, frozen devices, concurrent admission/attempts, retry limits/deadlines, accepted-device suppression, replacement/revocation/session expiry, stale workers, database failures and ambiguous outcomes. Add real native pool contention and backup exclusions. The authenticated HTTP boundary, interval removal and synthetic HTTP/browser acceptance remain the following 20D3 slice; real provider/device/cron changes stay gated.

**20D2 receipts complete locally:** migration `0009` adds operational batches and device receipts; admission locks the cook's profile and claims only with a message, eligible identity/session and device. Messages/devices/deadlines are frozen; registration fingerprints prevent sends to replacements. Each external attempt has a persisted token and bounded timeout. Accepted devices never replay; 404/410 retire matching registrations, explicit 429/503 rejection permits at most three delayed attempts, other failures/interrupted sends are terminal ambiguous. Old sending attempts are expired across calendar days. Deadlines cannot be extended by a delayed admission snapshot. Native dumps exclude batch/device contents, with actual encrypted restore proving those tables empty while legacy claims remain intact.

Acceptance: **1,545 tests in 78 files**, including **twenty-nine native TCP cases**, and **nineteen retained browser regressions** pass. The delivery module has a permanent 100% statements/branches/functions/lines gate; overall coverage is 65.94% statements, 56.07% branches, 56.34% functions and 67.16% lines. Native contention freezes one batch and admits one device attempt across eight pooled requests, rejects stale tokens/abandoned workers and honours revoked membership. Unit/PGlite cases cover each transition, no-work/no-device admission, rollback, replacement/session changes, retry bounds and safe classification; actual dispatcher tests use a synthetic provider. Typecheck/validation/database-free build pass; no lint script exists. The interval worker still awaits 20D3 replacement, whose HTTP/browser integration will exercise this persisted flow. No real provider, schedule, cloud or deployment action occurred.

**20D3 implementation detail, before code:** extract the state-sync scheduler's constant-time credential and bounded empty-body checks into shared server helpers without changing its route contract. Add `/api/reminders` as explicit-enabled POST-only scheduling with its own strong credential, preview refusal, no query/payload and aggregate accepted/retry/ambiguous/cancelled results; never return private task/device content. Remove the timer only with endpoint acceptance. Add a synthetic push HTTP adapter gated to local development, exact disposable browser database and fixed synthetic registration keys/host; it must refuse hosted/production/real-subscription use. A private loopback fixture provides accepted/rejected/ambiguous responses and counts so retained Chromium cases exercise actual registration/test-send, concurrency, replay/retry, revocation and device disable with real DB receipts, not mocked scheduler responses. Unit tests cover authorization/disabled/configuration/stream/database/provider failures and adapter guardrails; native receipt contention and encrypted recovery regressions remain mandatory. Update operating instructions; do not provision a cron or enable real provider delivery.

**20D3 complete locally:** the interval startup is removed. `/api/reminders` accepts only an empty POST with a distinct strong bearer credential and explicit `REMINDER_SCHEDULER_ENABLED=true`; preview and credentials reused from auth/state-sync/VAPID are refused. Shared constant-time authorization and chunk/time-bounded body checks preserve the state-sync endpoint's contract. Reminder responses expose only sent/retry/ambiguous/cancelled counts; retry/ambiguous outcomes return HTTP 503 rather than implying delivery. Provider acceptance is not proof of phone display. Manual test pushes remain separate from daily receipts. Failed device-disable requests now show an explicit error and retain the registration for retry.

**20D3 acceptance:** **1,604 tests in 80 files**, including **twenty-nine native TCP checks**, and **twenty-one retained Playwright cases** pass. Delivery, synthetic transport, shared scheduler helpers and the reminder route have permanent 100% statements/branches/functions/lines gates. Overall coverage is 66.09% statements, 56.49% branches, 56.45% functions and 67.31% lines. The two new Chromium cases use actual private routes, database receipts and a guarded loopback HTTP provider: enable/reload/test/failed-disable/retry at phone and desktop widths; anonymous/wrong-secret/GET/query/body refusal; no-device admission; concurrent dispatch; accepted-device suppression; delayed rejected-device retry and terminal ambiguity. Browser platform push APIs are deliberately synthetic; no real provider/device delivery is claimed. Phone/desktop screenshots were inspected. Typecheck, data validation and database-free production build pass; no lint script exists. Native backup/restore still omits operational outgoing jobs and preserves legacy claims. No real provider credential, external cron, cloud write, push or deployment occurred.

**Operating 20D:** see README Configuration. Leave the scheduler disabled until real provider/device/schedule approval. A separately configured external scheduler calls `/api/reminders` once per minute only within reviewed local reminder windows. Requests cannot choose people, clocks or targets; database receipts provide per-device replay safety, so no request replay key is needed. Retry only inside the original window; never clear ambiguous receipts to force resending. A runner/cron is not provisioned by this code. Remaining checkpoint-6 work is 20C's approved private vault publication/retention and pre-reset failure gate, plus real owner/device acceptance.

#### 20C1 append-only encrypted vault publication plan, before code

The retention question was unanswered: Git tree deletion would not erase encrypted history. Preserve the already planned private GitHub vault, with **no automatic deletion/pruning** and no invented expiry guarantee. A real destination, owner recipient/offline-key custody, content consent and retention decision remain external gates. This bounded slice does not enable a runner, schedule or destructive reset.

1. Share the existing strict encrypted index schema/bounded no-follow file reader with recovery, preserving its existing decryption contract. A trusted local artifact may publish only its listed opaque encrypted files and clear non-sensitive index, never other directory contents. Verify ciphertext sizes/hashes, aggregate limits and binary age framing before any repository operation. This is integrity/framing, not proof of sender or decryptability; require an explicitly trusted locally generated source, and rely on the existing actual restore drill for recovery.
2. Reuse the pinned single-private-repository GitHub App transport, not PATs or arbitrary remote URLs. Publish under an immutable artifact-id subtree; preserve every other tree entry. Verify uploaded blobs and proposed/final trees; never force-update, rewrite an existing artifact, prune old artifacts or mix plaintext selected state into the vault.
3. Retry an existing artifact id idempotently: matching bytes are already published, divergent bytes are a hard conflict. Reconcile ambiguous branch-update failures by rereading immutable objects; otherwise fail explicitly and retain the local artifact for the same-id retry. Concurrent different artifacts may require retry, never force overwrite.
4. Test successful signed synthetic HTTP publication, no-op retry, concurrent/ambiguous advance, wrong bytes/modes/extra paths, unchanged unrelated entries, complete local preflight and remote failures. Add artifact path/symlink/limits/framing/hash cases and permanent coverage gates. No new browser interface exists in this library slice; keep all retained browser regressions green. A later 20C2 wires an explicit guarded runner/CLI and its native round trip; approved off-machine acceptance/pre-reset gate and retention remain unfinished.

20C1 acceptance: **1,642 tests in 81 files, twenty-nine native TCP checks and twenty-one retained browser cases pass**, plus typecheck, validation and a database-free production build. The vault publisher and shared recovery reader have permanent 100% statements/branches/functions/lines gates; whole-application statements are 66.38% (not 100%). Native acceptance includes actual age-encrypted database/photo artifacts published over signed synthetic HTTP and same-id no-op retries, alongside existing local restore parity with and without photos. No real repository write, household export, schedule, reset enablement, push or deployment occurred. Fetched recovery and real off-machine acceptance remain separate next steps.

#### 20C2 guarded operator publication and fetched recovery plan, before code

This follows 20C1, not a permission to contact a real vault. Retention is still undecided: append-only/no pruning remains the safe default, with no expiry promise. Real target/App configuration, content consent and recipient/offline identity custody need separate owner approval. No backup task runs in Vercel, a request handler, a build or an unapproved schedule.

1. Add separate explicit vault configuration and guarded operator commands, with no fallback to state-sync credentials/target, application database URLs or local credential files. Pin App, installation, private repository and branch through the existing transport. Refuse preview/Vercel execution and production in this rehearsal slice; validate command arguments and environment before network/file writes. Document that a vault must not share a selective state-sync managed target.
2. Publish an existing explicitly trusted local artifact, not a newly generated backup on every retry. Its persisted directory/index supplies the stable artifact id. Preserve the artifact on failure, print only safe id/commit/outcome, and never print recipient secrets, ciphertext, private filenames, connection strings or provider bodies. CLI success requires confirmed immutable remote contents, not merely successful object uploads.
3. Fetch a selected artifact from one immutable verified commit into a new private destination, never an existing directory. Bound remote index/blob responses, validate exact file allowlist/modes/path ancestry, sizes, aggregate limits and hashes before atomic publication. Download only opaque encrypted members/canonical index; do not decrypt, execute SQL or infer source trust. Interrupted/corrupt downloads leave no success-shaped destination. Preserve the same-id immutable conflict policy.
4. Extend native acceptance through actual synthetic database/photos -> real age/pg_dump -> signed loopback publication -> fetch into a different directory -> guarded isolated restore. Compare all non-operational table digests, human exports and photo bytes with and without photos. Include wrong target/environment/trust, interrupted publication/download, corrupt/missing members, no-force races and retry cases, plus critical-module coverage gates and the existing browser regressions.
5. Keep automated jobs, retention/pruning and the destructive Settings reset disabled. The separate pre-reset failure gate must require a fresh confirmed backup and its approved off-machine recovery acceptance; local/synthetic success alone cannot enable reset. Record the remaining real acceptance/owner decisions and update the runbook before proposing any schedule or deployment.

20C2 operating contract: `pnpm vault:postgres publish <existing-private-artifact> --trust-artifact` publishes/reconciles the existing id; retries never regenerate it. `pnpm vault:postgres fetch <artifact-uuid> <immutable-commit-sha> <existing-private-download-root>` writes a new `backup-<uuid>` directory. Configure every `VAULT_GITHUB_*` pin separately, plus `VAULT_ENABLED=true`, `NODE_ENV=development|test` and `DATABASE_ENV=development|test`; the operator refuses Vercel/preview/production and never loads environment files or falls back to state credentials. It refuses a repository matching configured selective state sync; operators must approve a genuinely separate vault even when state configuration is not present on their host.

Downloads bound Git blob JSON before decoding, apply stricter index/member limits, validate the strict allowlist/metadata/checksums/framing, and fetch every object from the selected immutable commit rather than the branch head. The output root must already exist and not itself be a symlink; keep it private and owner-controlled. Exclusive destination creation prevents replacing even an existing empty directory. Encrypted members are private flushed files, and a temporary index is atomically renamed to the completion marker only after all members pass. This avoids a destructive rename over an existing destination while making interrupted downloads unusable by the recovery reader. Failures remove this call's files/directory, or report cleanup failure explicitly; never reuse an incomplete destination. The ciphertext download does not confer source trust or execute SQL.

Use the existing guarded restore only for an explicitly owner-approved source and an empty disposable development/test database, with the offline identity supplied locally. The native drill now restores the **downloaded** artifact, not the original backup directory, and compares every non-operational table, human export and photo variant with and without photos. Operator argument/config/report paths are exercised over the signed synthetic HTTP transport; the real CLI has no test URL or provider fallback.

### Remaining 20C acceptance and pre-reset prerequisites

20C2 acceptance: **1,684 tests in 82 files, twenty-nine native TCP checks and twenty-one retained Chromium cases pass**, plus typecheck, data validation and a database-free production build. Vault/config/operator/shared-reader/private-GitHub-transport modules retain permanent 100% statements/branches/functions/lines gates; whole-application statements are 66.69%. Actual age/native database/photo artifacts pass signed loopback publication, immutable download into a different directory and guarded restore with full non-operational table/human/photo parity. Exact encoded-response boundary and one-byte-over tests include GitHub's escaped base64 line breaks. Ordinary browser regressions stay local; no new UI was added. No real vault/storage write, household backup, schedule, reset enablement, push or deployment occurred.

Local library/operator success does not close step 20 or authorize deletion. Before a live rehearsal, the owner must separately approve a specific private vault repository/App installation, synthetic-only writes, an age recipient and offline identity custody, and an acceptable append-only history/retention policy. Rehearse publication, download from the reported commit and restore into an explicitly isolated approved destination, then retain only safe artifact/commit/checksum acceptance evidence. Household/identity backups and schedules require their own content/operating approval; synthetic consent is not household consent.

Only after approved off-machine acceptance should a separate detailed implementation plan wire the pre-reset gate: current owner authorization and operation confirmation; fresh coherent encrypted source snapshot; durable target/artifact receipt and verified remote bytes before any deletion; transactionally guarded mutation tied to that snapshot/revision; explicit failure/interruption/conflict refusal preserving all rows/photos. Never run dump/encryption from a Vercel request or trust a stale boolean/last-success timestamp. Failure tests must prove no human rows or photo bytes change on backup/upload/verification failures, concurrent edits or lost receipts. Keep Settings reset disabled until this entire path is implemented and accepted.

### Checkpoint 7: GitHub Actions and protected Vercel preview (roadmap 21 preparation; preview retired, see Launch stage)

#### 21A read-only protected-preview preflight plan, before code

While live cloud approval is unavailable, implement only a deterministic configuration check and a separately explicit read-only branch-verification option. This does not enable hosting or production migrations. Scope the command to Vercel preview: explicit matching runtime/database environments, pooled/direct database pairing and isolated branch pins; fixed HTTPS auth origin/strong auth secret; branch-bound private-photo configuration; disabled state-sync/reminder/vault scheduling and test-only transports/mailboxes. Reuse existing target/auth/blob validators rather than inventing parallel validation. Require the direct and pooled URLs to identify the same database/user/credentials and endpoint pair, with a reviewed direct host for the existing live branch verifier.

Expose no secrets, values, URLs or provider bodies in output/errors: return stable check codes and clearly state that configuration success is not live acceptance or deployment approval. By default perform no network, file reads/writes, database access or environment-file loading. An explicit `--verify-branch` performs only the existing fixed-origin read-only Neon metadata check and refuses missing credentials/mapping. Tests cover missing/mismatched fields, environment/branch isolation, unsafe origins, filesystem fallback, enabled side effects, fixture bypasses and no-network default; keep critical coverage gates and all existing regressions. Record unimplemented release jobs/preview provisioning/provider isolation/live acceptance separately; do not claim this checker closes step 21.

21A acceptance: **1,730 tests in 83 files, twenty-nine native TCP checks and twenty-one retained Chromium cases pass**, alongside typecheck, data validation and a database-free build. The new preflight has a permanent 100% statements/branches/functions/lines gate; whole-application statements are 66.88%. Its default path has no external I/O; explicit metadata verification is tested through dependency injection and the existing verifier's retained HTTP tests. No real live verification, provisioning or deployment was performed. `pnpm deploy:preflight` requires reviewed pooled/direct host variables, branch pins and private-photo/auth configuration; it refuses mail/push/vault/scheduler credentials and fixture bypasses. A protected hosted signup delivery mechanism is still separate work, not bypassed using production mail credentials. README now reflects implemented identity/authorization and retained multi-account browser flows rather than the old pre-auth status.

1. Push approved implementation commits and observe actual CI runs; local commits alone are not GitHub-visible progress. Handle remaining UI/photo work as its own focused commit, not mixed into the database port.
2. Extend CI with the disposable TCP Postgres service, migration/seed/import rehearsal and restore coverage. Ordinary branch validation uses synthetic local data and no production secrets.
3. Add protected environment-scoped release jobs with least-privilege secrets, per-environment concurrency and explicit migration approval. Untrusted/fork PRs never receive cloud credentials.
4. Configure Vercel Node/Fluid runtime and pooled database access. First deploy only to a protected preview with isolated data, a separate auth secret and outbound side effects disabled.
5. Run release migration and library seed as a controlled step with the direct connection, not as an incidental side effect of `next build`. Require expand-compatible schema changes and a rollback procedure.

Acceptance: remote CI is green; protected preview works end to end; no local SQLite/upload filesystem dependency remains; secret scopes, unauthorized access and preview isolation are checked. A failed release step must not promote a deployment.

### Checkpoint 8: Production launch (superseded by "Launch: single production environment")

The earlier checkpoint (owner claim bootstrap, read-only old instance, push, state sync and vault backups at launch) is withdrawn. Launch follows the stage at the top of this document: the soft-launch gates, the launch-day runbook and the rollback section. Reminders, state sync, the vault and library photo review are off at launch and are separate later stages.

### Approval defaults and decision gates

Defaults for implementation: retain Drizzle and node-postgres; one household per deployment; owner/member roles; invite-only access; synthetic isolated previews; private cloud photos; no plaintext health data in git; no paid upgrades or public deployment without approval. Auth-provider and storage capability assumptions from the original proposal must be rechecked against current documentation before implementation. GitHub pushes, cloud provisioning/service changes and the final personal-data import must be explicit, visible actions; destructive service changes and final cutover need separate approval.

## Why this is more than a hosting change

Today there is no login, no authorisation check in any Server Action, a synchronous SQLite data layer, `VACUUM INTO` backups, and a `setInterval` reminder loop. None of that works on Vercel. Tailscale currently keeps the app off the internet; publishing removes that.

Verified in the code: `app/actions.ts` has no auth anywhere; `swapSlot`, `setPortion`, `setManualChecked` and `removeManualItem` do not check that the item belongs to the plan; `api/push/subscribe` trusts a person id from the request body; `api/plan/[id]/export` is open and plan ids are sequential (an IDOR); `lib/server/context.ts` reseeds at request time; `public/sw.js` caches personal pages after sign-out. `.env.local` and `.neon` currently point at the Neon `production` branch, so any seed, reset or test run with those settings would write to production (the app still uses SQLite, so nothing does today). `.gitignore` misses the SQLite `-wal` and `-shm` files, `.env` and `.env.production`.

## Decisions recommended (owner to confirm)

1. Self-hosted `better-auth` with the Drizzle adapter on Neon Postgres for the required signup hooks. Current capability decision and implementation slices are above. Leave provisioned Neon Auth unchanged; disabling it is a separate owner-approved service change, not an implementation prerequisite.
2. Do PR 0 (git repo, GitHub, CI) now, before the rest of the UI work.
3. PR 1a, an async facade: make `queries.ts` and the action helpers async now, so the later Postgres move is mechanical.
4. Sign-in: email and password, plus an emailed 6-digit code. No magic links (the installed iPhone home-screen app has its own cookie store, so links open in Safari). No social login yet.
5. Two roles, owner and member. Members cannot see another person's height, weight or birth date. Only owners reset data, sync, restore or invite.
6. One household per deployment, no `household_id`. A `household_members` table links login users to roles and optionally to a profile. A profile can exist without a login. No email column on `people`: the login email lives on the auth user, and pending emails on `invitations`.
7. Ratings and favourites per person; `tested` and `banned` stay household-wide.
8. Library content is git-first. Human-owned data created in the app (feedback, links, photo approvals, saved views, routine choices) is exported nightly and on demand to a separate private state repo through a GitHub App. Each data class syncs in one direction only.
9. Health data (profiles, weights, plans) never goes to git in plaintext. It stays in Neon (free plan, 6-hour history; see the Launch stage) plus a nightly age-encrypted dump to a private vault repo, scheduled soon after launch. The age private key lives only with the owner.
10. Photos: originals stay in the Neon bucket; WebP derivatives mirror to the state repo. Keep a `BlobStore` interface so Vercel Blob can replace it.
11. Reminders run from an external scheduler, evening window only, calling a cron endpoint; Vercel Hobby cron is once a day, and an all-day schedule would use up the free compute hours.
12. Preview deployments copy production data, so they need Vercel Deployment Protection, a unique auth secret each, and push and uploads off.
13. Domain: a subdomain you own, with email through Resend's free tier. GitHub Pro (about $4 a month) if branch protection cannot be enforced on the private repo.
14. Turn off Neon Realtime for now.

## Rules for the UI work meanwhile (so the migration is cheap)

- New data functions are `async`, even on SQLite, and no I/O inside a transaction.
- Add columns only through a `lib/db/columns.ts` with portable helpers (`json`, `bool`, `isoDate`, `isoTimestamp`). No `strftime`, `json_extract` or rowid reliance. Explicit `onDelete` on every foreign key.
- Human-owned rows carry `uid`, `created_at`, `updated_at`, `created_by_person_id`, and are written only through one `lib/human/` module that also marks the data class changed in `sync_state`. Exports use slugs and uids, never database ids.
- Start the exporter now (`lib/human/export.ts` and `import.ts`) and add every new human-owned table to it with a round-trip test.
- Photo storage behind a `BlobStore` interface (filesystem now, bucket later); resize on the phone before upload.
- A `data/renames.json` (old slug to new slug) so renaming `baked-falafel-mix` does not orphan feedback.
- Every new user table goes into `RESET_SCOPES` and `resetCounts` in `lib/server/reset.ts`.

## Delivery order (sizes: S 2-4 h, M 5-10 h, L 12-20 h)

| # | PR | Depends on | Size |
|---|---|---|---|
| 0 | Repo, `.gitignore` fixes, gitleaks, pre-commit hook, CI, protection, Dependabot | none | S |
| 1 to 12 | UI plan v2 (PR 1 prep tasks, 2 filters, 3 filters elsewhere, 4 composite data, 5 parts UI, 6 cook mode, 7 links, 8 routines, 9 plan steps, 10 Today, 11 photos, 12 photo review) | per v2 doc | see v2 doc |
| 1a | Async facade, `lib/human`, `columns.ts`, exporter skeleton and round-trip test | 1 | S |
| 13 | Finish the async conversion | 12 | M |
| 14 | Postgres baseline schema (all tables, auth, household, sync), node-postgres pool, PGlite and testcontainers tests, `vercel-build` | 13 | L |
| 15 | Migrate and seed pipeline, dev-branch workflow and guard, SQLite import script with checksum verification, rehearsal | 14 | M |
| 16 | Better Auth core: config, Resend, rate limits, `proxy.ts`, sign-in, code and reset pages, bootstrap claim | 14 | L |
| 17 | Authorisation everywhere: guards, IDOR fixes, push bound to the session, service worker hardening, security headers, per-person feedback | 16 | M |
| 18 | Household and account UI: invitations, profile login section, members and roles, account page, delete and export | 17 | M |
| 19 | `BlobStore` on the Neon bucket, signed-URL serving route | 14, 11 | S/M |
| 20 | State repo sync: GitHub App, commits, nightly cron, Sync now, status banner | 15, 19, 7, 12 | M |
| 21 | Vault backups, reset backup on Postgres, `pnpm backup` and `restore`, restore test, runbook | 20 | M |
| 22 | Go-live: Vercel integration, environment variables, reminder cron, domain, DNS for email, final data migration, cutover | 17, 18, 21 | M |

Group 2 (PRs 14 to 22) is about 95 hours.

## Key risks

- Fix the `.env.local` and `.neon` production pointer before any Postgres work: use a long-lived `dev` branch and a startup guard that refuses to run in development against `production`.
- Neon preview branches copy production data.
- Seeding at build writes to production before promotion, so migrations must be expand-only.
- Postgres `count(*)` returns a bigint string; ids differ between databases, so exports use slugs and uids.
- Free-plan point-in-time restore is 6 hours (the owner stays on the free plan), so `pre-deploy-*` snapshot branches and the nightly encrypted dump are the real backups.
- Better Auth may need zod 4 while the app uses zod 3. Check before PR 16.
- Phones must re-subscribe to push on the new domain with new VAPID keys.
- Not verified yet: the `neon checkout` create flag, bucket credentials on preview branches, Vercel's exact client-IP header, whether GitHub rulesets work on this private repo.

## Go-live checklist (short)

See "Launch: single production environment" at the top of this document for the full gates. In short: the owner-supplied values are entered and the must-be-absent variables are absent; `main` is protected with the `acceptance` check; the `production` environment requires the owner and `main` only; Preview variables are deleted; Vercel protection is Standard; Neon is on the free plan (6-hour history, so snapshots are the recovery path) and the owner has turned Neon Auth off; the Protected branch and object-storage bucket checks are reported; a `pre-deploy-*` snapshot is taken before each migration and pruned strictly, failing loudly at a free-tier limit; local dev no longer points at the production endpoint; the soft-launch gates (owner only, real email, Safari/iPhone app/Android, hosted smoke, legacy import, restore drill, rollback drill) pass before friends are added; the privacy page has the owner's contact address, processor list and backup retention.

## Shell account state and 320 px header (PR A)

Scope: the app shell tells three states apart (visitor, signed in but profile unfinished, member) through `shellAccount()` in `lib/auth/public-access.ts`. `optionalPageMember` stays as is for page guards.

- Dependencies: `requireMember` throws `AccessDenied` 403 for a session with no profile and 401 for an expired session. No schema or data changes.
- Permission boundaries: no new access. The setup state only shows "Finish setting up" and "Sign out"; every page guard is unchanged. The member shell is shown only when `requireMember` succeeds.
- Changes: sidebar and phone header per state; shared `SignOutButton`; Settings gets the colour theme control (members no longer have it in the phone header); "No invitation needed." removed from the sign-in copy.

Acceptance cases:

1. After code sign-up, on `/onboarding` at 1280 px the Account group has "Finish setting up" and "Sign out" and no "Create account" or "Sign in"; at 375 px the header shows "Sign out".
2. Signing out lands on `/sign-in`, and `/account` then redirects to sign in.
3. After the profile is saved, the sidebar shows "Your account".
4. `/sign-in` and `/sign-up` contain no text matching /invitation|household key/i.
5. Signed in at 320, 375 and 390 px on `/`, `/recipes`, `/groceries`, `/account`, `/settings`: no horizontal overflow (measured against the visual viewport), header at most 56 px, no tap target under 44 px.
6. `shellAccount` unit cases: no cookie (auth untouched), member, 401, 403, other errors rethrown.
