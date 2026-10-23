# Next phase: filters, Today, plan setup, routines, links, composite meals, photos

Status: proposed, not started. Written 2026-10-23 after reading the code.

## Findings that change the order of work

1. **Tonight's prep is wrong in three ways.** `lib/server/prep.ts` `prepTasksFor` reads only the top-level recipe's `advance_prep`, so soaks on components (chickpeas for falafel, marinating tofu feta) never reach Today or the 21:00 push. It assumes you cook on the day you eat, so batch and leftovers plans give wrong tasks. Its task keys differ from the prep page's keys (`app/plan/[id]/prep/page.tsx`), so ticking in one place does not tick the other. Routines and composite meals both feed this, so it is fixed first.
2. **Composite meals do not show their parts.** `RecipeDetail` only shows a collapsed "Made from" list. `falafel-bowl` repeats the falafel bake step. Hummus and tahini dressing have no step cues. `falafel-bowl` says 20 active minutes, but making it from scratch is about 35. Components are hidden from the Recipes list.
3. **Cook mode has one timer** that resets on every step change, and it drifts in a background tab.
4. **Habits are global.** There is no per-person choice, schedule, prep or grocery link for morning drinks.
5. **Photos.** 89 of 99 recipes have no photo of their own. About a third of the automatic Wikipedia matches were rejected by a person, which shows matching needs human review.

## 0. One source of night-before tasks (small, first)

New pure function `lib/prep/night.ts` `nightTasks(...)` built on `buildPrepGuide`, with recursive component demand, routine tasks, and a stable key `night:{planId}:{dueDate}:{source}:{slug}:{index}` (no text in the key). Today, the prep page and `push.ts` all call it. Delete `prepTasksFor`. Migrate existing tick keys where possible.
Tests: a component's soak appears the evening before its cook day; batch reheat days give no task; a 36-hour sprout is due two evenings before; keys survive text edits.

## 1. Filters everywhere

One pattern: a toolbar row (search, sort, Filters button with count), a row of removable active-filter chips (or up to 3 preset chips when none are active), and the filter options in a panel (right drawer on desktop, bottom sheet on phone) with live counts and a "Show N recipes" footer. Filter state lives in the URL, so back and links keep it. "Save as my default" is stored per list in the database (`saved_views`).
Add to `components/ui.tsx`: `ListToolbar`, `FilterButton`, `SortMenu`, `ActiveFilters`, `PresetChips`, `FilterSection`, removable `Chip`, and a `side="right"` variant of `Sheet`. Remove `FilterBar` and `FilterGroup` after migration. Pure logic in `lib/filters/` (`applyFilters`, `facetCounts`, `useUrlFilters`).
Migrate: Recipes (add sort options, "Show parts", "Show hidden"), Ingredients, ingredient picker, Pin recipes sheet, swap sheet "Choose any", Groceries (search, hide ticked, aisle jump).

## 2. Today dashboard

The screen answers "what do I do next" in about two seconds, and changes with the plan phase:

| Phase | Main job |
|---|---|
| No plan or ended | Plan the week: "Same as last time", Change |
| Plan starts later | Shop and prep: countdown, grocery progress, first night-before task |
| Mid-plan | Eat, then prep. After 17:00 "Tonight" moves above meals |
| Last two days | Today plus "Plan next week" banner |

Before 11:00 morning routines come first. Protein becomes a compact bar per person. Empty states are one muted line, not whole cards. New: `lib/plan/phase.ts` `planPhase(...)`, split `TodayCard` into `MorningCard`, `TonightCard`, `GroceryStatusCard`, `PhaseCard`.

## 3. Step-by-step plan setup and daily routines

Steps, on one route (`/plan/new?step=...`), draft kept in `sessionStorage`:
1. Who and when (optionally shopping day and prep day).
2. Meals and effort (meal types, cooking style, time limit).
3. Food (likes and avoids, cuisine mix, healthy focus, pins, "same breakfast every day").
4. Daily routine, per person (skippable).
5. Review, with a live feasibility check (eligible recipes per meal, protein each person can reach), then Generate.

Every step but the first has Skip. A repeat run opens on Review with last week's choices. After Generate, a three-step strip: Review and swap, What to buy, Prep tonight.

**Routines:** `RecipeSchema.kind` becomes `recipe | component | routine`. A routine is a small recipe (grams, `advance_prep`, steps), linked from `data/habits.json` through an optional `routine` block (recipe slug, time of day, default days), new habit category `routine_drink`. DB: `person_routines` (per person choice, days, time) and `plan_routines` (a snapshot taken at generation so the plan's grocery list stays stable). Routines feed groceries through the existing `expandRecipe` and the night-before list through `nightTasks`. Routine macros count in the day total as a separate line. Overnight oats stays a breakfast recipe, not a routine.
Ingredients: fenugreek seed, cumin seed, chia, almonds, fennel seed, moong, sprouts, lemon juice and flaxseed exist. Ajwain is only a caraway proxy, so look for an IFCT 2017 entry and keep it listed as unresolved if none is found. Add a water ingredient. Spices are pantry staples, so routine lines must show under "Check pantry" with the amount.
Evidence and cautions, no doses: methi water (keep the existing grade, add that high-quality evidence is limited; not safe in pregnancy above food amounts; can lower blood sugar, ask a doctor if on diabetes medicine; allergy risk), jeera and ajwain water (weak; keep to cooking amounts), chia water (practical; always soak first), soaked almonds (weak; tree-nut allergy), sprouts (practical; Health Canada advises vulnerable groups not to eat them raw, so cook them).
Validator: a routine recipe is linked from exactly one habit, evidence notes carry no amounts, seed and spice amounts in routines are capped at a culinary amount set in `validation-overrides.json`.

## 4. Recipe links

Table `recipe_links(id, recipe_id, part_slug, step_no, kind recipe|video|article, url, title, source, start_sec, position, created_at)`. Human-owned and edited in the UI, stored in the database so it survives reseeding and the agent never writes it (add this as a CLAUDE.md rule). Zod: https only, no credentials in the URL, tracking parameters removed, your own title, and the app never fetches the page. Embeds only for YouTube (rewritten to `youtube-nocookie.com`) and Vimeo, click to load, inside a sheet so cook mode keeps its place and wake lock. Links show on the recipe, on each part, and as a chip under a step. Links need internet and are not cached offline.

## 5. Composite meals

Status: PR 4 (data, schema, validator) is done. The Parts UI, cook mode and links are PR 5 to 7. Done in PR 4: `baked-falafel-mix` renamed to `baked-falafel`; components moved to `data/components/<family>/`; `water-tap` and `hummus-commercial` added (USDA, because CNF was unreachable); `alt_ingredient`, `display_qty`, `display_unit` and `label` on component items; `effectiveActiveMin` and `makeAheadMin`; expandRecipe make/buy/have resolver; falafel recipes shortened to their own assembly steps.

- **Naming:** slugs name the thing you make, with no prefix. Variants use a suffix (`hummus-beetroot`). Store-bought versions are ingredients (`hummus-commercial`, with a CNF or USDA source), never components. A component is never also a recipe; to eat hummus as a snack, write a recipe that wraps it. Display names read like a menu ("Hummus", "Lemon tahini dressing", "Baked falafel"). Rename `baked-falafel-mix` to `baked-falafel`, and move components to `data/components/<family>/`.
- **Relax the "used by two or more recipes" rule** when the part has its own method and keeps two days or more, or has a buy alternative.
- **Referencing:** extend the component item with `display_qty`/`display_unit`, `label`, and `alt_ingredient`. Make, buy or have is chosen per plan in `plan_part_state`.
- **Recipe page:** a "Parts of this meal" section with a combined timeline ("soak chickpeas the night before; hummus and dressing up to five days ahead; bake falafel on the day"), and for each part its time, fridge life, protein it adds, a Make / Buy / Have switch, ingredients, steps with cues, and links. Then the bowl's own assembly steps. Component pages get a "Used in" list.
- **Cook mode:** `buildCookPlan` skips parts marked buy or have, starts the longest hands-off part first, and says "While the falafel bakes: make the hummus". Timers become a tray that survives step changes, with end times stored so they do not drift.
- **Time:** effective active time includes the parts that must be made fresh. The weeknight rule and generator use it. Ship the falafel `active_min` change in the same PR.
- **Groceries:** `expandRecipe` takes an optional resolver. "Have" skips the part; "buy" swaps in `alt_ingredient`.
- **Data migration:** hummus and tahini dressing get water items and step cues, falafel recipes lose the duplicated bake step, and four hummus uses get `hummus-commercial` as `alt_ingredient`. Report the macro change per recipe; never apply it silently.

## 6. Photos

Recommended: your own photos first (upload, including when you tick "Cooked and tested"), because they are the only reliable picture of homemade fusion dishes. Fallback: Wikimedia Commons and Openverse candidates (CC0, BY, BY-SA) shown on a review page where you approve or reject each one, with source, licence and author. Nothing shows until approved. No Unsplash (its terms require hotlinking), no AI-generated recipe images, Pexels by manual search only. Process approved images to WebP, strip EXIF, store in an `uploads/` volume served by a route handler, and add `uploads/` to `pnpm backup`. Ingredients without a photo get an aisle-tinted tile with a line icon, the name and a state badge. Recipe collages only when there are three or more ingredient photos.

## Delivery order

| # | PR | Depends on | Size |
|---|---|---|---|
| 1 | `nightTasks` unification and key migration | none | S |
| 2 | Filter primitives, URL state, Recipes and Ingredients | none | M |
| 3 | Filters in picker, pin sheet, swap sheet, groceries | 2 | S |
| 4 | Composite data: schema, water and commercial hummus, effective time, validator, falafel migration | 1 | M |
| 5 | Parts UI, "Used in", make/buy/have, grocery resolver | 4 | M |
| 6 | Cook mode across parts, timer tray | 5 | M |
| 7 | Recipe links | 5 | S/M |
| 8 | Routines: schema, habits, DB, ajwain research, prep and groceries | 1 | L |
| 9 | Plan wizard and post-generate strip | 8 | L |
| 10 | Today redesign | 8, 9 | M |
| 11 | Photos: upload and storage | none | M |
| 12 | Photo candidates, review page, ingredient fallback tile | 11 | M |

## Risks

- Changing falafel `active_min` without effective time silently changes the generator. Ship them together.
- Adding water to hummus and dressing changes macros for every recipe that uses them. Report it.
- Migrating prep keys loses some existing ticks.
- iOS web push only works in the installed home-screen app. Do not add a morning routine push.
- Runtime photo uploads need a volume and a backup path in the deployment.
- Cook-mode timers are throttled in background tabs; stored end times fix the countdown, but the beep needs the page visible.
- Routine amounts next to health claims read as doses. The validator cap and the no-amounts rule are the guard.
- The wizard must not break the 3-minute Sunday rule. Measure repeat-run time.

## Decisions for the owner

1. Routines as `kind: "routine"` recipes linked from `habits.json`. Recommended: yes.
2. A culinary-amount cap for seeds in routines, set by you. Recommended: yes.
3. Rename `baked-falafel-mix` to `baked-falafel` and move components to `data/components/`. Recommended: yes, now.
4. Links human-owned, in the database. Recommended: yes.
5. Shopping day and prep day in the wizard, optional. Recommended: yes.
6. Routine macros counted in day totals as a separate line. Recommended: yes.
7. Photo path: own photos first, Commons and Openverse with review second, no Unsplash, no AI. Recommended: yes.
8. Single-use components allowed when they keep or can be bought. Recommended: yes.
