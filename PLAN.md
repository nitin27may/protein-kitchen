# Protein Kitchen — Product & Technical Plan

Personal meal planner for a vegetarian household: weekly high-protein menus, computed macros, grocery lists, and step-by-step guidance for cooking styles we don't grow up with (salads, roasting, baking, bowls).

Status: planning · Owner: Nitin · Last updated: 2026-10-22

---

## 0. Assumptions to confirm before seeding data

| # | Assumption | Why it matters |
|---|---|---|
| A1 | **Lacto-vegetarian**: dairy yes, eggs no, no meat/fish | Paneer, dahi, Greek yogurt, cottage cheese, whey are the backbone of 120g+ days |
| A2 | Onion & garlic are eaten | Every recipe still carries a `no_onion_garlic` flag so a Jain/vrat filter is possible later |
| A3 | Protein powder (whey or soy/pea isolate) is acceptable | 150g/day without one is very hard (see §2) |
| A4 | Protein target is **per person**, not per household | Family members have different needs; plan scales servings per person |
| A5 | Kitchen has oven + air fryer (+ pressure cooker/Instant Pot) | Drives which "global" recipes we seed |

---

## 1. Why this app will get used (or won't)

The failure mode is building a nice app that's abandoned in three weeks. Design rules that are non-negotiable:

1. **The app proposes, you swap.** Planning a week = pick proteins → Generate → swap 2–3 slots. Target: under 3 minutes, Sunday.
2. **No food logging, ever.** Macros are computed at plan time from recipes. Nobody weighs dal at dinner.
3. **Recipe library quality is the product.** 80 good, tested recipes beat 500 scraped ones.
4. **Phone-first.** The grocery list lives on the phone at the store. Cooking steps are read off the phone in the kitchen.
5. **Three screens.** Week, Recipes, Groceries. Settings is a sheet, not a screen.
6. **Adoption check:** if two Sundays in a row get skipped, fix friction or the library — do not add features.

---

## 2. The protein problem (research summary)

### 2.1 Realistic daily math (lacto-vegetarian)

Typical day built from the library, one adult:

| Meal | Example | Protein (approx.) |
|---|---|---|
| Breakfast | Moong dal chilla stuffed with paneer + 150g Greek yogurt | 30–35g |
| Lunch | Rajma (1 cup cooked) + tofu bhurji side + 1 roti | 28–32g |
| Snack | Roasted chana + skyr, or edamame | 15–20g |
| Dinner | Soya chunk curry or tofu burrito bowl | 30–35g |
| **Total** | | **~105–120g** |

- **100–120g**: achievable with whole foods if *every* meal has an anchor protein.
- **130–150g**: needs a shake (25–30g) or very heavy dairy. The shake is always opt-in: it appears only when the user selects it in plan setup. When it is off and a day falls short, the app shows the gap and offers to add a shake. It never adds one on its own.
- Legume protein comes with lots of carbs; paneer protein comes with lots of fat. That's why the app ranks foods by **protein per 100 kcal**, not just protein per 100g.
- Targets are set per person in g/kg bodyweight (settings), so the app isn't hard-coded to one number. Anyone with a medical condition (e.g., kidney) should set targets with a doctor.

### 2.2 Master protein-source list (first-pass, values approximate)

> Values below are planning estimates only. **The seed pipeline must overwrite them with Canadian Nutrient File (CNF) or USDA FoodData Central values** and record the source ID. Dry vs cooked is the #1 source of macro errors — always store the state.

**Tier 1 — protein-dense anchors (≥ 8g protein / 100 kcal)**

| Food | State | Protein /100g | Notes / where to buy (GTA) |
|---|---|---|---|
| Whey isolate / soy or pea isolate | powder | ~80–90g | Costco, supplement stores |
| Soya chunks (TVP) | dry | ~50g | Indian grocers; swells ~3x |
| Seitan | ready | ~25g | Asian grocers / homemade from vital wheat gluten |
| Tempeh | ready | ~19g | Loblaws, Whole Foods |
| Extra-firm / super-firm tofu | ready | ~14–17g | Everywhere; super-firm needs no pressing |
| Skyr / 0% Greek yogurt | ready | ~10–11g | Everywhere |
| Low-fat cottage cheese | ready | ~11g | Everywhere |
| Edamame (shelled) | cooked/frozen | ~11g | Frozen aisle |
| Ultrafiltered milk (e.g., Fairlife) | liquid | ~5g (≈13g/250ml) | Most supermarkets |

**Tier 2 — strong, but carb- or fat-heavy**

| Food | State | Protein /100g | Notes |
|---|---|---|---|
| Paneer | ready | ~18–20g | High fat; low-fat paneer exists |
| Moong dal / masoor dal | dry | ~24–25g | Chilla, dosa, dal |
| Besan (chickpea flour) | dry | ~22g | Chilla, pudla, baking |
| Chickpeas (chole) | cooked | ~9g | Roast for snacks; salads |
| Rajma | cooked | ~9g | |
| Black beans / pinto | cooked | ~9g | Mexican bowls |
| Lentils (green/brown) | cooked | ~9g | Salads hold shape well |
| Peanuts / peanut butter | ready | ~25g | Fat-heavy; use as booster |
| Pumpkin / hemp seeds | ready | ~30g | Booster topping |
| Roasted chana | ready | ~20g | Ready snack |

**Tier 3 — boosters (add 3–8g per meal)**
Milk, dahi, quinoa, oats, chia, nutritional yeast, whole-wheat atta/roti, almonds, sattu.

### 2.3 What we make from them — meal families

Rather than random recipes, the library is organized into **families** so combinations multiply:

| Family | Pattern | Examples |
|---|---|---|
| Indian curries & dals | protein + gravy base | Paneer bhurji, soya chunk curry, chole, rajma, dal makhani (lighter) |
| Chillas & dosas | batter + filling | Moong chilla + paneer, besan chilla, pesarattu, adai |
| **Bowls** (assembly) | base + protein + veg + sauce + crunch | Burrito bowl, enchilada bowl, fajita bowl, Mediterranean chickpea bowl, tofu poke-style |
| **Salads** (assembly) | greens/grain + protein + veg + dressing + topping | Lentil salad, chana chaat salad, edamame quinoa salad, Greek salad + tofu feta |
| **Sheet-pan / oven** | one tray, one temperature | Sheet-pan tofu + veg, roasted chickpeas, tandoori paneer tikka |
| **Bakes** | high-protein, low-oil | Besan-oat muffins, Greek-yogurt flatbread, cottage-cheese bake, protein oat bars |
| Snacks | ≤10 min or batch | Roasted chana, edamame, skyr parfait, sprouts chaat, hummus + veg |
| Shakes | blender | Whey/soy + milk + banana + PB |

### 2.4 Non-Indian cooking: technique guides

Salads, roasting and baking fail for first-timers because of technique, not recipes. So the library includes **technique cards** that recipe steps link to:

- Pressing & marinating tofu (and when you can skip pressing)
- Crispy roasted chickpeas (dry thoroughly, 200°C, shake halfway)
- Oven basics: preheating, convection = reduce 15°C, rack position, sheet-pan crowding
- Air-fryer conversions (−15°C, ~20% less time vs oven)
- Salad formula (base + protein + crunch + acid + fat) and vinaigrette ratio (3 oil : 1 acid)
- Grain cooking for salads (quinoa, farro, couscous) — don't overcook, cool before dressing
- Baking without eggs: flax egg, yogurt, aquafaba; why measuring by grams matters
- Batch-prep & fridge life (dressings 5–7 days, cooked legumes 4 days, cut veg 3–4 days)

All temperatures in Celsius; all quantities stored in grams.

### 2.5 Daily basics, soaking & morning habits — evidence-graded

The app plans the whole day, not just meals. Every habit carries an **evidence grade** so folk wisdom isn't presented as science. `strong` = consistent human evidence / health-authority guidance; `moderate` = some human trials; `weak` = traditional or mechanistic only; `practical` = no health claim, it just makes cooking work.

**Night-before prep (auto-generated from tomorrow's plan, not a fixed list)**

| Task | Grade | Why |
|---|---|---|
| Soak rajma, chole, whole moong, urad, chana (8–12 h) | practical + moderate | Cuts cooking time a lot; soaking and discarding the water reduces phytates and gas-causing oligosaccharides |
| Soak dal/rice for dosa or chilla batter | practical | Needed for grinding |
| Sprout moong / chana (start 1–2 days ahead) | moderate | Lowers anti-nutrients, adds volume; protein is about the same. Raw sprouts carry food-safety risk — lightly cook them |
| Set dahi | practical | Next day's protein + probiotic |
| Overnight oats / chia pudding | practical | Zero-effort high-protein breakfast |
| Marinate tofu / paneer | practical | Flavour; makes global recipes taste right |
| Move frozen items to fridge | practical | |

**Daily basics checklist (fixed, small)**

| Item | Grade | Notes |
|---|---|---|
| 1 tbsp **ground** flaxseed | strong for ALA omega-3 & fibre | Whole flax passes through undigested — grind it |
| Chia (1 tbsp, always soaked or in liquid) | moderate | Fibre + ALA. Never eat dry spoonfuls — it swells |
| Handful of nuts (walnuts for omega-3, almonds) | strong for nuts in general | Soaking almonds: **weak** — studies show little effect on digestion or nutrient absorption. Fine as a preference, not a requirement |
| Pumpkin / hemp seeds as topping | moderate | Adds zinc, iron and protein boost |
| Dahi / kefir daily | moderate | Protein + calcium + fermented food |
| Fibre target ~25–38 g/day | strong | Computed from the plan, shown alongside protein |
| Water through the day | strong | Hydration is the real benefit of any "morning drink" |

**Morning drinks — what's real**

| Drink | Grade | Verdict |
|---|---|---|
| Plain or warm water on waking | strong (hydration only) | Good habit; no "detox" effect |
| Lemon water | weak | Fine for hydration + a little vitamin C; acid is hard on tooth enamel — rinse after |
| Jeera / ajwain water | weak | Traditional digestive aid; little human evidence |
| Soaked methi (fenugreek) seeds / water | moderate | Some evidence for blood-sugar effects — **anyone on diabetes medication should ask their doctor first** |
| "Detox" drinks of any kind | myth | The liver and kidneys do this; no drink speeds it up |

The app lets the household pick which morning ritual they like; it just labels the grade honestly.

**Vegetarian nutrients to watch (shown in Settings → Health basics, not as advice)**

| Nutrient | Why it matters for vegetarians | Food sources in the library |
|---|---|---|
| Vitamin B12 | Not reliably available from plant foods; low dairy = real deficiency risk | Dairy, fortified plant milks, nutritional yeast; supplements are common |
| Vitamin D | Canadian winters; little sun exposure Oct–Apr | Fortified milk; supplements common |
| Iron | Plant iron absorbs less well | Legumes, tofu, greens — pair with vitamin C, keep chai away from iron-rich meals |
| Omega-3 (ALA → DHA/EPA) | No fish | Ground flax, chia, walnuts, hemp; algal oil is an option |
| Zinc, iodine, calcium | Lower in some vegetarian diets | Seeds, legumes, dairy, iodized salt |

The app does **not** recommend supplement doses. It shows: "Ask your doctor about a blood test for B12, vitamin D and ferritin" once, in Settings.

---

## 3. Data plan — building the master lists

### 3.1 Four master lists, built in order

```
1. ingredients   (~150)   ← nutrition source of truth
2. techniques    (~15)    ← how-to cards
3. components    (~40)    ← reusable sub-recipes: dressings, sauces, marinades, roasted chickpeas, cooked grains
4. recipes       (~80)    ← meals built from ingredients + components
5. habits        (~20)    ← daily basics, morning rituals, each with evidence grade + source
```

Recipes also declare their **advance prep** (soak 10 h, sprout 36 h, marinate 2 h, set dahi 8 h), so the planner can generate tomorrow's prep list automatically.

Macros only ever live on **ingredients**. Components and recipes compute theirs.

Health labels are computed too, never typed in: **low sugar**, **light** and **nutrient-dense**. How they are defined, and where they are the app's own definition, is in `docs/healthy-criteria.md`. The planner favours them by default through a "Healthy focus" setting on the plan setup screen.

### 3.2 Ingredient research pipeline (Claude Code)

For each ingredient:
1. Look up CNF first (Canadian products, Canadian fortification), fall back to USDA FDC.
2. Record `source` + `source_id`, state (`dry` / `cooked` / `raw` / `ready`), and macros per 100g: kcal, protein, carbs, fat, fibre.
3. For dry legumes/grains, record `cooked_yield` (e.g., chickpeas dry→cooked ≈ 2.4x).
4. Add aliases (rajma = kidney beans, chole = chickpeas, dahi = plain yogurt, besan = chickpea flour) so search works in both languages.
5. Add grocery fields: aisle, typical pack size (g), where to buy, pantry staple yes/no.
6. Run `pnpm validate` — fails on missing source, impossible macros (protein+carbs+fat > 100g/100g, kcal off by >15% from 4/4/9 rule).

### 3.3 Recipe authoring pipeline

1. Claude Code drafts recipe JSON in `data/recipes/<family>/<slug>.json` — ingredients in grams, steps structured, technique links, equipment, times.
2. `pnpm validate` resolves every ingredient/component, computes macros per serving, auto-tags (`high-protein` if mains ≥ 25g/serving, snacks ≥ 12g/serving), checks protein-per-100kcal.
3. `pnpm seed` upserts into SQLite.
4. Every recipe starts `status: draft`. After we cook it: `tested` + rating 1–5 + notes. The generator prefers tested recipes once ≥ 3 exist per slot.
5. Recipes rated ≤ 2 are auto-excluded from generation.

### 3.4 Seed targets for v1

| Slot | Count | Mix |
|---|---|---|
| Breakfast | 14 | 8 Indian (chillas, dosa, poha+soya), 6 global (overnight oats, skyr bowls, tofu scramble, bakes) |
| Lunch / dinner | 40 | 22 Indian, 18 global (bowls, salads, sheet-pan, wraps) |
| Snacks | 24 | 8 zero-cook (≤ 2 min), 8 five-minute, 4 ten-minute, 4 Sunday-batch (roasted chana, protein muffins, energy balls). Every snack ≥ 10 g protein |
| Bakes | 8 | muffins, flatbreads, bars |
| Shakes | 4 | |
| Components | 40 | 10 dressings, 8 sauces, 8 marinades, 8 cooked bases, 6 crunch toppings |

Quick-recipe rule: every recipe has `active_min`. Weeknight slots only pull recipes with `active_min ≤ 20`.

---

## 4. Product spec

### 4.1 Screens

**Plan setup (first thing on Generate)** — added 2026-10-22

One screen, four choices, one button. It must be usable one-handed on a phone in under a minute.

1. **Plan length**: chips for 7 days, 14 days or Custom. Custom opens a date range picker (start and end date, minimum 1 day, maximum 31). Default is 7 days from the next Monday, and the last choice is remembered.
2. **Which meals**: toggle chips for Breakfast, Lunch, Dinner, Snack, Shake. Defaults come from the profile. Shake is off unless the profile target needs it.
3. **Who it is for**: multiple profiles from day one. Tick one or more people. Each has their own weight, protein and calorie target, diet flags, likes and avoids. One recipe is cooked once and portioned per person, so the plan shows a servings figure per person and a protein bar per person per day. Profiles are created and edited in a settings sheet, and each profile's targets are configurable.
4. **What you like**:
   - Pick favourite ingredients from a searchable grid grouped by type (proteins, legumes, vegetables, dairy, grains), with the protein anchors first: paneer, tofu, soya, rajma, chole, moong, dahi, tempeh, edamame.
   - Optional "avoid" list (disliked or out of stock).
   - Cuisine balance slider: more Indian, or more global.
   - Time limit: weeknight (active 20 min or less) or no limit.
   - Optional "include these recipes" pins.

Output: a preview of the plan with a protein and calorie bar per day against the profile target, then the usual swap and lock controls. The setup is remembered, so the next run is one tap.

Rules: show at most one decision per row, keep tap targets at 44 px or more, and never block Generate on optional choices. If the picks cannot meet the target (for example 3 liked ingredients and a 150 g protein goal), say so on the preview instead of silently relaxing it.

**Week (home)**
- **Today card** at the top:
  - Morning: chosen ritual + daily basics checklist (flax, chia, nuts, dahi, water). Tap to tick.
  - Tonight: prep tasks for tomorrow, generated from tomorrow's recipes ("Soak 200g rajma", "Set dahi", "Marinate tofu").
  - Optional push reminder at a set time (e.g., 21:00) — PWA push works on Android and on iOS when the app is added to the home screen.
  - **Snack now** button: one tap → 3 snack ideas filtered by time (0 / 5 / 10 min), what's in the pantry, ≥ 10 g protein, ranked by protein per 100 kcal. Each tile shows protein, minutes and "needs cooking: yes/no". Picking one doesn't change the plan; it's a quick idea, not a log.
- 7-day grid: Breakfast · Lunch · Dinner · Snack (+ Shake row if target needs it).
- Protein chips across the top: paneer, tofu, soya, rajma, chole, moong, dahi/skyr, tempeh, edamame. Pick 3–5 → **Generate week**.
- Per day: protein bar vs each person's target (green ≥ target, amber within 15%, red below).
- Tap a slot → bottom sheet: recipe summary + **3 swap suggestions** (same slot, similar protein, not used in last 3 days) + "Choose any".
- Lock a slot (pin) so regenerate keeps it.
- Leftover toggle: dinner → next day's lunch (cook once, eat twice).

**Recipes**
- Filters: family, protein source, meal slot, ≤15 / ≤30 min, equipment (oven, air fryer, no-cook), Indian / global, tested only.
- Recipe page: macros per serving, servings scaler, ingredients (grams + friendly units), steps with linked technique cards, "Cook mode" (large text, one step per screen, keep screen awake, step timers).
- Actions: favourite, ban, mark tested + rating.

**Groceries**
- Built from the week: ingredients summed in grams → converted to pack sizes (round up), grouped by aisle.
- Pantry staples (spices, oil, salt) hidden by default under "Check pantry".
- Check-off works offline. Manual add. **Share** (Web Share API) and **Copy as list** (one item per line — pastes into iOS Reminders / Google Keep as separate items).

**Settings sheet**
- People: name, bodyweight, protein target (g/kg or fixed g), calorie target optional.
- Household default servings, equipment owned, diet flags (no onion/garlic).
- Backup: download DB snapshot, export JSON, import.

**Meal prep guide** (`/plan/[id]/prep`)

A plan page that turns the week into a cooking schedule, built by `lib/prep/session.ts`:

- **Night before**: soak, marinate and set-ahead tasks with the amounts scaled to the batch, due the evening before the cook day.
- **Batch sessions**: foods that keep (fridge life of 2 days or more) and are eaten more than once are cooked together on a prep day, longest unattended jobs first, with the whole batch's ingredients, the steps with their "done when" cues, the use-by day and how to store and reheat.
- **Freshness is enforced**: a batch never serves a meal after its use-by day. A plan longer than the fridge life gets a top-up session automatically.
- **Cook fresh**: anything that keeps a day or less, or is eaten only once, is cooked on the day.
- **Cooking style** on the setup screen: Variety, Cook once and eat twice (dinner becomes the next day's lunch) or Batch cook (each lunch repeats for 2 to 3 days). The default is Cook once, eat twice.

### 4.2 Week generator (deterministic, no AI)

```
inputs: day count + start date, meal types to plan, liked / avoided ingredients,
        cuisine balance, time limit, people + targets, locked slots, equipment, history
        (a recipe "uses" an ingredient if it is in its items, including through components;
         its anchor protein is the ingredient contributing most protein, computed by validate)
for each day:
  breakfast ← favourites rotation, then high-protein breakfasts
  lunch     ← leftover of previous dinner if toggled, else recipe using a chosen protein
  dinner    ← chosen protein ≠ lunch's anchor protein
  snack     ← pick to close the protein gap
constraints:
  - no recipe repeats within 3 days; max 2 uses per week
  - no anchor protein twice in one day
  - weeknights: active_min ≤ 20
  - ≥ 2 global (non-Indian) meals per week (configurable) to build habit
  - prefer tested & highly rated
post-pass:
  - if day protein < target: swap snack → higher-protein snack; then, if the person opted into shakes, add the shake slot; otherwise offer it in the preview banner
  - report any day still below target (don't hide it)
```

Seeded random so "Generate" again gives a different but valid week.

### 4.3 AI — deferred

v1 has **no runtime LLM**. Claude Code is the offline content engine. v2 candidates (only if v1 survives a month): "cook from what's in my fridge" and "make this recipe higher-protein" via Azure OpenAI with structured output, with macros still computed by code.

---

## 5. Technical requirements

### 5.1 Stack

| Concern | Choice | Reason |
|---|---|---|
| App | Next.js (App Router, current stable), TypeScript, Server Actions | One project, UI + API |
| DB | SQLite via better-sqlite3 + Drizzle ORM | Single file, trivial backup, Claude Code can query with `sqlite3` |
| Validation | Zod schemas shared by seed scripts and UI forms | One definition of a valid recipe |
| UI | Tailwind + shadcn/ui, mobile-first | Fast, consistent |
| PWA | Web manifest + service worker (grocery list cached offline) | Home-screen app on phone |
| Tests | Vitest for macro maths, unit conversion, generator constraints | The logic that must not be wrong |
| Hosting | Docker on homelab, accessed via Tailscale | Phone access at the store; Tailscale = auth |
| Backup | `VACUUM INTO` snapshot button + nightly cron copy to NAS/cloud | Consistent copy while app is running |

### 5.2 Data model (SQLite)

```
ingredients(id, slug, name, aliases_json, state, cooked_yield,
            kcal, protein_g, carbs_g, fat_g, fibre_g,        -- per 100g
            source, source_id, aisle, pack_size_g, where_to_buy,
            is_pantry_staple, contains_onion_garlic, is_dairy)

techniques(id, slug, title, body_md, tags_json)

recipes(id, slug, name, kind,              -- kind: recipe | component
        family, meal_slots_json, cuisine, is_indian,
        servings, prep_min, active_min, total_min,
        equipment_json, tags_json, fridge_days, batch_friendly,
        status, rating, notes, favourite, banned)

recipe_items(recipe_id, ingredient_id NULL, component_id NULL,
             grams, display_qty, display_unit, optional)

recipe_steps(recipe_id, step_no, text, technique_id NULL, timer_sec NULL)

recipe_advance_prep(recipe_id, kind,           -- soak | sprout | marinate | set_dahi | thaw | overnight
                    ingredient_id NULL, grams NULL, lead_hours, instruction)

habits(id, slug, title, category,              -- morning_drink | daily_basic | evening_prep_generic
       body_md, evidence_grade,                -- strong | moderate | weak | myth | practical
       evidence_note, source_url, caution NULL, default_on)

habit_log(date, person_id, habit_id, done)     -- ticks only; no food logging
prep_task_state(date, task_key, done)          -- for generated night-before tasks

people(id, name, sex, birth_date, height_cm, weight_kg, activity_level,
       protein_target_g, protein_g_per_kg, kcal_target, reminder_time NULL,   -- reminder is per profile
       diet_flags_json)
preferences(person_id, ingredient_id NULL, recipe_id NULL, kind)   -- kind: like | avoid | pin
plan_setup(id, person_ids_json, start_date, end_date, meal_types_json,
           cuisine_balance, max_active_min NULL, created_at)       -- end_date inclusive; 7 and 14 day chips just fill it in
plan_slot_portions(plan_slot_id, person_id, servings)              -- one cooked recipe, a portion per person
recipe_anchors(recipe_id, ingredient_id, protein_g)                -- derived at seed time, not hand-written

plans(id, week_start, seed, created_at)
plan_slots(plan_id, date, slot, recipe_id, servings, locked, is_leftover)

grocery_state(plan_id, ingredient_id, checked)
grocery_manual(plan_id, text, checked)
pantry(ingredient_id, have, always_stock)   -- always_stock = snack staples kept on every grocery list when low

-- views
v_recipe_macros     -- per serving, recursive over components
v_plan_day_protein  -- per day per person
```

### 5.3 Repo layout

```
/app                 Next.js routes: /(week) /recipes /groceries
/components          UI
/lib/db              Drizzle schema, queries
/lib/nutrition       macro calc, unit conversion, yields
/lib/planner         generator
/lib/grocery         aggregation, pack rounding, aisle sort
/data/ingredients    *.json  (one file per aisle)
/data/techniques     *.md
/data/components     *.json
/data/recipes/<family>/*.json
/scripts             validate.ts, seed.ts, backup.ts, export.ts
/db/app.db           (gitignored; backups elsewhere)
CLAUDE.md
```

`/data` is git-tracked: git history is the backup and audit trail for content. SQLite holds plans, ratings, and grocery state.

### 5.4 Non-functional

- Generate week ≤ 1s; any screen interactive ≤ 1s on phone over Tailscale.
- Grocery list usable offline.
- Every tap target ≥ 44px; cook mode readable at arm's length.
- Units: grams, ml, °C throughout.

---

## 6. Build phases

| Phase | Scope | Done when |
|---|---|---|
| **0. Data foundation** (2–3 evenings) | Schema, Zod, validate/seed scripts, ~150 ingredients from CNF/USDA, 15 technique cards | `pnpm validate` passes; macro tests green |
| **1. Library** (2–3 evenings) | 40 components + 80 recipes drafted via Claude Code | Every slot has ≥ 8 options; ≥ 30 recipes ≥ 25g protein/serving |
| **2. Week + generator** (2 evenings) | Week screen, chips, generate, swap sheet, locks, protein + fibre bars | Plan a real week in < 3 min |
| **2b. Today card** (1 evening) | Habits seed (~20, evidence-graded), tonight's prep from `recipe_advance_prep`, ticks, optional push reminder | Rajma never gets forgotten to soak |
| **3. Groceries + PWA** (1–2 evenings) | Aggregation, pack rounding, share/copy, offline | Used for one real shop |
| **4. Cook mode + ratings** (1 evening) | Step-by-step mode, timers, tested/rating | First 10 recipes rated |
| **Live use** | 3 weeks, no new features | Fix only friction found in use |
| **v2 candidates** | Fridge-to-recipe AI, Google Tasks export, batch-prep Sunday planner | Only if used ≥ 3 of 4 Sundays |

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| LLM-written recipes don't work in a real kitchen | `draft` status; generator prefers `tested`; start with familiar Indian recipes, add 2 global per week |
| Macro errors from dry/cooked confusion | State stored on every ingredient; validator checks kcal vs macros; tests for yields |
| Plan says 120g but portions eaten are smaller | Show protein per serving prominently; serving scaler per person |
| Family doesn't like global food | `is_indian` balance setting; global meals tagged so they can be dialled down |
| App abandoned | 3-minute Sunday rule; no logging; review adoption after 3 weeks |
