# F3a: the owner's list of foods, and the label capture

Stage record required by CLAUDE.md. Part of `docs/launch/f-food-log.md` (package F3). F3b (logging screens and the Today changes) is built in parallel in different files. This package does not touch `app/page.tsx`, `components/today/*` or any log action.

## Scope

In:

- `/foods`: the household's foods with search by name, brand or barcode, an archived toggle, and per-100 g macros, a source badge and an "estimated weight" badge on each row.
- `/foods/new`, `/foods/[uid]/edit`: the label form (owner only).
- `/foods/[uid]`: the food, its label photo, "Used in N entries", and the owner's controls (edit, archive or restore, delete when unused, replace the label photo).
- `/foods/[uid]/label/[variant]`: private delivery of the label photo.
- Six owner-only Server Actions in `app/foods/actions.ts`: `createFood`, `updateFood`, `archiveFood`, `restoreFood`, `deleteFood`, `attachLabelPhoto`.
- Household-scoped reads in `lib/server/food-queries.ts`.
- Pure form logic in `lib/foods/form.ts` and `lib/foods/list.ts`, and the request schema in `lib/schemas/food-draft.ts`.

Out: logging a food (F3b), barcode scanning and Open Food Facts (F6), reading the label with a model (F5), merge of duplicate foods, member-created foods.

## Dependencies

F1 (`lib/foods/units`, `validate`, `diet-screen`, `catalog`) and F2 (`lib/human/household-foods.ts`, the tables, `lib/schemas/food.ts`, `foodLabelKeys`). No new migration, no new table, no new environment variable.

## Permission boundaries

| Actor | List and detail | Label photo | Add, edit, archive, delete, replace photo |
| --- | --- | --- | --- |
| Household owner | yes | yes | yes |
| Household member | yes (read only) | yes | no: pages redirect, actions refuse |
| Another household | 404 | 404 | refused ("That food is not in your household.") |
| Visitor with no session | redirect to sign in | 401 | refused |

- Every action begins with `const denied = await actionDenial("owner");`. `tests/access-inventory.test.ts` pins the six names and that first statement.
- The household comes from the session (`memberHouseholdAccess`), never from the request. Reads filter on the household id; the label route looks the food up by uid AND household and answers 404 for anything else.
- The label photo response is `image/webp`, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`.

## How a label becomes a food

1. The phone sends the numbers as printed (a `FoodDraft`), not converted figures, and the resized photo in the same request.
2. The server parses the request with `lib/schemas/food-draft.ts` (strict: unknown keys are refused), then `buildFoodRecord` runs the same code the preview used: it converts to per 100 g with `labelToPer100g`, re-runs `validateLabel`, and refuses a hard error or a warning the person did not confirm.
3. The writer stores the confirmed record. `source` is `LABEL` when a label photo is attached (or already stored), otherwise `MANUAL`. `field_origins` marks every typed field `typed`; a density says where it came from (`pack`, `serving`, `assumed_water`). `confirmed_at` and `confirmed_by` are stamped by the writer. The printed numbers are kept in `label_values`, so the edit form shows the pack, not the converted figures.
4. Rounding: kcal to 0.1, macros to 0.01, other nutrients to 0.001 per 100 g. Nutrients the person did not type are listed in `not_reported`; fibre left blank is stored as null.

## Decisions

- **kJ typed as kcal is a warning only when it stays under 950 kcal per 100 g.** For a dense food (a 345 kcal per 100 g mix) the wrong number is over the hard limit, so it is an error and cannot be confirmed away. The warning path is for lighter foods such as a wet batter.
- **A typed food gets its label photo through Edit, not through the replace control.** Adding a photo is what turns `MANUAL` into `LABEL`, and the Edit form re-checks the numbers against it. `attachLabelPhoto` refuses a `MANUAL` food and says so.
- **The photo is stored before the update on edit, and the food is taken back out on create if the photo fails.** The source never claims a label nobody can see.
- **Warnings reset the confirmation.** The "I checked these values against the label" box is tied to the exact set of warnings; changing a value that changes the warnings clears it.
- **The estimate flag for "treat 1 ml as 1 g"** lives in `field_origins.densityGPerMl = "assumed_water"` (and `label_values.density_estimated`), because the table has no estimate column. `isEstimatedWeight` reads it.
- **Navigation.** The phone bottom bar keeps its four items. "Your foods" is in the desktop sidebar and a card on `/settings`. The bar's "Foods" tab is the library ingredients page, so the new page is called "Your foods" everywhere to avoid two meanings.
- The bottom bar is hidden on `/foods/new` and the edit page, like the other form flows, so the Save bar is not covered.

## Acceptance cases

1. Owner adds "Kirkland pancake batter" from a per-serving label (1/3 cup = 55 g) with a photo: stored per 100 g values are `value / 55 * 100`, source `LABEL`, photo stored as WebP, listed and found by name, brand and barcode.
2. Energy typed in kJ into the kcal field of a light food shows "Looks like kJ, not kcal", Save stays off until the box is ticked, and correcting the number removes both.
3. A hard error (protein above the serving, negative value, bad barcode check digit, missing energy) cannot be saved, and the server refuses it even if the client is bypassed.
4. A liquid in ml needs a density: pack weight and volume, a weighed serving, or the explicit estimate, which marks the food "Estimated weight".
5. A duplicate barcode is refused with "You already have a food with this barcode."
6. Editing a food used by log entries says "This changes N past entries" before and after saving.
7. A member sees the list, a food and its label photo, and gets no add or edit control; the pages redirect and the actions refuse.
8. Another household gets 404 for the food, its edit page and both label variants; its foods never appear in the list or search.
9. Delete is offered only for an unused food; a used one is archived.

## Tests

Vitest: `tests/foods-form.test.ts` (pure logic), `tests/foods-actions.test.ts` (PGlite: owner, member, other household, hard errors, warnings, photo, cleanup), `tests/food-queries.test.ts`, `tests/foods-label-route.test.ts`, `tests/access-inventory.test.ts`. Playwright: `tests/e2e/foods.spec.ts` (retained, phone viewport). Per-file coverage gates in `vitest.config.ts`.

## Gotchas

- Server Actions accept 6 MB; the phone resizes the photo to a few hundred KB first, and the server still refuses more than 8 MB.
- Preview deployments cannot write photos (`photoWritesEnabled`): the actions say so before touching the database.
- Comma decimals ("1,5") are accepted in number fields, for French labels.
- The form only offers six optional nutrients (calcium, iron, potassium, cholesterol, vitamin D, vitamin C). Everything else is stored as not reported.
- Fibre, sugars, saturated fat and sodium are stored per 100 g in `per100g_micros` (`sugars_g`, `sat_fat_g`, `sodium_mg`) except fibre, which has its own column.
