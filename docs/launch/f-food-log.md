# F: household food list and food log

Part of the post-launch work after `docs/plan-v3-publish-and-protect.md`. Stage record required by CLAUDE.md. Kept in its own file so parallel PRs do not conflict.

## Goal

The owner adds any packaged food or ingredient to the household master list from its nutrition label, then logs what each person ate. The library stays source-backed (CNF, USDA, IFCT). A household food is the household's own record, typed or read from a label, and is labelled as such everywhere.

## Scope

In:

- A household food: name, brand, optional barcode, nutrition per 100 g (stored), serving size and countable piece weight for display, optional per-100 ml basis with a density, ingredients text, diet flags (`is_dairy`, `contains_onion_garlic`), source `LABEL` (or `OFF` after F6).
- A food log: entries per person per day. Kinds: `planned` (ate the plan), `skipped`, `swap` (ate something else instead of a planned meal), `extra` (ate something not in the plan).
- Today shows eaten, planned-but-not-confirmed, and "not logged" for past days with no entries.

Out (post-launch list below): saved meals, merge, member-created foods, grocery and pantry links, generator use.

## Golden rules carried over

1. Macros live only on foods (library ingredients and household foods). A log entry stores a food key and grams, never macros.
2. Grams are the only stored unit. A label per serving or per 100 ml is converted once, on entry (`per100 = value / serving_g * 100`). The friendly quantity and unit (`2 servings`, `3 pieces`) are kept on the entry for display.
3. Missing is not zero. A value the label does not report stays `undefined` and displays "not reported". Fibre totals read "at least" with a count of items that did not report it.
4. Honest labels. A household food never shows as library data. Nothing is estimated silently: a density from "1 ml = 1 g" is flagged estimated and every figure derived from it says so.
5. Diet screen flags, never blocks. The household decides.

## Dependencies

- Reuses `lib/nutrition/macros.ts` (`atwaterKcal`, `kcalDeviationOk`), and the `missingFrom` idea from `lib/nutrition/micros.ts`.
- F2 owns the tables, Zod schemas (`lib/schemas/food.ts`) and the `lib/human/` writers and exporters. F1 does not import them; every pure function takes its own small input types.
- Household foods and log entries are human-owned data (CLAUDE.md "Human-owned data"): database only, written only through `lib/human/`, each with `uid`, `created_at`, `updated_at`, nullable `created_by_person_id`, a `registerExporter` line and a round-trip test.

## Permission boundaries

| Actor | Foods | Log |
| --- | --- | --- |
| Household owner | Create, edit, archive household foods | Log for anyone in the household |
| Household member | Read | Log only for themselves |
| Another household | No access | No access |
| Anonymous | No access (no route, no action) | No access |

- Every query and action is scoped by the signed-in household id. Households are isolated: a food key `hf:<uid>` from another household resolves to nothing.
- Server actions check the session and role before any database access (the access inventory test requires the check first).
- The pure modules in `lib/foods/` import nothing from `lib/server`, `lib/db`, `lib/auth`, `lib/human`, `lib/blob` or `next/*`, and a test enforces it.

## Packages

| Package | Content | Status |
| --- | --- | --- |
| F0 | This stage record | This PR |
| F1 | Pure core: units, label validation, diet screen, daily totals, catalog, GTIN, dedupe. 100% per-file coverage | This PR |
| F2 | Schema and migration, Zod schemas, human writers, exporters, round-trip tests | Parallel |
| F3 | Foods UI (add from label, edit, list), logging UI, Today changes | Next |
| F4 | Label photo: capture and keep the photo of the pack as evidence (human-owned blob) | Later |
| F5 | Vision extraction of the label. Needs `ANTHROPIC_API_KEY`, behind `LABEL_SCAN_ENABLED` (off by default, fails closed), per-household cap. Output fills the form; the same validation and the same "I checked this against the label" confirmation apply | Later |
| F6 | Barcode scan and Open Food Facts lookup. Open Food Facts data is ODbL: credit on `/credits`, share-alike noted, source `OFF` | Later |
| F7 | Plan review: planned versus eaten over a week | Later |

## Behaviour (F1)

### Units (`lib/foods/units.ts`)

- Normalise `g`, `mg`, `µg` (also `μg`, `mcg`, `ug`), `kcal`, `kJ`, `ml`. Energy kJ to kcal divides by 4.184.
- Per serving to per 100 g: refused when the serving size is missing or not positive.
- Per 100 ml needs a density (g per ml): from the pack (net weight and volume), a weighed serving, or an explicit "treat 1 ml as 1 g" that sets `estimated`.
- Logged amount to grams from grams, servings, pieces or ml; refused when the food lacks the needed serving, piece weight or density.

### Label validation (`lib/foods/validate.ts`)

Errors (block saving): negative or non-numeric values; protein, carbohydrate or fat above 100 g per 100 g; the three summing above 105 g per 100 g; more than 950 kcal per 100 g; serving size outside 1 to 1000 g or ml; per-serving values without a serving size; protein per serving larger than the serving.

Warnings (saving needs the confirmation "I checked this against the label"):

- Energy does not match the macros (15 percent or 8 kcal, the library rule); sugar alcohols can explain a gap.
- Energy about 4.2 times the macro estimate: "Looks like kJ, not kcal".
- Energy a whole multiple (2 to 12) of the estimate: "Looks like per pack, not per serving".
- Sodium of 5 g or more entered in g, or more than 5000 mg: "Check mg against g".
- Fibre above carbohydrate.
- kcal per 100 g outside the usual range for the aisle.

### Diet screen (`lib/foods/diet-screen.ts`)

English and French, case and accent folded, whole words. Flags egg, gelatin, animal rennet or enzymes, meat, fish, and uncertain sources (L-cysteine, carmine, cochineal, shellac). Suggests `is_dairy` and `contains_onion_garlic`. "May contain" and facility statements become a note. Non-animal wording (microbial rennet, coconut milk, cocoa butter, "egg-free") is not flagged.

### Totals (`lib/foods/totals.ts`)

- Eaten = sum of the day's entries. Planned meals with no entry are "planned, not confirmed", never counted as eaten.
- A past day with no entries is `not_logged`, with no eaten figure.
- `markRestAsEaten` returns `planned` entry drafts for unanswered planned meals; skipped and swapped meals are left alone.

### Catalog (`lib/foods/catalog.ts`)

- Library ingredients keep their slug as key; household foods are `hf:<uid>`. The colon means a household key can never equal a kebab-case slug.
- Search by name, brand, alias and exact barcode. Recently and frequently logged foods come first within the same relevance.
- GTIN check digit for 8, 12, 13 and 14 digits. Barcodes compare in GTIN-14 form, so UPC-A and EAN-13 of one product match.
- Dedupe: same barcode is the same product; a near match on normalised name and brand is a warning.

## Acceptance cases

1. Costco pancake mix: label per 1/3 cup = 55 g converted to per 100 g, logged at 110 g (2 servings), gives twice the per-serving figures.
2. A drink per 100 ml with a pack density converts to per 100 g; with the 1 ml = 1 g estimate it is flagged estimated.
3. Energy typed as kJ in the kcal field, or per pack instead of per serving, raises the matching warning and needs the confirmation to save.
4. Sodium 380 typed as g raises "Check mg against g".
5. A pancake mix ingredients list containing egg powder flags egg; "may contain egg" does not.
6. Fibre not reported on one of three items: day fibre reads "at least" with a count of 1.
7. Yesterday with no entries is "not logged", not zero.
8. A scanned or typed barcode that already exists finds the existing food; a near-duplicate name and brand warns.
9. A member cannot log for another member; another household's food key resolves to nothing; an anonymous request is refused (F3, with the actions).

Unit tests: `tests/foods-*.test.ts`. Per-file 100% gates in `vitest.config.ts` for all five `lib/foods` modules. Browser flows are verified with Playwright in F3.

## Gotchas

- Label carbohydrate usually includes fibre (CNF convention). Some labels list fibre separately; hence the fibre-above-carbs confirmation rather than an error.
- Atwater estimates drift for polyol-sweetened products; that is why an energy mismatch is a warning.
- A `hf:` key must never be written to a slug column; keep the two key spaces distinct in F2.
- US labels list "Calories"; the unit normaliser treats `cal` and `calories` as kcal. Canadian labels may print kJ first.

## Post-launch

Saved meals (a named set of foods and amounts), merge of duplicate household foods, member-created foods (owner approves), grocery and pantry links, generator use of household foods, and promoting `LABEL` foods to the library through an agent pull request with source `LABEL` and a human review of the figures.
