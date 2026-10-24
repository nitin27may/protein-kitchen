# Roadmap: step by step, in order

Last updated 2026-10-23 (steps 10 and 11 built; see docs/plan-step-10-11.md). This merges `plan-v2-experience.md` (UI and data) and `plan-v3-publish-and-protect.md` (database, login, backup, go-live) into one ordered list. Work top to bottom; a step starts only when the ones it depends on are done and verified.

Each step ends with the same checks: `pnpm typecheck`, `pnpm test`, `pnpm validate`, `pnpm build` all pass, the screen is looked at in a browser (desktop and phone width), then one commit pushed to `main` on GitHub.

## Status

| Step | What | State |
|---|---|---|
| 11 | Data debts: water in four recipes, kheera-raita override, falafel step wording, effective time in tags, make-ahead total in the plan review, reset counts, phone-width audit, nutrition source review. Open: falafel soaked weight (needs your measurement), four unsourced foods, CNF values when the service returns | Done except those |
| 10 | Photos: your own uploads, reviewed candidates from Commons and Openverse, aisle tiles, collage only with 3+ photos, BlobStore, exporters, backup of uploads. Open: you review the candidates; real-iPhone upload check | Built |
| A | Design system, ingredients library and photos, Settings reset, plan creation redesign, page redesigns | Done |
| 0a | Private GitHub repo `nitin27may/protein-kitchen`, `.gitignore` fixed, secret scan | Done |
| 1 | Night-before prep tasks unified (Today, prep guide, 21:00 reminder) | Done |
| 2 | Filters: toolbar, drawer, URL state, saved default, Recipes and Ingredients | Done |
| 3 | Filters on picker, pin sheet, swap sheet, groceries | Done (picker and sheets not yet seen on screen) |
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

### Step 10. Photos you take or approve (11 and 12)
Scope: upload a photo on any recipe or when ticking "Cooked and tested"; resize on the phone, convert to WebP and strip location data on the server; stored through a storage interface (local folder now, Neon bucket later). A review page lists candidate photos from Wikimedia Commons and Openverse with source, licence and author, and nothing shows until you approve it. Ingredients without a photo get an aisle tile with an icon; recipe collages only when there are three or more ingredient photos.
Decision: your own photos first, no Unsplash, no AI-generated recipe images.

### Step 11. Data debts to clear before go-live
- Move `water-tap` and `hummus-commercial` from USDA to CNF values when the service is back.
- Falafel mix counts chickpeas at dry weight although they are soaked: measure a soaked weight, then correct portions.
- Four recipes still say "water is not counted": `besan-oat-muffins`, `spinach-cottage-cheese-bake`, `cottage-oat-pancakes`, `spiced-protein-chaas`.
- Eight unresolved nutrition sources (paneer, soya chunks, ultrafiltered milk, skyr, roasted chana, nutritional yeast, whole wheat atta, fortified milk) and the vegetarian iron and zinc multipliers.
- `kheera-raita` kcal warning (add an override).
- Phone-width check of every screen, the ingredient picker, pin sheet and swap sheet, and the sidebar icons.

## Group 2: publish and protect (starts after step 10)

| Step | What | Size |
|---|---|---|
| 12 | Finish async conversion (13) | M |
| 13 | Postgres schema in one baseline (every table including routines, links, photos, saved views, household, login), connection pool, fast real-Postgres tests, build-time seed (14) | L |
| 14 | Safe `dev` branch on Neon, startup guard against `production`, SQLite import script with counts and checksums, rehearsal (15) | M |
| 15 | Better Auth: sign-in with password or emailed code, invitations, bootstrap claim of your existing profile, rate limits, `proxy.ts` (16) | L |
| 16 | Authorisation on every action and route, the open plan export closed, push subscriptions bound to the login, service worker stops caching personal pages, security headers (17) | M |
| 17 | Household and account screens: invite by email, roles, profile "Login" section, account page, delete and export (18) | M |
| 18 | Photos on the Neon bucket with signed links (19) | S/M |
| 19 | Nightly export of ratings, links, photos, saved views and routine choices to a private state repo through a GitHub App; "Sync now" and status in Settings (20) | M |
| 20 | Encrypted nightly backup of profiles and plans to a private vault repo, reset backup on Postgres, restore command and test, runbook (21) | M |
| 21 | Go-live on Vercel: Neon integration, environment variables, reminder scheduler, domain, email DNS, final data move, cutover (22) | M |

Group 2 totals about 95 hours. Owner decisions are listed in `plan-v3-publish-and-protect.md` (14 items, each with a recommendation).

## Things only you can provide later
A Resend account and sending domain, a domain for the app, the Neon and GitHub plan choices, a GitHub App created in your account (steps will be given), and an offline copy of the backup decryption key.

## Rules that stay true for every step
Follow CLAUDE.md. Macros live only on ingredients. Every new recipe is a draft; only you set tested, rating, favourite and banned. No supplement doses anywhere. Never print or commit anything from `.env.local`. Never develop against the Neon `production` branch.
