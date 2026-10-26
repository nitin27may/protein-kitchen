# PR B: zero and rounding display rule for nutrients

Part of "Launch: single production environment" in `docs/plan-v3-publish-and-protect.md`. Kept in its own file so parallel launch PRs do not conflict.

## Problem

- About 1,084 values across 246 ingredients are reported by the source as exactly zero (mostly vitamin D, cholesterol, B12, vitamin A). They show as tiles such as "0 mg" next to real values.
- 227 positive values round to zero at the label's precision (cholesterol and sodium use 0 digits) and show "0", which is slightly wrong.
- Nutrients with no Health Canada daily target (cholesterol, sodium, phosphorus, selenium and others) never show a share of a daily need.

## Rule

| Source value | Display |
| --- | --- |
| Not reported | Omitted (unchanged) |
| Exactly zero | No tile; listed once per group as "None: Vitamin D, Vitamin B12, Cholesterol." |
| Positive, rounds to zero | "<1 mg", "<0.01 mg"; "<1% of daily need" where a target exists |
| Any value, no target | No percent bar or text |

## Scope

- `lib/nutrition/display.ts` (pure): `formatAmount(value, digits)`, `formatPct(pct)`, `splitZeros(rows, valueOf)`.
- `components/IngredientDetailView.tsx`: apply per group, "None: ..." line under each group, source note extended with "A value the source reports as zero is listed under None." Tile key now uses the label so raw nutrient keys stay out of the flight payload.
- `lib/library/recipe-detail.ts` and `components/RecipeDetail.tsx`: a meal-level amount of 0 with no `missingFrom` goes to a "None in this meal: ..." line. A zero total with missing ingredients stays hidden, as before. Per-nutrient `digits` now comes from `MICRO_LABELS`.
- Standout nutrients are unchanged.

## Dependencies and permissions

No data, schema or human-owned table changes. No new routes, no database access, no remote services.

## Acceptance cases

Unit (`tests/nutrient-display.test.ts`):
1. Exact 0 goes to the none list; undefined never reaches the splitter.
2. 0.4 at 0 digits reads "<1"; 0.004 at 2 digits reads "<0.01"; 0.5 reads "1".
3. Percent 0.3 reads "<1"; no target gives null.
4. A recipe total of zero with missing ingredients stays hidden and is never marked partial.

Browser (`tests/e2e/public-library.spec.ts`): `/ingredients/kidney-beans-dry` shows "None:" naming Vitamin A, Vitamin B12, Vitamin D and Cholesterol, the source note, and no nutrient tile starting with "0 mg" or "0 µg".

Coverage: per-file 100% gate on `lib/nutrition/display.ts` in `vitest.config.ts`.

## Gotchas

- Percent bars use the unrounded value; only the text changes.
- A recipe where fibre is exactly zero lists Fibre under "None in this meal".
