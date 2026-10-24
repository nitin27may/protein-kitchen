# Protein Kitchen

A personal meal planner for a lacto-vegetarian household (dairy yes, eggs no, no animal rennet). It builds 7-day, 14-day or custom-range plans with per-person portions, a grocery list, a meal prep guide, step-by-step cook mode and push reminders. Runs locally on Next.js and SQLite.

`PLAN.md` holds the product intent. `CLAUDE.md` is the rulebook for adding data.

## Quick start

Requires Node 22 or later and pnpm 10 (`corepack enable` picks the pinned version).

```bash
pnpm install
cp .env.example .env.local     # optional, only needed for reminders
pnpm dev                    # http://localhost:3000
```

The database (`db/app.db`) is created and seeded from `/data` on first run. Re-seed after editing data with `pnpm seed`.

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
| `pnpm seed` | Validate, then upsert `/data` into the database |
| `pnpm test` | Vitest (nutrition maths, planner, prep, reminders) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm backup` | `VACUUM INTO backups/app-<timestamp>.db` |
| `pnpm db:generate` | Generate a Drizzle migration after a schema change |

## Configuration

Set in `.env.local` (git-ignored). Never commit it.

| Variable | Purpose |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web push keys. Generate with `pnpm dlx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | A `mailto:` contact you own. The example value is a placeholder, change it |
| `APP_TZ` | Time zone for plans and reminders. Default `America/Toronto` |
| `DB_PATH` | Database location. Use a scratch path for experiments |

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
db/           SQLite file and Drizzle migrations
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
