# F3b: logging what was eaten, and eaten against planned

Stage record required by CLAUDE.md. Part of `docs/launch/f-food-log.md`. F3a (foods pages, forms, label photo) is a parallel package and owns `app/foods/**` pages, `components/foods/**` and `lib/server/food-queries.ts`.

## Scope

- Server actions in `app/foods/log-actions.ts`: `markMealEaten`, `markMealSkipped`, `markMealSwapped`, `logExtra`, `updateEntry`, `deleteEntry`, `markRestOfDayEaten`, plus `loadFoodCatalog` (read for the add sheet).
- Add sheet (`components/foods-log/AddFoodSheet.tsx`), reached from "Add food" in the Today header and "Add to <slot>" under each slot.
- Today: Ate it, Swapped, Skipped per planned meal, extras per slot, eaten and still-planned protein bars, "Not logged" for a past day, "Mark the rest of today as eaten as planned". A Yesterday / Today switch (`/?d=<yesterday>`) makes a past day reachable.
- Plan review (`/plan/[id]`): planned and eaten protein per day and person, a marker, and the summary line.
- Reads in `lib/server/food-log-queries.ts`; transactional rules in `lib/server/food-log-service.ts`; pure glue in `lib/food-log/*`.

## Decisions

- **Match key** `${personId}:${date}:${slot}` (no plan id), so an answer survives regeneration. An answer whose planned recipe differs from the meal now planned at that key no longer answers it.
- **One answer per planned meal.** Eaten, swapped and skipped replace each other. Each locks the plan slot (regeneration keeps locked slots). Undo from the toast hands the lock back only if the slot was not locked before and no other person's answer remains; "Change" on a card removes the answer and keeps the lock.
- **Skipped is never eaten.** It names the skipped meal in its item columns; `lib/foods/totals` skips it.
- **Permissions.** Every action starts with `actionDenial`. One person: `{ personId }` (owner anyone, member self). Several different people: owner only. The service re-checks inside the transaction, and the writers refuse people, plans, slots and foods of another household. Each action runs in one `mutateHouseholdState` transaction (multi-person logging and rest of day are all or nothing).
- **Reads.** An owner reads everyone's log in the plan; a member reads only their own (Today bars and plan review show planned only for the others).
- **Nothing stores macros.** Nutrition comes from library data plus household foods (archived foods still count for old entries). Fibre not reported reads "at least" or "fibre not reported".
- **Units.** Household foods log by grams, servings, pieces or millilitres through `loggedAmountToGrams`; the friendly quantity is kept as display fields. Ingredients log by grams (state shown: dry, cooked), recipes by servings. Limits: 5 kg, 20 servings.
- Edits: an eaten planned meal changes servings only; answers keep their day and slot; only extras move.

## Acceptance cases

Covered by `tests/food-log-actions.test.ts` (PGlite), `tests/food-log-pure.test.ts`, `tests/access-inventory.test.ts` and `tests/e2e/food-log.spec.ts`: owner marks eaten and the bar updates; extra from a household food at lunch; Undo; member cannot log for another person (UI and forged request); regeneration keeps the eaten slot; plan review summary; anonymous sees none of it.

## Gotchas

- Until F3a is on main, `food-log-queries.ts` has its own small household foods read (`readHouseholdFoods`). Switch to F3a's read afterwards.
- The "Add a packaged food" link points to `/foods/new` (F3a's route).
- There was no existing "plan summary" component; the summary line lives in the new "Eaten against planned" card.
- Yesterday is the only past day reachable from Today; the add sheet also takes any date.
