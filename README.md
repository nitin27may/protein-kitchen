# Protein Kitchen

A personal meal planner for a lacto-vegetarian household (dairy yes, eggs no, no animal rennet). It builds 7-day, 14-day or custom-range plans with per-person portions, a grocery list, a meal prep guide, step-by-step cook mode and push reminders. Runs on Next.js and Postgres. Deployment and authentication are not yet implemented; keep it private.

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

Requests never migrate or seed. Startup checks a content fingerprint and refuses an absent/outdated library, including changes that leave row counts unchanged. Run `pnpm seed` after editing data. Existing `db/app.db` files are untouched legacy sources; household-data import is a later step, not an automatic first-run operation.

First run: open Profiles, add everyone who eats, then create a plan.

## Features

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
| `pnpm db:import:sqlite /absolute/path/to/source-copy.db` | Read-only legacy snapshot, atomic import and checksum verification into an empty loopback dev/test Postgres database |

## CI and deployment

The [GitHub Actions workflow](https://github.com/nitin27may/protein-kitchen/actions/workflows/ci.yml) runs on every branch push and pull request, and supports **Run workflow** for a branch already on GitHub. It checks types, validates data, runs tests with coverage against isolated PGlite fixtures and a disposable native Postgres 17 service, builds without database access, and scans for secrets. Test results and coverage reports are available as `test-results` and `coverage` artifacts for 14 days. Local, unpushed changes do not start a GitHub run.

Coverage includes untested application files rather than reporting only imported modules. Atomic plan persistence, live branch verification, verified pool creation, application readiness and the import-target guard have 100% statement/branch/function/line gates. SQLite snapshot/restore requires at least 95% statement/branch coverage and 100% line/function coverage. These are not claims of 100% app-wide coverage. Native TCP tests run when `POSTGRES_TEST_URL` names a loopback-only database called `protein_kitchen_test`; they migrate and clear that disposable database. Never point them at household data. UI interaction and real-device checks remain separate from unit coverage.

Neon and Vercel deployment are not implemented yet. Follow [the roadmap](docs/roadmap.md) and [the publish-and-protect plan](docs/plan-v3-publish-and-protect.md). The Postgres app still has no login or authorization and must not be exposed publicly. Safe cloud database selection/import, authentication, authorization, cloud photo storage and recoverable backups precede the Vercel cutover. Settings reset is deliberately blocked until the Postgres backup/restore prerequisite is complete.

The application schema lives in `lib/db/postgres/`, re-exported by `lib/db/schema.ts`, with Drizzle history in `db/postgres-migrations/`; never apply the SQLite migration history to Postgres. Tests check parity of the 33 legacy tables with `lib/db/sqlite-schema.ts`; the additional `library_state` table records the seeded content version. Login and household tables will be added with the identity implementation.

For a **reviewed, isolated dev/test database**, supply `DATABASE_ENV=development` (or `test`), `DATABASE_URL_UNPOOLED` pointing to the direct endpoint, and `DATABASE_NONPRODUCTION_HOST` matching that exact remote host, then run `pnpm db:migrate:postgres`. The command does not read `.env.local` or `.neon`, never falls back to `DATABASE_URL`, and refuses production/preview environments and Neon pooler endpoints. Remote connections use TLS with certificate/hostname verification.

Remote non-production application startup, migration and seed additionally require `NEON_PROJECT_ID`, `NEON_DEVELOPMENT_BRANCH_ID`, `NEON_PRODUCTION_BRANCH_ID` and a server-only `NEON_API_KEY` with access to the project's metadata. The API key is used only for read-only GETs to the fixed Neon control-plane origin, with timeouts, no redirects and no response-body logging. Never expose it through `NEXT_PUBLIC_` or provide it to client components; use the least-privileged key supported by your account. Existing CLI OAuth login is not read by the application.

The live check rejects the production id, default/primary/protected branches, production/main names, non-ready branches, mismatched project/branch ids and unknown/read-only endpoints. Both the exact direct host and its derived pooler host must map to one read-write endpoint of the configured branch. API errors, missing metadata and unavailable credentials fail closed before pool creation. Remote non-Neon development targets are intentionally blocked until another provider-verification mechanism exists. Local loopback targets do not require Neon credentials; production remains outside this development-only control-plane check.

Application readiness shares one in-flight verification and pool across concurrent requests and retries after failure. A successful branch verification lasts for that process's pool lifetime, not each request; restart the process after changing branch identity/endpoint configuration. It does not authorize public exposure or replace database permissions. `pnpm db:verify:postgres runtime` or `migration` performs the same preflight without opening Postgres. Neither command writes `.env.local` or `.neon`. Creating the isolated development branch and the actual cloud rehearsal still need approval.

### Local SQLite import rehearsal

Use synthetic data only for now. The importer refuses **all remote hosts**, even a host labelled development; an approved isolated Neon branch/rehearsal and final household cutover approval are still pending. The new runtime/migration metadata guard does not by itself enable remote imports. The importer requires the explicit direct `DATABASE_URL_UNPOOLED` and `DATABASE_ENV=development|test`; it does not load local credentials.

1. Prepare a private copy of the source database using the legacy backup procedure, never a file-only copy of a live WAL database. The source must have the current legacy SQLite schema. Missing/unknown tables or columns are errors; if necessary migrate another private copy, not the original.
2. Create a fresh disposable local Postgres database and apply `pnpm db:migrate:postgres`. **Do not seed first**: all application tables, including `library_state`, must be empty. The command never truncates or overwrites an existing destination.
3. Run `pnpm db:import:sqlite /absolute/path/to/private-source-copy.db`. A read-only SQLite transaction captures a consistent snapshot, checks integrity/references and normalizes booleans, JSON and explicit-offset timestamps. The Postgres transaction preserves ids, uids, creator ids and timestamps, verifies canonical per-table counts/SHA-256 digests and transactionally restarts identities. Timestamp spelling and JSON key order are normalized, not compared byte-for-byte.
4. On failure, all destination rows and identity restarts roll back; fix the reported source/constraint issue and retry against the same empty database. Driver SQL parameters are suppressed in CLI errors to avoid exposing human data. A completed import refuses a second run; use another disposable database for the second rehearsal.
5. Run `pnpm seed` explicitly before app startup. The importer deliberately leaves `library_state` empty rather than claiming old content matches the current library.

The source is never migrated or modified. An entirely empty source is refused; use the guarded seed for a new library instead. Top-level JSON null, unsafe JSON integers, malformed JSON/booleans/dates and unrepresentable values are refused rather than silently coerced. Digests cover database rows only: photo **metadata** is preserved, but photo bytes are not copied or verified. No new photo approval or human decision is created. Protect reports and source copies as private migration artifacts. This is not yet the production migration or backup/restore procedure.

## Configuration

Set in `.env.local` (git-ignored). Never commit it.

| Variable | Purpose |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web push keys. Generate with `pnpm dlx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | A `mailto:` contact you own. The example value is a placeholder, change it |
| `APP_TZ` | Time zone for plans and reminders. Default `America/Toronto` |
| `DATABASE_URL` | Pooled application Postgres connection; mandatory, with no SQLite fallback |
| `DATABASE_ENV` | Explicit database environment; must match `NODE_ENV` or `VERCEL_ENV` |
| `DATABASE_NONPRODUCTION_HOST` | Exact remote non-production endpoint host; additionally checked against live Neon metadata |
| `DATABASE_URL_UNPOOLED` | Direct dev/test connection for explicit migrations and seed |
| `NEON_PROJECT_ID` | Explicit project id for remote non-production metadata verification |
| `NEON_DEVELOPMENT_BRANCH_ID` | Explicit non-default, non-primary, unprotected development branch id |
| `NEON_PRODUCTION_BRANCH_ID` | Production branch id that non-production traffic must never select |
| `NEON_API_KEY` | Server-only credential for live read-only Neon metadata verification; never exposed to the browser |
| `DB_PATH` | Legacy SQLite source backup only; not used by the application |

Reminders run on a 1-minute timer started in `instrumentation.ts`, and only when both VAPID keys are set. On iPhone, install the app to the Home Screen first, otherwise push is not available.

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
