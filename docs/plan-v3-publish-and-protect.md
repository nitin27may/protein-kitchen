# Publish and protect: Postgres, auth, GitHub backup, Vercel

Status: steps 12 and 14 implemented; isolated Neon development rehearsals verified after approval, public publishing not started. Updated 2026-10-24. The UI/photo work is built with owner checks still pending. Identity/provider changes and later infrastructure still follow their approval gates. See `roadmap.md` for current status; the PR numbers in this document are delivery labels, not GitHub pull request numbers.

## Current delivery status

GitHub Actions already runs typecheck, validation, tests, build and secret scanning; the latest inspected main-branch run passed both `ci` and `secrets`. The local workflow update adds all-branch pushes, manual dispatch, a temporary build database and downloadable test results. It will take effect on GitHub only after it is committed and pushed.

The application now uses the guarded node-postgres pool and awaited Drizzle transactions. All 33 legacy application tables retain parity, plus a new library-version table. Human sync markers, plan writes, prep/reset internals and seed/renames are awaited; seed and renames share one atomic transaction. Requests check a content fingerprint instead of seeding. Settings reset refuses to run before verified Postgres recovery exists. Existing SQLite files were not touched or imported.

PGlite behavior/round-trip coverage and 12 native Postgres 17 TCP checks pass locally, including concurrent regeneration and identity admission. Seven retained browser cases cover meal flows and actual authentication routes. Builds succeed without database access. CI declares disposable Postgres services, but remote runs require a push. Safe Neon development/import rehearsal and the auth backend are complete locally; onboarding screens, full authorization and deployment remain open. `neon.ts` is not proof of deployment; do not run `neon deploy` blindly.

Next delivery gates, in order:

1. Steps 12-14 and the identity schema are verified locally; approved synthetic Neon rehearsals are complete.
2. Finish authentication screens, verified household/profile onboarding and account collaboration (15/17).
3. Complete authorization on every application surface (16) before public access.
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

Slice 3C is not complete application protection: checkpoint 4 must still close legacy actions/routes, profile privacy, exports, push and service-worker caches. Keep local synthetic data only and do not publish.

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

1. Self-hosted `better-auth` with the Drizzle adapter on Neon Postgres for the required signup hooks. Current capability decision and implementation slices are above. Leave provisioned Neon Auth unchanged; disabling it is a separate owner-approved service change, not an implementation prerequisite.
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
