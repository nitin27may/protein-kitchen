# Publish and protect: Postgres, auth, GitHub backup, Vercel

Status: step-12 async Postgres application port implemented and verified locally; publishing not started. Updated 2026-10-23. The UI/photo work is built with owner checks still pending. The infrastructure and identity recommendations below still need confirmation before provisioning or changing existing services. See `roadmap.md` for current status; the PR numbers in this document are delivery labels, not GitHub pull request numbers.

## Current delivery status

GitHub Actions already runs typecheck, validation, tests, build and secret scanning; the latest inspected main-branch run passed both `ci` and `secrets`. The local workflow update adds all-branch pushes, manual dispatch, a temporary build database and downloadable test results. It will take effect on GitHub only after it is committed and pushed.

The application now uses the guarded node-postgres pool and awaited Drizzle transactions. All 33 legacy application tables retain parity, plus a new library-version table. Human sync markers, plan writes, prep/reset internals and seed/renames are awaited; seed and renames share one atomic transaction. Requests check a content fingerprint instead of seeding. Settings reset refuses to run before verified Postgres recovery exists. Existing SQLite files were not touched or imported.

PGlite behavior/round-trip coverage and four native Postgres 17 TCP checks pass locally, including concurrent regeneration; native synthetic browser checks cover plans, swaps, groceries, prep, routines, rejection and exports. Builds succeed with an unreachable database URL. CI now declares a disposable Postgres service, but remote runs require a push. Auth/household schema, safe Neon branch selection/import and deployment remain open. `neon.ts` is not proof of deployment; do not run `neon deploy` blindly.

Next delivery gates, in order:

1. Step 12's async-driver/transaction work is verified locally; finish the remaining identity-schema portion of step 13 alongside its implementation.
2. Select an isolated Neon development branch, add production-target guards, and rehearse SQLite import with counts and checksums (14). Do not use an existing production pointer for development.
3. Implement authentication, authorization and household/account screens (15-17) before public access.
4. Wire cloud photos, state sync and encrypted backup/restore (18-20).
5. Add environment-scoped deployment automation and cut over to Vercel with protected previews, migrations, scheduler, domain and email DNS (21). Never seed a production database from an ordinary validation workflow.

## Execution plan from the current checkpoint

Original planning baseline: local commit `8974a0d`. The local application adapter/transaction port and acceptance checks below are now implemented; photo/mobile work was saved in `6369e73` and atomic persistence/coverage in `15ad10b`. Remaining cloud/identity/recovery gates are unchanged. Approval of this plan does not authorize deleting cloud services, purchasing plans, importing personal data into previews, or production cutover.

Execute one checkpoint at a time. Finish implementation and its acceptance checks, save a focused commit, update `roadmap.md`, then move to the next unblocked checkpoint. Do not stop merely to announce the next item. If an external service blocks a checkpoint, continue independent local work, state the blocker precisely, and never mark the blocked checkpoint complete. Start no unattended background work unless it has a concrete bounded task or a required service.

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

Local importer implemented: `pnpm db:import:sqlite` reads all 33 legacy tables without changing the source, verifies per-table canonical counts/checksums before commit, restores original human metadata through `lib/human/sqlite-restore.ts` and repairs identities transactionally. It refuses nonempty destinations and every remote host. Synthetic PGlite/native Postgres tests cover two fresh rehearsals, concurrent imports, interrupted writes, checksum mismatch, identity-repair rollback/retry and human export preservation after explicit seed. See README for the local-only procedure.

Cloud gate remains open: read-only Neon inventory found only `production`; no development branch was created, no credentials changed and no remote migration/import ran. Creating a schema-only development branch requires explicit approval. API-verified branch-to-host selection, dev startup protection and the Neon application smoke check remain unfinished; the host allowlist alone does not satisfy them.

1. Inspect the linked Neon project's branch identities and endpoint mapping without printing connection secrets. Select or create an isolated development branch with synthetic/empty data; do not copy personal production data into an unprotected environment.
2. Reconcile environment-variable names with the pool and migration commands. Separate pooled application traffic from direct migration/import traffic. Verify the actual branch-to-host mapping; an operator-supplied host name alone is not proof of branch identity.
3. Implement a read-only SQLite source importer and deterministic canonical per-table checksums. Preserve ids/references and human metadata, normalize dates/booleans/JSON, order inserts by dependencies, reset identity sequences and verify counts/checksums. Keep this distinct from ordinary library seeding.
4. Reject an unexpected nonempty destination; do not truncate it automatically. Make interrupted-import recovery explicit and rehearse it with synthetic fixtures before touching household data.
5. Apply baseline and library seed to dev only, rehearse import twice into disposable targets, and run application smoke checks.

Acceptance: dev startup against a production endpoint is refused; migrations use the direct dev endpoint; imported relationships and checksums match; the next generated id does not collide; source SQLite remains unchanged. Real household import waits for the final backup/cutover gate.

### Checkpoint 3: Authentication and household identity (roadmap 15 and schema portion of 17)

1. Revalidate current Better Auth capabilities, invitation hooks, email-code support and dependency compatibility before selecting managed versus self-hosted deployment. Preserve the planned invite-only requirement; do not disable existing Neon services as part of investigation.
2. Implement the selected auth schema/configuration, sessions, verification/reset flows, password and email-code sign-in, Resend integration, and rate limits. Use a test mail transport locally; sending-domain setup can wait without blocking local implementation.
3. Add household membership, owner/member roles and optional profile linkage. Implement a one-time, race-safe bootstrap claim; public sign-up must not grant ownership. Do not put login email on `people`.
4. Build sign-in, code verification, password-reset and account entry screens. Use current installed Next documentation for cookies, Server Actions and `proxy.ts`.

Acceptance: session expiry/revocation works; invite-only access and bootstrap races are tested; wrong/expired/reused codes are refused; email failures are visible; phone-width sign-in works. Real email delivery requires the owner's verified domain/account.

### Checkpoint 4: Authorization and account UI (roadmap 16-17)

1. Define an owner/member permission matrix, including profile privacy and shared plan visibility. Authorize every Server Action, route and export server-side; middleware/proxy alone is insufficient.
2. Verify child-object membership for swaps, portions, grocery mutations and similar operations; bind push subscriptions to the session rather than a trusted request-body person id.
3. Add invitation, role/profile-link, account export/deletion screens. Preserve at least one owner and prevent role escalation.
4. Migrate ratings/favourites to the agreed per-person model, keeping tested/banned household-wide; version the human export format and test legacy imports.
5. Stop caching personal responses in the service worker; clear private caches on sign-out. Add appropriate response/cache/security headers and session-bound offline mutation handling.

Acceptance: anonymous, member, owner and foreign-object negative cases pass; members cannot obtain another person's private profile fields through pages, actions or exports; logout removes cached personal content. Complete an authorization review before any public deployment.

### Checkpoint 5: Cloud photos and state sync (roadmap 18-19)

1. Implement the private cloud `BlobStore` adapter, authenticated photo delivery and signed-URL lifetime rules. Preserve the existing metadata-stripping WebP pipeline; do not restore raw originals merely because the older recommendation below says "originals".
2. Keep previews isolated and disable preview uploads/push by default. Test failed uploads, missing objects, deletion and database/blob consistency.
3. Add GitHub App integration scoped to a dedicated private state repo. Export only the agreed non-health data classes using stable slugs/uids; do not send profiles, weights or plans in plaintext.
4. Implement incremental sync, explicit conflict/error handling, retry-safe commits, "Sync now", last-success/failure status and an authenticated scheduled endpoint.

Acceptance: unauthorized photo access fails; approved photo upload/display survives reload; export/import round trips remain stable; retries do not duplicate changes; synthetic sync creates the expected private-repo content. GitHub App credentials and target repository are owner-provided gates.

### Checkpoint 6: Recoverable backups and reminders (roadmap 20 and part of 21)

1. Implement direct-connection Postgres dump/restore tooling and age-encrypted vault backup. Use the owner's public encryption recipient; never upload or retain the owner's private decryption key.
2. Provide a scheduler-compatible backup runner with PostgreSQL tools, explicit retention and failure reporting. Do not assume a Vercel request can safely perform a large dump.
3. Rehearse decrypt/restore into an isolated database, verify checksums and relationships, and verify photo recovery separately. Only then enable destructive resets backed by this path.
4. Replace `setInterval` reminders with an authenticated, retry-safe scheduler endpoint. Preserve per-person timezone/window behavior and prevent duplicate sends across concurrent invocations.

Acceptance: a synthetic encrypted backup restores successfully; backup failure blocks reset; scheduler retries do not duplicate reminders; private data never appears in logs or plaintext git artifacts. Real Android/iPhone delivery remains a device check.

### Checkpoint 7: GitHub Actions and protected Vercel preview (roadmap 21 preparation)

1. Push approved implementation commits and observe actual CI runs; local commits alone are not GitHub-visible progress. Handle remaining UI/photo work as its own focused commit, not mixed into the database port.
2. Extend CI with the disposable TCP Postgres service, migration/seed/import rehearsal and restore coverage. Ordinary branch validation uses synthetic local data and no production secrets.
3. Add protected environment-scoped release jobs with least-privilege secrets, per-environment concurrency and explicit migration approval. Untrusted/fork PRs never receive cloud credentials.
4. Configure Vercel Node/Fluid runtime and pooled database access. First deploy only to a protected preview with isolated data, a separate auth secret and outbound side effects disabled.
5. Run release migration and library seed as a controlled step with the direct connection, not as an incidental side effect of `next build`. Require expand-compatible schema changes and a rollback procedure.

Acceptance: remote CI is green; protected preview works end to end; no local SQLite/upload filesystem dependency remains; secret scopes, unauthorized access and preview isolation are checked. A failed release step must not promote a deployment.

### Checkpoint 8: Production cutover and owner checks (roadmap 21 completion)

1. Confirm domain, email DNS, service plans, production secrets and the owner's offline backup key. Resolve the outstanding human nutrition/data checks or explicitly document accepted limitations without inventing values.
2. Obtain explicit cutover approval. Pause writes on the old app, take a final SQLite/uploads backup, perform the rehearsed import and verify counts/checksums before allowing writes.
3. Apply production configuration, deploy, bootstrap the owner, invite a member and verify permissions. Exercise plan/export/photo flows, email, push, state sync, encrypted backup and a restore drill.
4. Keep the old instance read-only for the agreed rollback window. If checks fail, stop writes and follow the rollback runbook; switching code alone cannot undo new database writes.

Acceptance: production smoke checks and owner device checks pass; first scheduled sync/backup succeeds; recovery is demonstrated; `roadmap.md` records the actual deployment and remaining owner-only limitations.

### Approval defaults and decision gates

Defaults for implementation: retain Drizzle and node-postgres; one household per deployment; owner/member roles; invite-only access; synthetic isolated previews; private cloud photos; no plaintext health data in git; no paid upgrades or public deployment without approval. Auth-provider and storage capability assumptions from the original proposal must be rechecked against current documentation before implementation. GitHub pushes, cloud provisioning/service changes and the final personal-data import must be explicit, visible actions; destructive service changes and final cutover need separate approval.

## Why this is more than a hosting change

Today there is no login, no authorisation check in any Server Action, a synchronous SQLite data layer, `VACUUM INTO` backups, and a `setInterval` reminder loop. None of that works on Vercel. Tailscale currently keeps the app off the internet; publishing removes that.

Verified in the code: `app/actions.ts` has no auth anywhere; `swapSlot`, `setPortion`, `setManualChecked` and `removeManualItem` do not check that the item belongs to the plan; `api/push/subscribe` trusts a person id from the request body; `api/plan/[id]/export` is open and plan ids are sequential (an IDOR); `lib/server/context.ts` reseeds at request time; `public/sw.js` caches personal pages after sign-out. `.env.local` and `.neon` currently point at the Neon `production` branch, so any seed, reset or test run with those settings would write to production (the app still uses SQLite, so nothing does today). `.gitignore` misses the SQLite `-wal` and `-shm` files, `.env` and `.env.production`.

## Decisions recommended (owner to confirm)

1. Self-hosted `better-auth` with the Drizzle adapter on Neon Postgres, not Neon Auth (Neon Auth has no sign-up hooks, cannot make sign-up invite-only, and cannot send verification links from its shared sender). Turn off the provisioned Neon Auth.
2. Do PR 0 (git repo, GitHub, CI) now, before the rest of the UI work.
3. PR 1a, an async facade: make `queries.ts` and the action helpers async now, so the later Postgres move is mechanical.
4. Sign-in: email and password, plus an emailed 6-digit code. No magic links (the installed iPhone home-screen app has its own cookie store, so links open in Safari). No social login yet.
5. Two roles, owner and member. Members cannot see another person's height, weight or birth date. Only owners reset data, sync, restore or invite.
6. One household per deployment, no `household_id`. A `household_members` table links login users to roles and optionally to a profile. A profile can exist without a login. No email column on `people`: the login email lives on the auth user, and pending emails on `invitations`.
7. Ratings and favourites per person; `tested` and `banned` stay household-wide.
8. Library content is git-first. Human-owned data created in the app (feedback, links, photo approvals, saved views, routine choices) is exported nightly and on demand to a separate private state repo through a GitHub App. Each data class syncs in one direction only.
9. Health data (profiles, weights, plans) never goes to git in plaintext. It stays in Neon (Launch plan recommended for 7-day point-in-time restore) plus a nightly age-encrypted dump to a private vault repo. The age private key lives only with the owner.
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
- Free-plan point-in-time restore is 6 hours, so the vault is the real backup until a paid plan.
- Better Auth may need zod 4 while the app uses zod 3. Check before PR 16.
- Phones must re-subscribe to push on the new domain with new VAPID keys.
- Not verified yet: the `neon checkout` create flag, bucket credentials on preview branches, Vercel's exact client-IP header, whether GitHub rulesets work on this private repo.

## Go-live checklist (short)

All of PRs 0 to 21 merged with CI green including the restore round trip; domain and email DNS verified; environment variables set as Sensitive; previews protected; Neon Auth off; final SQLite backup taken and the import verified by counts and checksums; owner signs up and claims the household; one member invited and checked against the role table; IDOR checks by hand; a reminder received on Android and on an installed iPhone app; first state sync and vault backup succeeded; restore drill done into a throwaway branch; the old homelab instance kept read-only for two weeks.
