# CLAUDE.md — Protein Kitchen

Personal meal planner for a lacto-vegetarian household (dairy yes, eggs no). Read `PLAN.md` for product intent. This file is the rulebook for working in this repo, especially for **adding data**.

## Commands

```
pnpm dev        # Next.js dev server (explicit isolated DATABASE_URL/DATABASE_ENV, APP_TZ for time zone)
pnpm build      # production build
pnpm typecheck  # tsc --noEmit
pnpm validate   # validate all /data files, compute macros, print report
pnpm seed       # guarded dev/test Postgres library seed (DATABASE_URL_UNPOOLED; validates first)
pnpm test       # Vitest: nutrition maths, conversions, generator
pnpm test:e2e   # saved Playwright cases; explicit disposable loopback POSTGRES_E2E_URL
pnpm backup     # legacy SQLite only: explicit DB_PATH, DATABASE_URL must be unset
pnpm db:migrate:postgres  # explicit direct dev/test connection; never runs at request/build time
pnpm db:verify:postgres runtime  # metadata-only configuration/branch preflight; also accepts migration
pnpm db:import:sqlite /absolute/path/to/source-copy.db  # verified legacy import into an empty dev/test target
```

Database tests use disposable PGlite fixtures. Native TCP tests additionally require `POSTGRES_TEST_URL` pointing to a loopback-only `protein_kitchen_test` database. Existing SQLite files are import/rollback sources, never the application fallback. Settings reset stays blocked until Postgres backup/restore is verified.

Remote non-production runtime/migration/seed must pass live Neon project/branch/endpoint verification before opening a pool; an asserted host alone is insufficient. Supply explicit `NEON_PROJECT_ID`, `NEON_DEVELOPMENT_BRANCH_ID`, `NEON_PRODUCTION_BRANCH_ID` and a server-only `NEON_API_KEY`. Local loopback tests need none of these. No credential files are automatically loaded or rewritten by CLI commands. See README for the gate and import rehearsal procedure.

Before each development stage, detail the scope, dependencies, permission boundaries and acceptance cases in `docs/plan-v3-publish-and-protect.md`. Add feature-level coverage, verify the actual browser flow with Playwright, and retain executable browser cases for targeted reruns. Browser setup may clear only the explicitly selected loopback `protein_kitchen_e2e` database; never use the cloud branch or household source as its fixture. Remote synthetic import additionally needs `SQLITE_IMPORT_NEON_BRANCH_ID` matching the verified development branch.

## Golden rules for data

1. **Macros live only on ingredients.** Never put protein/kcal/carbs/fat on a recipe or component. They are computed.
2. **Every ingredient has a nutrition source.** Use Canadian Nutrient File (CNF) first, USDA FoodData Central second, and IFCT 2017 (India's National Institute of Nutrition) for Indian foods the first two lack (ragi, paneer, chana dal, curry leaves, jaggery and similar). Record `source` and `source_id`. Never estimate macros from memory. If you cannot find a source, stop and list the item as unresolved.
3. **State is mandatory**: `dry`, `cooked`, `raw`, or `ready`. Dry legumes/grains need `cooked_yield`. Recipes should reference the state actually weighed (usually dry for dal/rajma soaked at home, cooked for canned/boxed).
4. **All quantities in grams** (`grams`). Friendly units (`display_qty`, `display_unit`) are optional for display only.
5. **Celsius only.** Oven temperatures for conventional ovens; note convection/air-fryer adjustments via technique cards.
6. **New recipes are `status: "draft"`.** Only the humans set `tested`, `rating`, `favourite`, `banned`. Never change those fields.
7. **Evidence grades are honest.** Habits use `strong | moderate | weak | myth | practical`. Do not upgrade a traditional practice to `moderate` without a human study cited in `source_url`. No supplement doses anywhere in the data.
8. **Respect diet flags.** No meat, fish, eggs, gelatin, or animal rennet. Set `contains_onion_garlic` and `is_dairy` correctly on ingredients.
9. Prefer recipes with `active_min ≤ 20`. Global (non-Indian) recipes must link the technique cards a first-timer needs.
10. Run `pnpm validate` after every data change and fix every error before finishing.
11. **Health labels are computed, never hand-written.** Low sugar, light and nutrient-dense come from `lib/nutrition/quality.ts` (see `docs/healthy-criteria.md`). New recipes should not sweeten with sugar, honey, jaggery or dates unless the recipe is meant to be a treat, and should say so.

## File formats

### Ingredient — `data/ingredients/<aisle>.json` (array)

```json
{
  "slug": "kidney-beans-dry",
  "name": "Kidney beans (rajma), dry",
  "aliases": ["rajma", "red kidney beans"],
  "state": "dry",
  "cooked_yield": 2.4,
  "per100g": { "kcal": 333, "protein_g": 23.6, "carbs_g": 60.0, "fat_g": 0.8, "fibre_g": 15.2 },
  "source": "CNF",
  "source_id": "<id>",
  "aisle": "legumes",
  "pack_size_g": 900,
  "where_to_buy": ["Indian grocer", "No Frills"],
  "is_pantry_staple": false,
  "contains_onion_garlic": false,
  "is_dairy": false
}
```
(Numbers above are illustrative — always pull real values from the source.)

### Recipe or component — `data/recipes/<family>/<slug>.json` or `data/components/<family>/<slug>.json`

```json
{
  "slug": "tofu-burrito-bowl",
  "name": "Tofu burrito bowl",
  "kind": "recipe",
  "family": "bowls",
  "meal_slots": ["lunch", "dinner"],
  "cuisine": "mexican",
  "is_indian": false,
  "servings": 2,
  "prep_min": 10, "active_min": 20, "total_min": 30,
  "equipment": ["oven"],
  "tags": ["batch-friendly"],
  "fridge_days": 4,
  "status": "draft",
  "items": [
    { "ingredient": "tofu-extra-firm", "grams": 350, "display_qty": 1, "display_unit": "block" },
    { "ingredient": "black-beans-cooked", "grams": 240 },
    { "component": "chipotle-yogurt-sauce", "grams": 120 },
    { "component": "cilantro-lime-rice", "grams": 300 }
  ],
  "advance_prep": [
    { "kind": "marinate", "ingredient": "tofu-extra-firm", "lead_hours": 2, "instruction": "Cube and marinate tofu" }
  ],
  "steps": [
    { "text": "Press the tofu if it is not super-firm.", "technique": "press-tofu" },
    { "text": "Roast tofu at 210°C for 25 minutes, flipping halfway.", "technique": "oven-basics", "timer_sec": 1500,
      "cue": "Edges are golden and the cubes feel firm.", "tip": "Do not crowd the tray." },
    { "text": "Assemble: rice, beans, tofu, veg, sauce." }
  ]
}
```
Every cooking step gets a `cue` (how you know it is done: colour, texture, sound, temperature) and, where mistakes are common, a `tip`. `pnpm validate` reports how many cooking steps have a cue. An optional `serving_unit` (`{singular, plural, per_serving}`) makes a countable serving readable, such as 2 rotis; without it the UI shows approximate grams. An optional `storage` string overrides the default storage and reheating advice built from `fridge_days`. Components use `"kind": "component"` and can be referenced by recipes. Components may reference other components (no cycles — validator checks).

### Components (parts of meals)
A meal made of several things (a falafel bowl is falafel, hummus and a dressing) keeps each thing as its own component, so each has its own method, cues, fridge life and, later, links and videos. A recipe points at a part with `{ "component": "hummus", "grams": 60 }`.

- **Where they live:** meals in `data/recipes/<family>/`, components in `data/components/<family>/`. A component in the recipes folder, or a recipe in the components folder, is a validator error. The folder name is the `family`.
- **Slugs** name the thing you make, with no prefix: `hummus`, not `component-hummus`. **Variants** use a suffix: `hummus-beetroot`. No version numbers; git keeps history.
- **Store-bought versions are ingredients, never components.** `hummus-commercial` is an ingredient with a CNF or USDA source. A recipe can offer it as the "buy" option with `"alt_ingredient": "hummus-commercial"` on the component item (the ingredient must exist and be `ready`).
- **A component is never also a recipe.** To eat hummus as a snack, write a recipe that wraps it (`hummus-veg-cup`).
- **Display names read like a menu:** "Hummus", "Lemon tahini dressing", "Baked falafel". No "Homemade" or "mix".
- **A component is justified** if two or more recipes use it, or it has its own method (two or more steps) and keeps two days or more, or some recipe lists a buy alternative for it. Otherwise fold it into its recipe.
- **List every gram.** A component's yield is the sum of its item weights, so water goes in as `water-tap` in grams. "Water is not counted" is a bug: it makes the yield too small and every portion's macros too high.
- **Every component step needs a `cue`.** Nobody sees a part in the flow of a meal, so each step carries its own "done when".
- **Time:** a recipe's `active_min` and `total_min` cover only its own steps. The validator computes the effective hands-on time on the day (own time plus parts that keep fewer than 2 days) and the make-ahead time (parts that keep 2 days or more). Do not write the parts' minutes into the meal.
- **The meal's steps point at the part,** they do not repeat its method. The validator warns when a step repeats a step of one of its parts.
- **Optional on a component item:** `display_qty` and `display_unit` ("8 patties"), `label` ("Dip"). Display only.
- **Links** (recipe pages, videos) for a recipe or a part are human-owned and live in the database, not in these files.

### Human-owned data
Some data belongs to the people using the app, not to the library. Ratings, favourites, banned and tested flags, recipe notes, recipe links, uploaded photos and photo approvals, saved views and routine choices are **human-owned**.

- They live in the database, never in `/data`.
- They are written only through `lib/human/` (one module per data class, each marking the class changed in `sync_state` in the same transaction). Do not write these tables from actions, pages or scripts.
- The agent never writes them, including when they are exported to a state repo. Export files are keyed by slug and uid, never by database id.
- A new human-owned table gets a `uid`, `created_at`, `updated_at` and a nullable `created_by_person_id`, and one `registerExporter` line plus a round-trip test (export, import into a fresh database, export again, identical bytes).
- Renaming a recipe or component slug needs an entry in `data/renames.json` (`{ "old-slug": "new-slug" }`, no chains), so ratings, links and photos follow it. The seed applies it.
- Resetting data in Settings clears these tables; reseeding never does.
- **Routine choices** (`person_routines`) are exported as `routines/<personKey>.json`, one file per person. People have no uid, so the file is named by `personKey(name, birthDate)`: `p-` plus the first 16 hex characters of sha256 of the lower-cased name, a bar and the birth date. The key hides the birth date, survives a restore into different ids, and changes only if the name or birth date is edited. Import matches people by this key and skips a person it cannot find.

### Routines — `data/routines/<slug>.json`
A routine is a small thing eaten or drunk on a schedule, such as methi water or soaked almonds. It is a recipe with `"kind": "routine"` in `data/routines/` (flat folder, `"family": "routines"`, `"meal_slots": []`, `"servings": 1`). It is never planned as a meal, never shown as a part, and hidden from the Recipes list. A person chooses it (days, time of day, servings); a plan copies the choice when it is made, and the plan's groceries and night-before prep follow from that copy.

- **One habit per routine.** The routine is linked from exactly one habit in `data/habits.json` through `"routine": { "recipe": "<routine slug>", "time_of_day": "waking|morning|breakfast|evening|bedtime", "default_days": [1..7] }` (1 = Monday). The habit carries the evidence grade, note, source and caution; category `routine_drink` for new drinks. Never delete or rename a habit slug: `habit_log` rows point at it.
- **No doses.** The habit's title, note and caution name no amount or household measure (no mg, g, ml, tsp, tbsp, cup). Steps never use a volume unit: say "a glass of water". Grams live only on the routine recipe's items.
- **Culinary amounts only.** A seed, spice or nut item in a routine is capped at 6 g per serving unless `data/validation-overrides.json` raises it for that ingredient under `routine_item_max_g.items` (almonds 15 g, chia 12 g). Raise a cap only for a food, never for a dose.
- **Honest grades.** A traditional practice is `weak` or `practical` unless a human study or health authority is cited in `source_url`. Fenugreek and anything blended with it carry the fenugreek caution: not safe in pregnancy above food amounts, can lower blood sugar (ask a doctor first if on diabetes medicine or any regular medicine), can cause allergic reactions and stomach upset. Chia is always soaked or in liquid. Almonds carry the tree-nut allergy caution.
- **Every step has a cue.** A routine that soaks has a `soak` entry in `advance_prep`; a soak of 4 hours or more becomes a night-before task the evening before each scheduled morning (a shorter soak, such as chia's 15 minutes, is a morning step).
- **To add one:** add the ingredients if needed (with a source), write `data/routines/<slug>.json`, add or extend the habit with its `routine` block, run `pnpm validate`. The validator rejects a routine with no habit, a habit pointing at a missing routine, two habits for one routine, an amount in the habit text, a seed over its cap, a volume unit, a missing cue, and a soak with no `advance_prep`.
- **Ajwain** is a labelled caraway stand-in until a verifiable IFCT or USDA entry for Trachyspermum ammi is found.

### Photos
Photos are human-owned. Nothing from the library or the internet shows until a person has approved it.

- **Your own photo:** uploaded on the recipe page (or after ticking "Cooked and tested"). The phone resizes it; the server re-encodes to WebP at 2048 px and a 640 px thumbnail, applying the orientation and dropping all metadata (EXIF, GPS). No raw original is kept.
- **Candidates:** `pnpm photos:candidates` writes `data/photo-candidates.json` (up to 6 per recipe and ingredient from Wikimedia Commons and Openverse, CC0, CC BY and CC BY-SA only, with author, licence and source). The agent may refresh this file; it never approves a candidate. A person approves or rejects each one at `/photos/review`; approving downloads it from an allowlisted host (`lib/photos/remote.ts`), rechecks the licence and credits it on `/credits`.
- **No Unsplash, no AI-generated recipe images.** `data/image-titles.json` maps a slug to the Wikipedia article whose lead image is its first candidate (`null` blocks a subject).
- **Storage:** rows in `photos` and `photo_decisions` (written only through `lib/human/photos.ts`); bytes in a `BlobStore` (`lib/blob`, `uploads/` or `UPLOADS_DIR`), keys derived from the photo's uid. `pnpm backup` copies `uploads/` beside the database; `pnpm photos:check` finds orphan and missing files. Only "Everything" in Settings deletes photos.
- **Display rule:** a recipe shows its cover photo; otherwise a collage of its ingredients' photos only when there are 3 or more; otherwise a plain card. An ingredient without a photo shows an aisle-tinted tile with an icon.

### Technique — `data/techniques/<slug>.md`
Front-matter `title`, `tags`. Body: why it matters, steps, common mistakes, 150–400 words.

### Habit — `data/habits.json` (array)

```json
{
  "slug": "ground-flax-daily",
  "title": "1 tbsp ground flaxseed",
  "category": "daily_basic",
  "evidence_grade": "strong",
  "evidence_note": "Reliable plant source of ALA omega-3 and fibre; whole seeds pass through undigested.",
  "source_url": "<health authority or review>",
  "caution": null,
  "default_on": true
}
```

## Auto-tags the validator applies (don't hand-write these)
- `high-protein`: mains ≥ 25 g protein/serving, breakfasts ≥ 20 g, snacks ≥ 12 g
- `quick`: active_min ≤ 15
- `protein-dense`: ≥ 8 g protein per 100 kcal
- `high-fibre`: ≥ 8 g fibre/serving

## Workflows

**Add ingredients**: research CNF → USDA, write to the right aisle file, include aliases in Hindi/Punjabi where common, run validate.

**Add recipes** (e.g. "add 10 quick high-protein Mexican bowls"):
1. Check existing recipes to avoid duplicates (`ls data/recipes/bowls` or query `recipes`).
2. Reuse components where possible; a new component must meet the rules under "Components (parts of meals)" above.
3. Add missing ingredients first (with sources).
4. Write recipes as drafts, link techniques, add `advance_prep` for anything soaked, sprouted, marinated or set overnight.
5. Run validate; report each recipe's protein/serving and protein per 100 kcal in a table.

**Audit macros**: run validate, list recipes whose computed protein disagrees with their tags or whose kcal/serving looks implausible (< 150 or > 900 for meals, < 50 for snacks), and propose fixes — don't apply silently.

## Code conventions
- TypeScript strict. Zod schemas in `lib/schemas` are shared by scripts and UI.
- Nutrition, conversion and generator logic are pure functions with Vitest tests.
- Server Actions for mutations; no separate API layer unless needed.
- Mobile-first UI; tap targets ≥ 44 px.
- Never commit `db/app.db` or `backups/`.
