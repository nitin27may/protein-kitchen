# Protein Kitchen

A meal planner for a lacto-vegetarian household (dairy yes, eggs no, no animal rennet). It builds 7-day, 14-day or custom-range plans with per-person portions, a grocery list, a meal prep guide, step-by-step cook mode and push reminders. Runs on Next.js and Postgres. Anonymous visitors can browse the recipe/ingredient library; household features require a verified account and membership. Public deployment and independent self-service households remain pending; keep this development instance private.

`PLAN.md` holds the product intent. `CLAUDE.md` is the rulebook for adding data.

## Quick start

Requires Node 22 or later, pnpm 10 (`corepack enable` picks the pinned version) and a disposable local Postgres database or reviewed, isolated Neon development branch.

```bash
pnpm install
cp .env.example .env.local
# Configure DATABASE_ENV=development and DATABASE_URL for your isolated database.
# Supply DATABASE_ENV, DATABASE_URL_UNPOOLED and, for remote databases,
# DATABASE_NONPRODUCTION_HOST to these explicit CLI commands:
pnpm db:migrate:postgres
pnpm seed
pnpm dev                    # http://localhost:3000
```

CLI commands do not automatically load `.env.local`. Use a trusted environment loader or export the required variables. Application traffic uses `DATABASE_URL`; migration and seed use the direct `DATABASE_URL_UNPOOLED`. For remote non-production connections the exact host must match `DATABASE_NONPRODUCTION_HOST` (set it separately for pooled application and direct CLI hosts), and live Neon branch verification must pass before a database pool is created.

Requests never migrate or seed. Database-backed requests check a content fingerprint and refuse an absent/outdated library, including changes that leave row counts unchanged. Anonymous library browsing uses `/data` only and does not require database/auth/mail configuration. Run `pnpm seed` after editing data. Existing `db/app.db` files are untouched legacy sources; household-data import is a later step, not an automatic first-run operation.

For household features, configure authentication and finish verified membership/profile onboarding before creating a plan. The current signup/onboarding still uses invitation/bootstrap grants; replacing those with email-first self-service households is planned in `docs/plan-v3-publish-and-protect.md`, not enabled by public browsing.

## Features

- **Public library:** anonymous home, recipe/component methods and ingredient nutrition/source details, searchable without sign-in. Public top navigation replaces the private sidebar/bottom bar. Household photos, ratings, saved choices, profiles and plans are not published.
- **Profiles:** one per person, with their own targets, portions and reminders.
- **Plan generator:** deterministic and seeded. No repeats within 3 days, weeknights capped at 20 active minutes, swap any meal.
- **Cooking style:** Variety, Cook once and eat twice (default), or Batch cook.
- **Healthy focus:** low sugar, light and nutrient-dense filters, computed from ingredient data, never hand-labelled.
- **Meal prep guide** (`/plan/[id]/prep`): night-before tasks, ordered batch sessions with scaled ingredients and use-by dates, a reheat or cook-fresh list per day.
- **Spreadsheet view and export:** the plan's Sheet tab is a real spreadsheet (Univer, Apache-2.0): ribbon, formula bar, per-column filter and sort, frozen columns, copy and paste, zoom, and a tab per week, daily totals and groceries. Download Excel gives one sheet per week with every meal per person and full nutrition, a daily totals sheet and a grocery sheet. Download PDF gives a printable version. Both are built from one model in `lib/export/model.ts`.
- **Desktop first:** a left navigation rail and full-width content on large screens. Phones get a header and bottom bar. Theme switch (Auto, Light, Dark) is at the bottom of the rail.
- **Clear portions:** each meal shows what to eat, as pieces where countable ("2 rotis") and as approximate grams otherwise ("about 310 g"), with the serving count alongside.
- **Recipes:** every cooking step has a "done when" cue, many have tips. Technique cards cover tadka, bhuna, pressure cooker, rice and more. Storage and reheating advice on each recipe.
- **Cook mode:** full-screen steps with timers.
- **Groceries:** aggregated and grouped by aisle. Ticks queue offline and sync later.
- **Reminders:** web push, per profile.
- **Themes:** light, dark or system.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Dev server |
| `pnpm build` / `pnpm start` | Production build and server |
| `pnpm validate` | Validate all `/data` files, compute macros, print the report |
| `pnpm seed` | Validate, then atomically seed the explicitly configured dev/test Postgres library |
| `pnpm test` | Vitest (nutrition maths, planner, prep, reminders) |
| `pnpm test:coverage` | Full suite with V8 coverage for library code, actions/routes and client components; HTML and JSON reports in `coverage/` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm backup` | Legacy SQLite source backup only; requires explicit `DB_PATH` and refuses `DATABASE_URL` |
| `pnpm db:generate` | Generate application Postgres migrations (same config as the explicit Postgres command) |
| `pnpm db:generate:postgres` | Generate application Postgres migrations without connecting to a database |
| `pnpm db:migrate:postgres` | Apply Postgres migrations to an explicitly configured development/test database only |
| `pnpm db:verify:postgres runtime` / `migration` | Verify runtime or direct CLI configuration and live remote branch mapping without opening Postgres or changing credentials |
| `pnpm db:import:sqlite /absolute/path/to/source-copy.db` | Read-only legacy snapshot and checksum-verified import into an empty dev/test target; remote rehearsal needs an explicit branch pin and live verification |
| `pnpm test:e2e` | Saved phone-width Chromium browser regressions against an explicitly selected disposable local Postgres database |
| `pnpm vault:postgres publish /private/artifact --trust-artifact` | Explicit guarded operator publication of an existing trusted encrypted artifact; stable artifact id makes retries safe |
| `pnpm vault:postgres fetch <artifact-uuid> <commit-sha> /private/download-root` | Fetch checked ciphertext from one immutable commit into a new private `backup-<uuid>` directory; never decrypts or restores |

## CI and deployment

The [GitHub Actions workflow](https://github.com/nitin27may/protein-kitchen/actions/workflows/ci.yml) runs on every branch push and pull request, and supports **Run workflow** for a branch already on GitHub. It checks types, validates data, runs tests with coverage against isolated PGlite fixtures and a disposable native Postgres 17 service, builds without database access, and scans for secrets. Test results and coverage reports are available as `test-results` and `coverage` artifacts for 14 days. Local, unpushed changes do not start a GitHub run.

Coverage includes untested application files rather than reporting only imported modules. Atomic plan persistence, live branch verification, verified pool creation, application readiness and the import-target guard have 100% statement/branch/function/line gates. SQLite snapshot/restore requires at least 95% statement/branch coverage and 100% line/function coverage. These are not claims of 100% app-wide coverage. Native TCP tests run when `POSTGRES_TEST_URL` names a loopback-only database called `protein_kitchen_test`; they migrate and clear that disposable database. Never point them at household data. UI interaction and real-device checks remain separate from unit coverage.

Neon and Vercel deployment are not complete. Follow [the roadmap](docs/roadmap.md) and [the publish-and-protect plan](docs/plan-v3-publish-and-protect.md). Login/onboarding, household authorization, private photo adapters, state sync, encrypted recovery/vault tooling and durable reminder scheduling are implemented and verified locally. Approved live storage/state/vault/provider acceptance, protected hosting and cutover remain separate gates; do not expose the app publicly based on local success. Settings reset stays blocked until approved off-machine recovery and its pre-reset failure gate are complete.

Selective private state sync requires an explicit server-only
`STATE_SYNC_HOUSEHOLD_ID` alongside the App target and `STATE_SYNC_CLASSES`.
Only a verified owner of that household can view its status or invoke Sync now;
the separately authenticated scheduler uses the same pin. Other households see
sync as unavailable, not deployment-wide status. Household revisions and receipts
are independent. Changing the pin changes target identity and does not adopt
old checkpoints or authorize overwriting existing remote files; reconcile the
approved target through the conflict runbook before retrying. Leave sync disabled
until target and content consent are approved.

The application schema lives in `lib/db/postgres/`, re-exported by `lib/db/schema.ts`, with Drizzle history in `db/postgres-migrations/`; never apply the SQLite migration history to Postgres. Tests check parity of the 33 legacy tables with `lib/db/sqlite-schema.ts`, alongside additive library-readiness, identity/household, sync and reminder tables.

### Read-only protected-preview preflight

`pnpm deploy:preflight` checks only explicitly injected environment configuration and prints stable failure codes, never configuration values. It loads no environment files and performs no network requests, database/file writes or deployment. Require Vercel preview with `NODE_ENV=production` and `DATABASE_ENV=preview`, reviewed matching pooled/direct database URLs (`DATABASE_NONPRODUCTION_HOST` and `DATABASE_DIRECT_NONPRODUCTION_HOST`), distinct Neon development/production branch pins and server-only metadata API access. Existing auth/private-photo validators check the fixed HTTPS origin, secret and branch-bound read-only cloud-photo configuration.

Preview admission requires sync/reminder/vault flags absent or `false`, and mail/push/scheduler/vault credentials absent. Test-only transports/mailboxes, bootstrap credentials and obvious secret-bearing `NEXT_PUBLIC_*` variables are refused. This intentionally prevents auth email/push delivery; it is **not yet an end-to-end usable hosted signup preview**. A protected preview's separately isolated test delivery mechanism needs its own implementation/approval; never add production mail credentials just to make this check pass. Existing storage validators check configuration, not the bucket's live access mode.

Add `--verify-branch` to explicitly run the existing read-only fixed-origin Neon metadata checks for both endpoints. Missing/mismatched/default/production/protected/unready branch mappings fail closed. A configuration-only pass reports `liveBranchVerified:false`; even live metadata success is not storage/privacy/provider acceptance or deployment approval. No release workflow, production migration or Vercel promotion is enabled by this command.

For a **reviewed, isolated dev/test database**, supply `DATABASE_ENV=development` (or `test`), `DATABASE_URL_UNPOOLED` pointing to the direct endpoint, and `DATABASE_NONPRODUCTION_HOST` matching that exact remote host, then run `pnpm db:migrate:postgres`. The command does not read `.env.local` or `.neon`, never falls back to `DATABASE_URL`, and refuses production/preview environments and Neon pooler endpoints. Remote connections use TLS with certificate/hostname verification.

Remote non-production application startup, migration and seed additionally require `NEON_PROJECT_ID`, `NEON_DEVELOPMENT_BRANCH_ID`, `NEON_PRODUCTION_BRANCH_ID` and a server-only `NEON_API_KEY` with access to the project's metadata. The API key is used only for read-only GETs to the fixed Neon control-plane origin, with timeouts, no redirects and no response-body logging. Never expose it through `NEXT_PUBLIC_` or provide it to client components; use the least-privileged key supported by your account. Existing CLI OAuth login is not read by the application.

The live check rejects the production id, default/primary/protected branches, production/main names, non-ready branches, mismatched project/branch ids and unknown/read-only endpoints. Both the exact direct host and its derived pooler host must map to one read-write endpoint of the configured branch. API errors, missing metadata and unavailable credentials fail closed before pool creation. Remote non-Neon development targets are intentionally blocked until another provider-verification mechanism exists. Local loopback targets do not require Neon credentials; production remains outside this development-only control-plane check.

Application readiness shares one in-flight verification and pool across concurrent requests and retries after failure. A successful branch verification lasts for that process's pool lifetime, not each request; restart the process after changing branch identity/endpoint configuration. It does not authorize public exposure or replace database permissions. `pnpm db:verify:postgres runtime` or `migration` performs the same preflight without opening Postgres. Neither command writes `.env.local` or `.neon`. The approved schema-only `dev-step14-rehearsal` branch was created and rehearsed with synthetic data; it expires 2026-10-31 at 04:30 UTC. Existing credential files still select their original targets; do not assume they were switched.

### SQLite import rehearsal

Legacy version-1/version-2 human-file bundles have no household namespace.
Unscoped export refuses databases containing multiple households; use the
verified household-scoped shared export or encrypted whole-instance SQL backup
instead. Legacy human-file import is operator staging only and refuses any
database containing a household. It never guesses a target or merges people.
Export stamps and all imported classes commit atomically; a failed later class
rolls back earlier writes. This restriction does not replace the separately
guarded empty-target SQLite import or encrypted SQL restore procedures below.

Library recipe renames remain an operator seed operation. Shared feedback
conflicts, link/photo positions and photo covers are resolved within each
household (including unassigned legacy rows), never across households. Personal
feedback keeps per-person target choices. Each moved class marks its actual
household revision, and failure in any later class rolls back the entire rename.

Null-owned rows remain an operator-only quarantine/staging namespace. They are
not public library state and never belong to the first account that signs up.
The session-verified household-creation primitive creates an empty household,
owner membership and selection atomically without claiming legacy people or
plans. It currently has no public action/UI; signup admission remains gated.
Only the separately guarded empty-target legacy import may bind imported rows.

Use synthetic data only for now. Remote rehearsals require `SQLITE_IMPORT_NEON_BRANCH_ID` explicitly matching `NEON_DEVELOPMENT_BRANCH_ID`, in addition to all live branch/endpoint verification variables above. A host merely labelled development is insufficient; the verified pool is opened only after the metadata check passes. Production/preview imports remain disabled and actual household cutover needs separate approval. The importer requires the explicit direct `DATABASE_URL_UNPOOLED` and `DATABASE_ENV=development|test`; it does not load local credentials.

1. Prepare a private copy of the source database using the legacy backup procedure, never a file-only copy of a live WAL database. The source must have the current legacy SQLite schema. Missing/unknown tables or columns are errors; if necessary migrate another private copy, not the original.
2. Create a fresh disposable local Postgres database, or a fresh database on an explicitly approved schema-only Neon development branch, and apply `pnpm db:migrate:postgres`. **Do not seed first**: all application tables, including `library_state`, must be empty. The command never truncates or overwrites an existing destination.
3. Run `pnpm db:import:sqlite /absolute/path/to/private-source-copy.db`. A read-only SQLite transaction captures a consistent snapshot, checks integrity/references and normalizes booleans, JSON and explicit-offset timestamps. The Postgres transaction preserves ids, uids, creator ids and timestamps, verifies canonical per-table counts/SHA-256 digests and transactionally restarts identities. Timestamp spelling and JSON key order are normalized, not compared byte-for-byte.
4. On failure, all destination rows and identity restarts roll back; fix the reported source/constraint issue and retry against the same empty database. Driver SQL parameters are suppressed in CLI errors to avoid exposing human data. A completed import refuses a second run; use another disposable database for the second rehearsal.
5. Run `pnpm seed` explicitly before app startup. The importer deliberately leaves `library_state` empty rather than claiming old content matches the current library.

The source is never migrated or modified. An entirely empty source is refused; use the guarded seed for a new library instead. Top-level JSON null, unsafe JSON integers, malformed JSON/booleans/dates and unrepresentable values are refused rather than silently coerced. Digests cover database rows only: photo **metadata** is preserved, but photo bytes are not copied or verified. No new photo approval or human decision is created. Protect reports and source copies as private migration artifacts. This is not yet the production migration or backup/restore procedure.

### Encrypted vault operator (20C1-20C2)

`lib/backup/vault.ts` implements append-only publication of an explicitly trusted local encrypted backup through the pinned private GitHub App transport. Before target access it checks the bounded index, file allowlist, checksums, sizes and binary age framing; only canonical non-sensitive metadata and listed ciphertext are published. Framing is not proof of encryption, sender identity or recoverability: the source must be a trusted locally generated artifact. Identical artifact-id retries are no-ops; divergent contents are conflicts. Existing artifacts/unrelated files are preserved, branch updates never force, and ambiguous updates are reconciled before reporting success.

The operator command requires `NODE_ENV=development|test`, `DATABASE_ENV=development|test`, `VAULT_ENABLED=true` and every `VAULT_GITHUB_*` variable shown in `.env.example`. It never loads local credentials or falls back to state-sync variables. App/installation/repository identity, private/nonfork/nonarchived status and branch are checked by the pinned transport; a vault must use a different repository from selective state sync, whose managed-tree cleanup is not suitable for backups. Commands refuse Vercel/preview and production. No database connection is needed for publication/download. Supply secrets through an approved private operator environment, not command arguments.

`publish` uses the **same existing directory** on retries; generating a fresh backup first would create a new artifact id. Preserve that directory after failure and retry only after inspecting the error/target. `fetch` requires an existing private, non-symlink download root and an exact immutable commit SHA from the verified publication report, never a moving branch name. It refuses any existing `backup-<uuid>` destination, even empty, and writes files as 0600 in a 0700 directory. Index/blob responses, sizes, aggregate bytes, hashes, modes and paths are bounded/checked. A flushed temporary index is atomically renamed to `index.json` only after every ciphertext member passes; interrupted downloads have no valid completion marker and failures clean up or explicitly report cleanup failure. Never treat an incomplete directory as a backup.

Downloading ciphertext does not authorize executing its decrypted SQL. Only an owner-approved source may be passed to `pnpm restore:postgres <downloaded-directory> <offline-identity-file> <new-photo-directory> --trust-artifact`, with a separately configured empty disposable `RESTORE_DATABASE_URL`; see the [isolated recovery runbook](docs/plan-v3-publish-and-protect.md). Local acceptance uses signed loopback GitHub HTTP, real age/native dumps and downloaded-artifact restore parity, not real household data or a live remote vault.

This is not an enabled off-machine backup service. No real target, schedule or automatic retention/deletion is enabled. Deleting a Git tree entry would not erase its encrypted history; no expiry guarantee is made. Owner target/App/content consent, offline-key custody, retention choice, approved live off-machine acceptance and the pre-reset failure gate remain pending; Settings reset stays blocked. See [the detailed stage plan](docs/plan-v3-publish-and-protect.md).

### Repeatable browser tests

Create a disposable local database named exactly `protein_kitchen_e2e`, then supply `POSTGRES_E2E_URL` explicitly:

```bash
POSTGRES_E2E_URL=postgres://fixture@127.0.0.1:5432/protein_kitchen_e2e pnpm test:e2e
# Rerun only the relevant case during development:
POSTGRES_E2E_URL=postgres://fixture@127.0.0.1:5432/protein_kitchen_e2e pnpm test:e2e --grep "photo rejection"
```

The runner refuses remote URLs, alternate database names and host-override query parameters **before any test write**. Setup migrates and clears application tables in that disposable database, imports an all-table synthetic fixture, seeds the current library and prepares a deterministic night-before task. It starts its own loopback-only server on port 3112 with `.next-e2e`, scratch uploads and guarded synthetic push/mail/sync transports, and never reuses another server. Install Chromium once with `pnpm exec playwright install chromium` if the runner reports it missing.

Saved cases cover plan creation/swap/locked regeneration, shopping persistence across two browser contexts, night-before prep, real Excel/PDF payloads, photo Reject success/failure/retry, signup/onboarding/invitations, multi-account authorization, account controls, timezones, private state-sync and durable reminder scheduling. The separate CI `browser` job uses a disposable Postgres 17 service and Chromium, without Neon secrets or real outbound delivery. Failure screenshots/traces are retained for seven days; local artifacts are ignored.

## Configuration

Set in `.env.local` (git-ignored). Never commit it.

| Variable | Purpose |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web push keys. Generate with `pnpm dlx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | A `mailto:` contact you own. The example value is a placeholder, change it |
| `REMINDER_SCHEDULER_ENABLED` | Explicit `true` enables the reminder HTTP scheduler; default off, always off in preview |
| `REMINDER_SCHEDULER_SECRET` | Distinct random 32-128-character URL-safe bearer credential; server/scheduler only |
| `APP_TZ` | Shared plan time zone and fallback reminder clock; each profile may choose its own IANA reminder timezone. Default `America/Toronto` |
| `DATABASE_URL` | Pooled application Postgres connection; mandatory, with no SQLite fallback |
| `DATABASE_ENV` | Explicit database environment; must match `NODE_ENV` or `VERCEL_ENV` |
| `DATABASE_NONPRODUCTION_HOST` | Exact remote non-production endpoint host; additionally checked against live Neon metadata |
| `DATABASE_URL_UNPOOLED` | Direct dev/test connection for explicit migrations and seed |
| `NEON_PROJECT_ID` | Explicit project id for remote non-production metadata verification |
| `NEON_DEVELOPMENT_BRANCH_ID` | Explicit non-default, non-primary, unprotected development branch id |
| `NEON_PRODUCTION_BRANCH_ID` | Production branch id that non-production traffic must never select |
| `NEON_API_KEY` | Server-only credential for live read-only Neon metadata verification; never exposed to the browser |
| `SQLITE_IMPORT_NEON_BRANCH_ID` | Explicit remote rehearsal opt-in; must match the verified development branch id |
| `POSTGRES_E2E_URL` | Disposable loopback-only `protein_kitchen_e2e` database; browser setup clears its application tables |
| `DB_PATH` | Legacy SQLite source backup only; not used by the application |

There is no in-process reminder timer. After explicit provider/schedule approval, an external scheduler sends an empty **POST `/api/reminders`** with `Authorization: Bearer <REMINDER_SCHEDULER_SECRET>`, no query or payload, once per minute within the relevant cooks' local reminder windows. Both VAPID keys and explicit scheduler enablement are required; no cron is provisioned by the repository. Select timezone-aware windows rather than polling all day on a scale-to-zero database. HTTP 503 includes safe aggregate retry/ambiguous counts (or a fixed configuration/failure message), not task/device contents. A successful send is provider acceptance, not proof a phone displayed it.

Daily batches freeze the message and registered devices. Accepted devices never resend; explicitly rejected 429/503 attempts retry after a minute, at most three attempts within the original window. Timeouts, process interruption and other uncertain outcomes become **ambiguous** and are not automatically retried; do not delete receipts or manually resend to bypass that safeguard. Existing daily claims remain suppressed. No tasks/devices means no day claim, allowing later additions within the window. On iPhone, install the app to the Home Screen first; real Android/iPhone delivery is still an owner/device acceptance check.

## Data

Everything the app knows lives in `/data` as JSON and Markdown, validated by Zod schemas in `lib/schemas`.

| Folder | Content |
|---|---|
| `data/ingredients/` | Ingredients by aisle, with macros per 100 g and a source (CNF, USDA or IFCT 2017) |
| `data/nutrients/micros.json` | Vitamins and minerals, with `not_reported` lists |
| `data/recipes/` | Meals by family |
| `data/components/` | Parts of meals (hummus, dressings, baked falafel) by family |
| `data/techniques/` | Technique cards |
| `data/habits.json` | Habits with evidence grades |
| `data/validation-overrides.json` | Explicit exceptions for the validator |

Rules that matter: macros live only on ingredients, all quantities are grams, new recipes are `status: "draft"`, and no supplement doses appear anywhere. Run `pnpm validate` after every data change. Full rules are in `CLAUDE.md`.

Photos: add your own on a recipe page (resized on the phone, stored in `uploads/`), or approve candidates from Wikimedia Commons and Openverse at `/photos/review`. Build the candidate list with `pnpm photos:candidates`. See `CLAUDE.md`, section Photos.

## Project layout

```
app/          Next.js routes, server actions, API routes for push
components/   UI and client components
lib/          schemas, nutrition, planner, grocery, prep, reminders, server, db
data/         recipes, ingredients, techniques, habits
db/           Postgres migrations; preserved legacy SQLite migrations/source
docs/         nutrient targets, healthy criteria, UX research
scripts/      validate, seed, backup
tests/        Vitest suites
```

## Gotchas and known issues

- Nutrient numbers are estimates from food-composition databases. This is not medical advice. Ask a doctor about a blood test for B12, vitamin D and ferritin.
- The nutrient-density score is the app's own NRF-style version, not the published formula.
- A few ingredients are unresolved because there is no reliable database entry: skyr, roasted chana, sattu, nutritional yeast, ultrafiltered milk, exact soya chunks (a defatted soy flour stand-in is used).
- Rennet-bearing cheeses (feta, parmesan, halloumi and similar) are deliberately unused in recipes.
- Cooking cues and times are general guidance. Your cooker and stove will differ.
- Push delivery to a real phone has not been tested end to end.
- `db/app.db` and `backups/` must never be committed.
