# F2: household foods and food log, schema and data layer

Stage record required by CLAUDE.md. Part of the launch work in `docs/plan-v3-publish-and-protect.md`; this file holds the detail so that plan is not extended.

## Why

The owner adds any packaged food to the household master list from its label and logs what was eaten. F2 is the data layer only: tables, writers, exporters and every reset, deletion and export path. No UI, no route, no server action, no model call. F1 writes the pure logic under `lib/foods/`; the UI package calls the writers listed below.

## Scope

- Migration `0023_food_master_list.sql` (expand only, no `-- contract-ok`): `household_foods`, `food_log`, `label_extractions`.
- `lib/schemas/food.ts`: structural Zod input schemas. Nutrition rules (label arithmetic, serving consistency, diet flags) belong to `lib/foods/validate.ts`.
- `lib/human/household-foods.ts` and `lib/human/food-log.ts`: the only writers of the two human-owned tables (static test `tests/food-writers.test.ts`). `lib/server/label-extractions.ts` owns the operational table.
- Exporter classes `food-catalog` (`household-foods/<uid>.json`) and `food-log` (`food-log/<personKey>/<yyyy-mm>.json`), both household scoped.
- Integration: household reset scopes and counts, household deletion, member account deletion, personal export, legacy-bundle exclusions, `photos:check`, recipe rename hooks, deployment row counts.

## Data rules built in

- **No macros on a log entry.** An entry stores a recipe and servings, a library ingredient and grams, or a household food and grams. A check constraint allows exactly one of the three, with the matching amount and none of the others' columns. Nutrition is computed at read time (golden rule 1). Per-100 g values live only on the food, as the person confirmed them.
- **Fibre null means not reported.** It is never stored as 0. `per100g_micros` and `not_reported` use the `ingredient_micros` keys.
- **Constraints:** nutrients >= 0, protein + carbs + fat <= 105 g per 100 g, serving, volume, density and piece sizes > 0, barcode 8 to 14 digits, state, source (`LABEL | OFF | MANUAL`) and label basis lists, label photo uid and sha256 both set or both null. A barcode is unique per household (partial unique index, archived foods included so restore never collides).
- **Household isolation in the database.** `food_log` references `(household_id, person_id)` and `(household_id, household_food_id)` through composite foreign keys, so a log row cannot name another household's person or food even if a writer is bypassed. Deleting a person cascades to their entries. A food that entries use cannot be deleted (no action).
- **Confirmed foods only.** `confirmed_at` is not null: the row exists because a person confirmed it. An update re-confirms.
- **`skipped` entries** name the skipped meal in the item columns (the recipe and its servings) and readers must not count them as eaten. `planned_recipe_slug` and `planned_servings` record what a `swap` replaced.

## Writers (household scoped, uid AND household lookups)

Every function takes `scope: { householdId, personId }`; `personId` is the acting person, stamped as creator and confirmer, and must belong to the household. Refusals throw `FoodDataError` with a `code`: `not-found`, `person-not-found`, `duplicate-barcode`, `has-entries`, `archived`, `plan-not-found`, `not-planned`, `invalid`.

Each write calls `markChanged` in the same transaction: `food-catalog` for foods, `food-log` for entries.

## Blobs

Label photos live at `labels/<labelPhotoUid>/master.webp` (2048 px) and `labels/<labelPhotoUid>/thumb.webp` (640 px), keys from `foodLabelKeys`. The uid is a fresh one per attached photo (stored in `label_photo_uid`), not the food uid, so a replacement never overwrites the old bytes before its transaction commits. Bytes are written before the transaction, removed if it fails, and the replaced photo's bytes are removed after the commit. `photos:check` compares `labels/` keys too.

## Reset, deletion and export

| Path | Food log | Foods and label bytes | Label extractions |
| --- | --- | --- | --- |
| Reset plans, groceries, progress, ratings | kept | kept | kept |
| Reset profiles | cleared (tied to profiles) | kept | kept |
| Reset everything | cleared | cleared; label keys returned for deletion after commit | kept (cost counter) |
| Household deletion | cleared | cleared; label keys returned in the same list as photo keys | deleted |
| Member account deletion (household stays) | their entries deleted | kept; creator and confirmer set to null | person set null |
| Personal export | the person's entries (names, amounts, no macros, no ids) | not included | not included |

`resetCounts` gains `foods` and `foodLog`. The legacy operator-wide `resetData` follows the same rules and deletes `labels/` blobs with "Everything". The three tables are listed in `EXCLUDED_TABLES` (legacy bundle) and `HUMAN_OWNED_TABLES` (rehearsal counts; the two human-owned ones).

## Renames

`food_log` holds recipe slugs, so `renameRecipeSlug` and `moveRecipe` rewrite `recipe_slug` and `planned_recipe_slug` (all households). Library ingredient slugs have no rename map (`data/renames.json` covers recipes and components only), so a renamed or removed ingredient would leave a dangling `ingredient_slug`. `findDanglingFoodLogSlugs` reports ingredient and recipe slugs the library no longer has; it is tested but not yet wired into a command. A package that renames ingredient slugs must run it first.

## Gotchas

- `importHumanData` refuses any database that has a household (legacy guard). Household-owned classes therefore cannot be restored through it yet; `ImportContext.householdId` is the hook for the restore package, and the round-trip tests call each class's `importFiles` directly with an explicit household. Without a household every file is skipped.
- Import order is class-name order. The foods class is named `food-catalog` so it loads before `food-log`; a test pins this.
- The export drops `plan_id` (a database id). A restored entry keeps its recipe and planned fields but not the plan link.
- `markPlannedMealEaten` locks the slot with a minimal guarded update: there is no plan writer module (`toggleLock` in `app/actions.ts` is an inline update).
- A removed household member (by an owner) keeps their profile, so their log stays with it; only account deletion deletes the entries.

## Acceptance cases (all in PGlite)

1. `0023` creates the three tables and indexes; migration count is 24; migration policy passes without `-- contract-ok`; schema parity lists the tables as Postgres only.
2. Constraints reject out-of-range rows written around the module; exactly-one-item check; composite foreign keys refuse a cross-household food or person; delete of a used food is refused by the database.
3. Barcode unique per household, allowed across households and for several foods without one.
4. Update returns the affected entry count; archive and restore are idempotent; an archived food refuses new entries; delete refused while entries exist.
5. Label photo: WebP master and thumb, EXIF dropped, replacement deletes old bytes after commit, failed transaction deletes new bytes, foreign household leaves no blob.
6. `markPlannedMealEaten` copies recipe, servings and plan, locks the slot in the same transaction, is idempotent, refuses another household's slot and a person with no portion, and rolls the lock back on failure.
7. Both classes round-trip byte for byte into a fresh database; blobs list master (sha256) and thumb.
8. Reset scopes, household deletion (generic "no rows for that household" test extended), member deletion, personal export, `photos:check`, rename hooks, dangling-slug report.
9. Static test: only the two writer modules write the tables; no script imports them or touches `labels/`.
