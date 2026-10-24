# Roadmap: step by step, in order

Last updated 2026-10-23 (steps 10 and 11 built; see docs/plan-step-10-11.md). This merges `plan-v2-experience.md` (UI and data) and `plan-v3-publish-and-protect.md` (database, login, backup, go-live) into one ordered list. Work top to bottom; a step starts only when the ones it depends on are done and verified.

Each step ends with the same checks: `pnpm typecheck`, `pnpm test`, `pnpm validate`, `pnpm build` all pass, the screen is looked at in a browser (desktop and phone width), then one commit pushed to `main` on GitHub.

## Status

| Step | What | State |
|---|---|---|
| 12 | Awaited Postgres transactions, atomic persistence and seed/renames, runtime/content-version guards, isolated database tests and native TCP checks | Implemented locally; cloud import/deployment not performed |
| 11 | Data debts: water in four recipes, kheera-raita override, falafel step wording, effective time in tags, make-ahead total in the plan review, reset counts, phone-width audit, nutrition source review. Open: falafel soaked weight (needs your measurement), four unsourced foods, CNF values when the service returns | Done except those |
| 10 | Photos: your own uploads, reviewed candidates from Commons and Openverse, aisle tiles, collage only with 3+ photos, BlobStore, exporters, backup of uploads. Open: you review the candidates; real-iPhone upload check | Built |
| A | Design system, ingredients library and photos, Settings reset, plan creation redesign, page redesigns | Done |
| 0a | Private GitHub repo `nitin27may/protein-kitchen`, `.gitignore` fixed, secret scan | Done |
| 1 | Night-before prep tasks unified (Today, prep guide, 21:00 reminder) | Done |
| 2 | Filters: toolbar, drawer, URL state, saved default, Recipes and Ingredients | Done |
| 3 | Filters on picker, pin sheet, swap sheet, groceries | Done; populated-plan phone-width audit performed |
| 4 | Composite meals data: components folder, water and store-bought hummus, effective time, falafel migration | Done |
| 10a | Today dashboard by plan phase and time of day | Done |
| 10b | Today with routines: morning routine card with ticks and evidence, 'Add a morning routine' prompt, routine protein line, shopping day in shop-by, next-steps strip | Done |
| 9 | Step-by-step plan creation: five steps (who and when, meals and effort, food, daily routine, review) with a live 'Will this plan work?' check, shopping and prep day, next-steps strip after generating | Done |
| 8 | Daily routines: methi, jeera, ajwain, jeera-methi, saunf, chia water and soaked almonds; evidence-graded, 6 g cap enforced by the validator; chosen per person, snapshotted into each plan; groceries and night-before soaks follow | Done |
| 7 | Recipe and video links on a recipe, part or step; https only, tracking stripped, YouTube and Vimeo play in a click-to-load sheet; human-owned, exported with ratings | Done |
| 6 | Cook mode across parts: start screen with Already made toggles, steps ordered by hands-off time with a 'While X rests: make Y' hint, a timer tray whose timers keep their end time (survive step changes and reloads) | Done |
| 5 | Parts of a meal: timeline, per-part cards, Make / Buy / Have saved per plan, groceries and prep respect it, "Used in" on part pages | Done |
| 1a | Async data layer behind one transaction helper; one write path and export/import for human-owned data (ratings, saved views); portable column helpers; renames file | Done |
| 0b | CI (typecheck, validate, test, build, secret scan), pre-commit secret hook, Dependabot, branch protection (no force-push or deletion, `ci` and `secrets` required for PRs, owner can still push) | Done |

## The sequence from here

### Step 1. Finish Today (10a), then verify (done)
Scope: phase hero, per-person protein bars, tonight and overdue prep, grocery status, morning basics, time-of-day order. Routine pieces wait for step 9.
You will see: a Today screen that says what to do next. Done when: phase and clock tests pass, and the screen is checked for each phase using a scratch database.

### Step 2. Repo safety (0b), about 3 hours (done)
Scope: CI workflow (typecheck, test, validate, build, secret scan), a pre-commit hook that scans staged files for secrets and runs `pnpm validate` when `/data` changes, Dependabot, branch protection if the plan allows it on a private repo (otherwise a note and a decision on GitHub Pro).
Done when: a push triggers a green CI run, and a test commit containing a fake key is blocked.
Decision: GitHub Pro for branch protection, yes or no.

### Step 3. Prepare for the database move (1a), about 4 hours (done)
Scope: make the data helpers async now, move direct database calls out of pages, add portable column helpers, a single `lib/human/` module for anything you create in the app (ratings, links, photos, saved views, routine choices), and the first version of the exporter with a round-trip test. Add `data/renames.json` so a renamed slug moves ratings, links and photos with it. Clean up the stale `baked-falafel-mix` row.
You will see: nothing new on screen. Done when: tests prove export then import gives identical data.

### Step 4. Parts of a meal on the recipe page (5) (done)
Scope: a "Parts of this meal" section for falafel bowl and similar: each part with its time, fridge life, protein it adds, ingredients, steps with cues and its own links later. A Make / Buy / Have switch per part saved per plan, and a plain timeline ("soak chickpeas the night before; hummus up to five days ahead; bake falafel on the day"). Part pages get a "Used in" list and appear in the Recipes list behind "Show parts". Groceries respect Have and Buy.
You will see: how to make hummus from the falafel bowl page. Done when: Have removes hummus from groceries and Buy adds store-bought hummus at the same grams.
Needs: `plan_part_state` table (text and integer types only).

### Step 5. Cook mode across parts and several timers (6) (done)
Scope: cook mode orders parts (longest hands-off first, "While the falafel bakes: make the hummus"), skips parts marked Have or Buy, shows which part each step belongs to, and replaces the single timer with a tray of timers that survive step changes and store their end time so they do not drift in a background tab.
Done when: starting a 25 minute bake, moving to the hummus step and back keeps the bake timer running.

### Step 6. Recipe links and videos (7) (done)
Scope: add a link (recipe page, video, article) to any recipe, part or step; stored in the database, edited from a small sheet, never written by the agent. Only https links, no credentials in the URL, tracking parameters removed, your own title. YouTube and Vimeo play in a sheet inside cook mode; everything else opens normally. Added to the exporter from step 3.
Done when: a link survives a re-seed and an export and import round trip.

### Step 7. Daily routines (8) (done)
Scope: a new kind of small recipe for things like methi water, ajwain water, jeera-methi water and chia water, linked from the habits list with the evidence grade, caution and the night-before soak. You pick them per person with days and time of day. Their ingredients join the grocery list (spices shown under "Check pantry" with the amount), their soak becomes a night-before task, their macros show as a separate line in the day. Overnight oats stays a breakfast recipe.
Evidence and safety: grades shown honestly, cautions (pregnancy, diabetes medicine, allergies), no doses, a culinary-amount cap enforced by the validator.
Data to add: look for a proper ajwain entry (IFCT 2017); until found, ajwain stays a labelled caraway stand-in.
Decision: the cap on seed amounts per routine, and the default days.

### Step 8. Step-by-step plan creation (9) (done)
Scope: one flow with five steps: who and when (optionally shopping and prep days), meals and effort, food (likes, avoids, cuisine mix, healthy focus, pins), daily routine, review. Each step except the first can be skipped, and a repeat run opens on Review with last week's choices. The review shows what the planner can actually reach (eligible recipes per meal, protein each person can hit). After generating: a three-step strip, Review and swap, What to buy, Prep tonight.
Done when: a repeat plan takes under a minute and ends on the grocery list.

### Step 9. Today with routines (10b) (done)
Scope: add the morning routine card, and "Add a morning routine" when none chosen, into the Today screen from step 1.

### Step 10. Photos you take or approve (11 and 12) (built; owner checks pending)
Scope: upload a photo on any recipe or when ticking "Cooked and tested"; resize on the phone, convert to WebP and strip location data on the server; stored through a storage interface (local folder now, Neon bucket later). A review page lists candidate photos from Wikimedia Commons and Openverse with source, licence and author, and nothing shows until you approve it. Ingredients without a photo get an aisle tile with an icon; recipe collages only when there are three or more ingredient photos.
Decision: your own photos first, no Unsplash, no AI-generated recipe images.

Verified 2026-10-23 on a scratch database with Playwright: Reject removes a candidate and the decision survives reload. A failed request shows an error, leaves the candidate in the queue, and allows retry. This does not reproduce or explain the reported failure in the owner's original instance.

Still pending: owner photo approvals, a real iPhone upload, and broader candidate coverage. The current candidate file has 218 candidates across 56 recipe subjects (17 have no candidates), plus 119 candidates across 21 ingredients. The ingredient batches cover almonds, black beans, bulgur, chickpeas (dry and canned), paneer, oats, spinach, tempeh, tofu, tomatoes, Greek yogurt, milk, quinoa, white and brown rice, kidney beans, lentils, onions, cucumber and red pepper. Quinoa and cucumber succeeded on retry. Retrying the unblocked `white-bean-zucchini-skillet` recipe found no candidates; the other 16 empty recipe entries are explicitly blocked in `image-titles.json`. Obvious meat-dish and wrong-food matches were removed from the new batches. Search results are unapproved and may still be poor matches; review them individually.

### Step 11. Data debts to clear before go-live
Done: water included in the four recipes, `kheera-raita` override, falafel step wording and slug rename, effective-time tags, make-ahead totals, and reset counts. Fortified milk is resolved; atta and soya chunks remain documented stand-ins, and paneer micronutrients are partial. See `docs/nutrient-targets.md`.

Checked 2026-10-23: `pnpm validate` passes. A Playwright layout smoke check at 375 and 390 px found no horizontal overflow on Today, recipes, recipe detail, cook mode, ingredients, ingredient detail, plan setup, groceries, profiles, settings, credits and photo review. Shared search-clear and clear-filter targets were increased to at least 44 px; the recipe filter panel also fits. This is not a complete populated-plan interaction audit.

Populated-plan follow-up, 2026-10-23: used synthetic profiles and plans in a scratch database to check the ingredient picker, pin sheet, swap picker, populated plan/prep/groceries, Buy/Have panels, profile routines and Today's expanded routine/evidence card at 375 and 390 px. No horizontal overflow was found. Prep completion, pantry labels, routine serving controls and the routine evidence summary now have at least 44 px targets. Swap, Buy/Have choices, prep completion and a routine choice were verified across reloads. These browser checks do not replace the real iPhone upload check.

Still pending:
- Move `water-tap` and `hummus-commercial` from USDA only when matching CNF records can be verified. The food API still returned HTTP 503 on 2026-10-23.
- Measure 150 g dry chickpeas after a 12-hour soak and draining, then correct the falafel yield and portions.
- Supply labels for skyr, ultrafiltered milk and nutritional yeast; find a usable IFCT entry for roasted chana. No values are guessed.
- Iron and zinc multipliers are documented but not applied; direct National Academies report verification remains open.
- Real iPhone photo upload is still unverified.
- Dependabot PRs #1–#4 remain open; they have not been rebased or merged in this pass.

## Group 2: publish and protect (starts after step 10)

### Active work package: step 12, including earlier carry-forward work

**Step 12 is implemented locally**, including the supporting driver handoff from step 13. The Postgres baseline in `8974a0d` is now wired into application queries; the SQLite source and its migration history are preserved, not imported or modified. The detailed execution checkpoints are in `plan-v3-publish-and-protect.md`.

| Order | Work item | Current state / completion check |
|---|---|---|
| 12.1 | Inventory every database caller: actions/routes, query helpers, human modules, seed/renames, reset/backup and scripts | Complete: application consumers use the shared Postgres schema/client; SQLite remains only in legacy source/backup tooling and parity checks. |
| 12.2 | Finish awaited query/mutation boundaries and testable persistence | Complete: queries, plan persistence, swap and supporting helpers await actual async driver operations. |
| 12.3 | Preserve atomic multi-statement writes and human-data sync markers | Complete: awaited commit/rollback tests, per-stage persistence and sync-marker fault injection; concurrent native regenerations serialize on the plan row. |
| 12.4 | Convert transaction internals: `markChanged`, plan setup, seed/renames, feedback/views/links/photos/routines, prep and reset | Complete on Postgres. Seed, renames and the content-version marker now share one transaction, with nested human-writer savepoints. No async SQLite callbacks. |
| 12.5 | Keep image/blob/network operations outside database transactions | Complete: image/blob work stays outside; approval/write failures roll back metadata and clean up synthetic photo bytes in tests. |
| 12.6 | Isolate SQLite-only backup/reset operations and define the Postgres handoff | Complete boundary: legacy SQLite backup requires explicit `DB_PATH` and rejects `DATABASE_URL`; application reset refuses to proceed until step 20 supplies verified Postgres recovery. |
| 12.7 | Regression and completion evidence | Complete locally: PGlite behavior/round-trip tests, native Postgres 17 TCP tests, coverage gate, typecheck/validation/build and synthetic browser checks. Remote workflow verification waits for push; no deployment claim. |

Carry forward earlier unfinished work while completing this package:

| Earlier work | Bring into this pass? | Exact boundary |
|---|---|---|
| Photo decision error/loading feedback, rejection regression and mobile target fixes | Yes: finish saving the already implemented changes as a separate focused commit | Scratch Reject success/failure/retry is verified; the owner's original instance failure is still unexplained, not a confirmed root-cause fix. |
| Expanded unapproved ingredient candidates | Yes: preserve and save the existing validated batch separately from database changes | Never auto-approve. Further fetching is optional and must not hold up step 12 on provider rate limits. |
| Picker/pin/swap and populated-plan phone-width audit | Already performed; carry its regression coverage through changed flows | Do not list this as an unperformed audit. Real-device checks remain distinct. |
| Photo review by the owner and real iPhone upload | Track, do not mark complete | Requires human approval/device access; not a reason to stop safe local async work. |
| CNF water/hummus records, IFCT roasted chana and direct National Academies iron/zinc verification | Separate bounded research when services are available | Preserve current sources/stand-ins; no invented values or automatic multiplier changes. External failures do not block coding. |
| Falafel soak yield; skyr/ultrafiltered milk/nutritional yeast labels | Owner input required | Need a measured drained soak weight and actual product labels. Keep unresolved. |
| Dependabot PRs #1-#4 | Separate maintenance queue, not part of async code | All four are still open as of this review. Inspect compatibility and CI before any merge; do not silently merge while doing step 12. |

**Step-12 exit rule:** do not mark it done merely because public functions return promises or a Postgres schema exists. Every relevant consumer and transaction must be verified against the agreed async contract. Some transaction conversion necessarily crosses the step-12/13 boundary; track that dependency honestly rather than forcing unsafe async SQLite transactions. Human approvals, device checks and unavailable nutrition sources remain explicitly pending under their original steps.

#### Through-step-12 closeout, 2026-10-23

| Item | Verified outcome | Remaining |
|---|---|---|
| Earlier photo/mobile implementation | Saved in `6369e73`: decision failure/loading feedback, per-subject rejection retry test, mobile targets and unapproved ingredient candidates | Owner's original Reject failure still not reproduced; owner approvals and actual iPhone upload |
| Plan persistence | Initial atomicity saved in `15ad10b`, now converted to awaited Postgres operations. Setup, plan, routines, slots and portions commit together; regeneration keeps locks and serializes concurrent replacements; deletion/preferences remain atomic. | Cloud import and cutover are later steps |
| Failure-path tests | 22 persistence cases and 13 human-data fault-injection cases now run on Postgres-compatible fixtures. Added native TCP commit/rollback, pool recovery, concurrent updates/regeneration and reseed/export preservation, plus whole-seed rollback and content-version checks. | Broader action/component automation can continue separately |
| Measured coverage | 42 files / 698 tests, including four native Postgres checks. The plan-persistence helper retains its 100% statements/branches/functions/lines gate. Latest full measured application coverage is about 56.6% statements and 45.8% branches, including untested files. CI uploads reports. | Not 100% app coverage; client/action paths still also rely on browser checks |
| Browser regression | Scratch-data plan creation and regeneration persist across reload at phone width. Ingredient Reject POST returns 200, removes one candidate and stays removed after reload at 375 and 390 px; no overflow found in those checks. An aborted Reject POST displays an error, keeps the queue unchanged and re-enables the button; retry succeeds and survives reload. | Not a root-cause reproduction of the owner's earlier instance |
| Dependabot maintenance | Proposed action versions applied locally: setup-node v7, checkout v7, pnpm setup v6 and gitleaks v3. Verified release manifests use Node 24 on supported hosted runners. PR #4's inspected checks passed; #1-#3 have secret-job HTTP 403 reading PR commits, not evidence of leaked secrets. Local workflow already grants `pull-requests: read`. | No PR was merged or closed. New workflow must be pushed and its actual GitHub checks observed before calling this remotely complete |

The async-driver handoff is now implemented: application `Db`/`Tx` use Postgres, every transaction query and sync marker is awaited, and seed/renames are atomic. Requests perform only a read-only content-version check; they never seed or migrate. Runtime configuration must explicitly identify the matching database environment and reviewed remote host. Existing SQLite files are untouched legacy sources, not a fallback. `scripts/backup.ts` retains explicitly selected SQLite source backup; the application reset gate refuses destructive work until step 20 supplies tested Postgres recovery.

Fresh native-Postgres browser checks at 375/390 px: profile/plan creation, persisted swap and regeneration, grocery/prep ticks, a routine choice, ingredient Reject (119 to 118 across reload), and Excel/PDF exports succeeded. No horizontal overflow was found in these checks. The production build succeeded with an unreachable database URL, proving it no longer requires database access. This is still a local-only development milestone.

Owner/source blockers remain unchanged: photo approvals, iPhone upload, measured falafel soak gain, product labels, verified CNF/IFCT records and direct National Academies source verification. No household data, production database or cloud configuration was modified during this closeout.

| Step | What | Size |
|---|---|---|
| 12 | Finish async conversion (13) — implemented and verified locally | M |
| 13 | Postgres schema, pool and native tests implemented; remaining household/login schema accompanies identity. Seed is an explicit release operation, never build-time (14) | L |
| 14 | Implemented: isolated schema-only Neon dev branch, live production guard, verified SQLite importer and two synthetic cloud rehearsals; retained Playwright cases (15) | M |
| 15 | Better Auth: sign-in with password or emailed code, invitations, bootstrap claim of your existing profile, rate limits, `proxy.ts` (16) | L |
| 16 | Authorisation on every action and route, the open plan export closed, push subscriptions bound to the login, service worker stops caching personal pages, security headers (17) | M |
| 17 | Household and account screens: invite by email, roles, profile "Login" section, account page, delete and export (18) | M |
| 18 | Photos on the Neon bucket with signed links (19) | S/M |
| 19 | Nightly export of ratings, links, photos, saved views and routine choices to a private state repo through a GitHub App; "Sync now" and status in Settings (20) | M |
| 20 | Encrypted nightly backup of profiles and plans to a private vault repo, reset backup on Postgres, restore command and test, runbook (21) | M |
| 21 | Go-live on Vercel: Neon integration, environment variables, reminder scheduler, domain, email DNS, final data move, cutover (22) | M |

Group 2 totals about 95 hours. Owner decisions are listed in `plan-v3-publish-and-protect.md` (14 items, each with a recommendation).

Step 12 completion, 2026-10-23: the awaited driver/transaction port and local acceptance checks are complete. See the work package and closeout above. This does not complete cloud import, identity, recovery or deployment.

Deployment visibility, 2026-10-23: GitHub Actions already exists, and the latest inspected main run passed `ci` and `secrets`. The current local workflow changes enable all-branch pushes and manual runs, isolate build data in the runner's temporary directory, and upload JUnit test results. Uncommitted or unpushed work does not appear in Actions; the new triggers are not live until pushed. Neon/Postgres application integration and Vercel deployment are still pending, not background jobs. The publish-and-protect document now distinguishes completed foundations from these remaining deployment gates.

Postgres foundations, 2026-10-23: added a parallel Postgres schema and generated baseline for all 33 current application tables, with JSONB, booleans, double-precision nutrition/quantity values, dates, UTC ISO timestamp mapping and explicit foreign-key deletion rules. Schema parity tests cover row types, columns, keys, indexes and foreign keys; PGlite runs the migration and exercises constraints, async commit/rollback and deletion behavior. The node-postgres pool has bounded connections and Vercel lifecycle attachment. A guarded `db:migrate:postgres` command accepts only explicitly configured dev/test direct endpoints, with no application-URL fallback or automatic local configuration loading. Its remote-host allowlist requires operator verification of the branch; it does not discover the branch from Neon. No remote migration was run.

Step 14 importer: the read-only SQLite importer covers all 33 legacy tables, checks schema/integrity/references, preserves ids and human metadata, verifies canonical counts/checksums before commit and transactionally restarts identities. It requires an empty dev/test destination; remote synthetic rehearsals additionally require `SQLITE_IMPORT_NEON_BRANCH_ID` matching the live-verified development branch. Synthetic PGlite and native Postgres tests cover rollback/retry, competing imports and preservation through an explicit seed. Photo bytes and household data were not transferred. The importer leaves the library version unset until a guarded seed.

Step 14 safety guard: remote non-production runtime/migration/seed now require live read-only Neon API verification of explicit branch/project ids and the direct/pooler host's read-write endpoint. Production ids, default/primary/protected branches and invalid/unavailable metadata are refused before opening a pool. Startup is asynchronous, shares concurrent verification and retries after failure; the successful check lasts for that process's pool lifetime. A metadata-only `db:verify:postgres runtime|migration` command is available; no credential files are changed.

Step 14 completed, 2026-10-24 after explicit cloud approval: created schema-only `dev-step14-rehearsal` (`br-odd-flower-b43d2ryu`, expires 2026-10-31 04:30 UTC), not a production-data clone. Two fresh Neon databases matched all 33 table checksums; all 17 identities and unchanged human exports through seed were verified. Direct migrations and pooled runtime passed live verification. Private phone-width Playwright checks confirmed plan creation, persisted swap, locked regeneration, grocery/prep completion, Reject success/failure/retry and real XLSX/PDF downloads. A second import into populated Neon and production selection were refused; source bytes stayed unchanged.

Retained browser acceptance: five executable Playwright cases pass in about 17 seconds after local server startup, using a separate guarded loopback-only `protein_kitchen_e2e` database. The CI `browser` job uses disposable Postgres/Chromium, never Neon credentials. The full unit/native suite passes 805 tests with coverage gates; build/typecheck pass. Current workflow changes remain unobserved remotely until push. Existing `.env.local` and `.neon` were not rewritten; synthetic cloud URLs and a project-scoped rehearsal key remain private session artifacts. The app has not been publicly deployed and remains unauthenticated.

Next is step 15 with the remaining auth/household schema from step 13, followed by authorization/account work in steps 16-17. The detailed stage plan now explicitly includes invite-only signup, bootstrap, verification/recovery, onboarding/profile creation/linking and two cooks sharing one plan/list with individual targets and portions. Each stage needs unit/integration coverage, actual Playwright verification and retained executable browser cases before closeout.

## Things only you can provide later
A Resend account and sending domain, a domain for the app, the Neon and GitHub plan choices, a GitHub App created in your account (steps will be given), and an offline copy of the backup decryption key.

## Rules that stay true for every step
Follow CLAUDE.md. Macros live only on ingredients. Every new recipe is a draft; only you set tested, rating, favourite and banned. No supplement doses anywhere. Never print or commit anything from `.env.local`. Never develop against the Neon `production` branch.
