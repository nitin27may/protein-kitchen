import { z } from "zod";
import type { ImportRow, SqliteSnapshot, TableDigest } from "../db/sqlite-snapshot";
import { TIMES_OF_DAY, type TimeOfDay } from "../routines/types";
import { personKey } from "../human/routines";
import { sha256, stableJson } from "../human/util";

/**
 * The legacy household bundle: a versioned JSON file the owner builds on their own machine from a copy of the old
 * single-household SQLite file, then uploads to their own account. Rows are keyed by recipe, ingredient and habit
 * slug, by uid and by person key. Database ids never appear, so the file survives import into any database.
 * Library tables, sync_state, push subscriptions, reminder logs and photos are never included.
 */
export const BUNDLE_FORMAT = "protein-kitchen-legacy-bundle";
export const BUNDLE_VERSION = 1;
/** Well under the 6 MB server action body limit, which also carries multipart overhead. */
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024;

export class LegacyBundleError extends Error {
  override name = "LegacyBundleError";
}

const slug = z.string().min(1).max(200);
const iso = z.string().min(1).max(40);
const key = z.string().regex(/^p-[0-9a-f]{16}$/);
const uid = z.string().min(1).max(100);
const nullableKey = key.nullable();

const Person = z.object({
  key, name: z.string().min(1).max(60), sex: z.enum(["male", "female", "other"]), birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  height_cm: z.number(), weight_kg: z.number(), activity_level: z.enum(["sedentary", "light", "moderate", "high"]),
  protein_target_g: z.number().nullable(), protein_g_per_kg: z.number().nullable(), kcal_target: z.number().nullable(),
  reminder_time: z.string().nullable(), diet_flags: z.array(z.string()),
  preferences: z.array(z.object({ kind: z.enum(["like", "avoid", "pin"]), ingredient: slug.nullable(), recipe: slug.nullable() })),
}).strict();

const Feedback = z.object({
  recipe: slug, uid, status: z.enum(["draft", "tested"]), rating: z.number().int().min(1).max(5).nullable(), favourite: z.boolean(),
  banned: z.boolean(), notes: z.string().nullable(), tested_at: iso.nullable(), created_at: iso, updated_at: iso, created_by: nullableKey,
}).strict();

const Link = z.object({
  uid, recipe: slug, part_slug: slug.nullable(), step_no: z.number().int().nullable(), kind: z.enum(["recipe", "video", "article"]),
  url: z.string().min(1), title: z.string().min(1), source: z.string().nullable(), start_sec: z.number().int().nullable(),
  position: z.number().int(), created_at: iso, updated_at: iso, created_by: nullableKey,
}).strict();

const View = z.object({
  uid, list: z.string().min(1), name: z.string().min(1), query: z.string(), is_default: z.boolean(),
  created_at: iso, updated_at: iso, created_by: nullableKey,
}).strict();

const Routine = z.object({
  uid, person: key, habit: slug, days: z.array(z.number().int().min(1).max(7)), time_of_day: z.enum(TIMES_OF_DAY), servings: z.number().positive(),
  active: z.boolean(), created_at: iso, updated_at: iso, created_by: nullableKey,
}).strict();

const Pantry = z.object({ ingredient: slug, have: z.boolean(), always_stock: z.boolean() }).strict();
const HabitLog = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), person: key, habit: slug, done: z.boolean() }).strict();

const ref = z.string().regex(/^(setup|plan)-\d+$/);
const Setup = z.object({
  ref, people: z.array(key), start_date: z.string(), end_date: z.string(), meal_types: z.array(z.string()), cuisine_balance: z.number(),
  max_active_min: z.number().int().nullable(),
  health_focus: z.object({ nutrientDense: z.boolean(), lowSugar: z.boolean(), light: z.boolean() }).nullable(),
  prep_style: z.enum(["variety", "leftovers", "batch"]).nullable(), shopping_day: z.number().int().nullable(),
  prep_day: z.number().int().nullable(), created_at: iso,
}).strict();

const Plan = z.object({
  ref, setup: ref, seed: z.number().int(), created_at: iso,
  slots: z.array(z.object({
    date: z.string(), slot: z.enum(["breakfast", "lunch", "dinner", "snack", "shake"]), recipe: slug, locked: z.boolean(), is_leftover: z.boolean(),
    portions: z.array(z.object({ person: key, servings: z.number() }).strict()),
  }).strict()),
  routines: z.array(z.object({ person: key, habit: slug, days: z.array(z.number().int()), time_of_day: z.string(), servings: z.number() }).strict()),
  grocery: z.array(z.object({ ingredient: slug, checked: z.boolean() }).strict()),
  manual: z.array(z.object({ text: z.string(), checked: z.boolean() }).strict()),
  part_state: z.array(z.object({ component: slug, mode: z.enum(["make", "buy", "have"]), updated_at: iso }).strict()),
  progress: z.array(z.object({ step: z.enum(["reviewed", "shopping", "prep"]), done_at: iso }).strict()),
}).strict();

const PrepTask = z.object({ date: z.string(), task_key: z.string().min(1), done: z.boolean() }).strict();

const Data = z.object({
  people: z.array(Person), recipe_feedback: z.array(Feedback), recipe_links: z.array(Link), saved_views: z.array(View),
  person_routines: z.array(Routine), pantry: z.array(Pantry), habit_log: z.array(HabitLog),
  plan_setups: z.array(Setup), plans: z.array(Plan), prep_tasks: z.array(PrepTask),
}).strict();

const Counts = z.record(z.string(), z.number().int().nonnegative());
const Digest = z.object({ count: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export const BundleSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.number().int(),
  created_at: iso,
  with_plans: z.boolean(),
  source: z.record(z.string(), Digest),
  data: Data,
  manifest: z.object({ counts: Counts, sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
}).strict();

export type LegacyBundle = z.infer<typeof BundleSchema>;
export type LegacyBundleData = z.infer<typeof Data>;
export type BundleCounts = Record<string, number>;

/** What is copied from each source table; everything else is excluded by construction. */
export const SOURCE_TABLES = [
  "people", "preferences", "recipe_feedback", "recipe_links", "saved_views", "person_routines", "pantry", "habit_log",
] as const;
export const PLAN_SOURCE_TABLES = [
  "plan_setups", "plans", "plan_slots", "plan_slot_portions", "plan_routines", "grocery_state", "grocery_manual",
  "plan_part_state", "plan_progress", "prep_task_state",
] as const;
/** Documented in the file so a reader can see what was deliberately left behind. */
export const EXCLUDED_TABLES = [
  "ingredients", "ingredient_micros", "techniques", "recipes", "recipe_items", "recipe_steps", "recipe_advance_prep", "recipe_macros",
  "recipe_anchors", "habits", "sync_state", "push_subscriptions", "reminder_log", "photos", "photo_decisions",
  "library_photos", "library_photo_decisions",
] as const;

export function countBundle(data: LegacyBundleData): BundleCounts {
  return {
    people: data.people.length,
    preferences: data.people.reduce((n, p) => n + p.preferences.length, 0),
    recipe_feedback: data.recipe_feedback.length,
    recipe_links: data.recipe_links.length,
    saved_views: data.saved_views.length,
    person_routines: data.person_routines.length,
    pantry: data.pantry.length,
    habit_log: data.habit_log.length,
    plan_setups: data.plan_setups.length,
    plans: data.plans.length,
    plan_slots: data.plans.reduce((n, p) => n + p.slots.length, 0),
    plan_slot_portions: data.plans.reduce((n, p) => n + p.slots.reduce((m, s) => m + s.portions.length, 0), 0),
    plan_routines: data.plans.reduce((n, p) => n + p.routines.length, 0),
    grocery_state: data.plans.reduce((n, p) => n + p.grocery.length, 0),
    grocery_manual: data.plans.reduce((n, p) => n + p.manual.length, 0),
    plan_part_state: data.plans.reduce((n, p) => n + p.part_state.length, 0),
    plan_progress: data.plans.reduce((n, p) => n + p.progress.length, 0),
    prep_task_state: data.prep_tasks.length,
  };
}

export const dataChecksum = (data: LegacyBundleData): string => sha256(stableJson(data));

/** A uuid-shaped id derived from the row's natural key, so rebuilding a bundle from the same source gives the same uids. */
export function derivedUid(kind: string, natural: string): string {
  const h = sha256(`legacy:${kind}:${natural}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Plan references inside prep task keys are written as `@plan-N`; the importer replaces them with the new plan id. */
const PLAN_KEY = /^(night|prep):(\d+):/;

export interface BuildOptions {
  withPlans: boolean;
  /** data/renames.json: old recipe slug to new slug. */
  renames: Readonly<Record<string, string>>;
  now?: () => Date;
}

type Rows = Record<string, ImportRow[]>;
const str = (v: unknown): string => String(v);
const optStr = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number => Number(v);
const optNum = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown): boolean => v === true;

/** Pure: turns a verified snapshot of a copy of the old database into a bundle. */
export function buildLegacyBundle(snapshot: SqliteSnapshot, options: BuildOptions): LegacyBundle {
  const rows: Rows = snapshot.rows;
  const at = (options.now ?? (() => new Date()))().toISOString();
  const need = (name: string): ImportRow[] => rows[name] ?? [];
  const bySlug = (name: string) => new Map(need(name).map((r) => [num(r.id), str(r.slug)]));
  const recipeSlug = bySlug("recipes"), ingredientSlug = bySlug("ingredients"), habitSlug = bySlug("habits");
  const rename = (s: string): string => options.renames[s] ?? s;

  const keyOf = new Map<number, string>();
  const seenKeys = new Set<string>();
  for (const p of need("people")) {
    const k = personKey(str(p.name), str(p.birth_date));
    if (seenKeys.has(k)) throw new LegacyBundleError("Two people share the same name and birth date, so they cannot be told apart. Edit one in a private copy first.");
    seenKeys.add(k);
    keyOf.set(num(p.id), k);
  }
  const person = (v: unknown): string => {
    const k = keyOf.get(num(v));
    if (!k) throw new LegacyBundleError("A row refers to a person that is not in the source people table.");
    return k;
  };
  const createdBy = (v: unknown): string | null => (v === null || v === undefined ? null : keyOf.get(num(v)) ?? null);
  const lookup = (m: Map<number, string>, v: unknown, what: string): string => {
    const s = m.get(num(v));
    if (!s) throw new LegacyBundleError(`A row refers to a ${what} that is not in the source library tables.`);
    return s;
  };

  const people = need("people").map((p) => ({
    key: person(p.id), name: str(p.name), sex: p.sex as "male" | "female" | "other", birth_date: str(p.birth_date),
    height_cm: num(p.height_cm), weight_kg: num(p.weight_kg), activity_level: p.activity_level as "sedentary" | "light" | "moderate" | "high",
    protein_target_g: optNum(p.protein_target_g), protein_g_per_kg: optNum(p.protein_g_per_kg), kcal_target: optNum(p.kcal_target),
    reminder_time: optStr(p.reminder_time), diet_flags: (p.diet_flags as string[]),
    preferences: need("preferences").filter((x) => num(x.person_id) === num(p.id)).map((x) => ({
      kind: x.kind as "like" | "avoid" | "pin",
      ingredient: x.ingredient_id === null ? null : ingredientSlug.get(num(x.ingredient_id)) ?? null,
      recipe: x.recipe_id === null ? null : rename(lookup(recipeSlug, x.recipe_id, "recipe")),
    })).filter((x) => x.ingredient !== null || x.recipe !== null)
      .sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
  })).sort((a, b) => a.key.localeCompare(b.key));

  const touched = (r: ImportRow) => r.rating !== null || bool(r.favourite) || bool(r.banned) || r.notes !== null || r.status === "tested" || r.tested_at !== null;
  const recipe_feedback = need("recipe_feedback").filter(touched).map((r) => {
    const slugName = rename(lookup(recipeSlug, r.recipe_id, "recipe"));
    const created = optStr(r.created_at) ?? optStr(r.tested_at) ?? at;
    return {
      recipe: slugName, uid: optStr(r.uid) ?? derivedUid("feedback", slugName), status: r.status as "draft" | "tested",
      rating: optNum(r.rating), favourite: bool(r.favourite), banned: bool(r.banned), notes: optStr(r.notes), tested_at: optStr(r.tested_at),
      created_at: created, updated_at: optStr(r.updated_at) ?? created, created_by: createdBy(r.created_by_person_id),
    };
  }).sort((a, b) => a.recipe.localeCompare(b.recipe));

  const recipe_links = need("recipe_links").map((r) => {
    const slugName = rename(lookup(recipeSlug, r.recipe_id, "recipe"));
    return {
      uid: str(r.uid), recipe: slugName, part_slug: r.part_slug === null ? null : rename(str(r.part_slug)), step_no: optNum(r.step_no),
      kind: r.kind as "recipe" | "video" | "article", url: str(r.url), title: str(r.title), source: optStr(r.source), start_sec: optNum(r.start_sec),
      position: num(r.position), created_at: str(r.created_at), updated_at: str(r.updated_at), created_by: createdBy(r.created_by_person_id),
    };
  }).sort((a, b) => a.uid.localeCompare(b.uid));

  const saved_views = need("saved_views").map((r) => {
    const id = optStr(r.uid) ?? derivedUid("view", `${str(r.list)}|${str(r.name)}|${str(r.query)}`);
    const created = optStr(r.created_at) ?? at;
    return {
      uid: id, list: str(r.list), name: str(r.name), query: str(r.query), is_default: bool(r.is_default),
      created_at: created, updated_at: optStr(r.updated_at) ?? created, created_by: createdBy(r.created_by_person_id),
    };
  }).sort((a, b) => a.uid.localeCompare(b.uid));

  const person_routines = need("person_routines").map((r) => {
    const owner = person(r.person_id), habit = lookup(habitSlug, r.habit_id, "habit");
    const created = optStr(r.created_at) ?? at;
    return {
      uid: optStr(r.uid) ?? derivedUid("routine", `${owner}|${habit}`), person: owner, habit,
      days: [...(r.days as number[])].sort((a, b) => a - b), time_of_day: r.time_of_day as TimeOfDay, servings: num(r.servings), active: bool(r.active),
      created_at: created, updated_at: optStr(r.updated_at) ?? created, created_by: createdBy(r.created_by_person_id),
    };
  }).sort((a, b) => a.uid.localeCompare(b.uid));

  const pantry = need("pantry").map((r) => ({
    ingredient: lookup(ingredientSlug, r.ingredient_id, "ingredient"), have: bool(r.have), always_stock: bool(r.always_stock),
  })).sort((a, b) => a.ingredient.localeCompare(b.ingredient));

  const habit_log = need("habit_log").map((r) => ({
    date: str(r.date), person: person(r.person_id), habit: lookup(habitSlug, r.habit_id, "habit"), done: bool(r.done),
  })).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));

  const data: LegacyBundleData = { people, recipe_feedback, recipe_links, saved_views, person_routines, pantry, habit_log, plan_setups: [], plans: [], prep_tasks: [] };

  if (options.withPlans) {
    const setupRef = new Map<number, string>();
    need("plan_setups").slice().sort((a, b) => num(a.id) - num(b.id)).forEach((r, i) => setupRef.set(num(r.id), `setup-${i + 1}`));
    data.plan_setups = need("plan_setups").slice().sort((a, b) => num(a.id) - num(b.id)).map((r) => ({
      ref: setupRef.get(num(r.id))!, people: (r.person_ids as number[]).map(person), start_date: str(r.start_date), end_date: str(r.end_date),
      meal_types: r.meal_types as string[], cuisine_balance: num(r.cuisine_balance), max_active_min: optNum(r.max_active_min),
      health_focus: (r.health_focus ?? null) as { nutrientDense: boolean; lowSugar: boolean; light: boolean } | null,
      prep_style: (r.prep_style ?? null) as "variety" | "leftovers" | "batch" | null, shopping_day: optNum(r.shopping_day),
      prep_day: optNum(r.prep_day), created_at: str(r.created_at),
    }));
    const planRef = new Map<number, string>();
    const sortedPlans = need("plans").slice().sort((a, b) => num(a.id) - num(b.id));
    sortedPlans.forEach((r, i) => planRef.set(num(r.id), `plan-${i + 1}`));
    const slotsOf = (planId: number) => need("plan_slots").filter((r) => num(r.plan_id) === planId).sort((a, b) => num(a.id) - num(b.id));
    const mine = (name: string, planId: number) => need(name).filter((r) => num(r.plan_id) === planId);
    data.plans = sortedPlans.map((p) => {
      const planId = num(p.id);
      const setup = setupRef.get(num(p.setup_id));
      if (!setup) throw new LegacyBundleError("A plan refers to a setup that is not in the source.");
      return {
        ref: planRef.get(planId)!, setup, seed: num(p.seed), created_at: str(p.created_at),
        slots: slotsOf(planId).map((sl) => ({
          date: str(sl.date), slot: sl.slot as "breakfast" | "lunch" | "dinner" | "snack" | "shake", recipe: rename(lookup(recipeSlug, sl.recipe_id, "recipe")),
          locked: bool(sl.locked), is_leftover: bool(sl.is_leftover),
          portions: need("plan_slot_portions").filter((x) => num(x.plan_slot_id) === num(sl.id))
            .map((x) => ({ person: person(x.person_id), servings: num(x.servings) })).sort((a, b) => a.person.localeCompare(b.person)),
        })),
        routines: mine("plan_routines", planId).map((x) => ({
          person: person(x.person_id), habit: lookup(habitSlug, x.habit_id, "habit"), days: [...(x.days as number[])].sort((a, b) => a - b),
          time_of_day: str(x.time_of_day), servings: num(x.servings),
        })).sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
        grocery: mine("grocery_state", planId).map((x) => ({ ingredient: lookup(ingredientSlug, x.ingredient_id, "ingredient"), checked: bool(x.checked) }))
          .sort((a, b) => a.ingredient.localeCompare(b.ingredient)),
        manual: mine("grocery_manual", planId).sort((a, b) => num(a.id) - num(b.id)).map((x) => ({ text: str(x.text), checked: bool(x.checked) })),
        part_state: mine("plan_part_state", planId).map((x) => ({ component: rename(str(x.component_slug)), mode: x.mode as "make" | "buy" | "have", updated_at: str(x.updated_at) }))
          .sort((a, b) => a.component.localeCompare(b.component)),
        progress: mine("plan_progress", planId).map((x) => ({ step: x.step as "reviewed" | "shopping" | "prep", done_at: str(x.done_at) }))
          .sort((a, b) => a.step.localeCompare(b.step)),
      };
    });
    // Task keys embed the old plan id. Replace it with a reference; a key for a plan that is not in the bundle is dropped.
    data.prep_tasks = need("prep_task_state").flatMap((r) => {
      const taskKey = str(r.task_key);
      const m = PLAN_KEY.exec(taskKey);
      if (!m) return [{ date: str(r.date), task_key: taskKey, done: bool(r.done) }];
      const target = planRef.get(Number(m[2]));
      return target ? [{ date: str(r.date), task_key: `${m[1]}:@${target}:${taskKey.slice(m[0].length)}`, done: bool(r.done) }] : [];
    }).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  }

  const included: string[] = [...SOURCE_TABLES, ...(options.withPlans ? PLAN_SOURCE_TABLES : [])];
  const source: Record<string, TableDigest> = {};
  for (const name of included) source[name] = snapshot.tables[name] ?? { count: 0, sha256: sha256("") };
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION, created_at: at, with_plans: options.withPlans, source,
    data, manifest: { counts: countBundle(data), sha256: dataChecksum(data) },
  };
}

/** Parses and verifies uploaded text. Never echoes file content in an error. */
export function parseLegacyBundle(text: string): LegacyBundle {
  if (Buffer.byteLength(text, "utf8") > MAX_BUNDLE_BYTES) throw new LegacyBundleError("The bundle file is too large. It must be under 4 MB.");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new LegacyBundleError("The file is not a legacy bundle. Build one with pnpm legacy:bundle."); }
  if (!raw || typeof raw !== "object" || (raw as { format?: unknown }).format !== BUNDLE_FORMAT) {
    throw new LegacyBundleError("The file is not a legacy bundle. Build one with pnpm legacy:bundle.");
  }
  if ((raw as { version?: unknown }).version !== BUNDLE_VERSION) {
    throw new LegacyBundleError(`This bundle version is not supported. This app reads version ${BUNDLE_VERSION}.`);
  }
  const parsed = BundleSchema.safeParse(raw);
  if (!parsed.success) throw new LegacyBundleError("The bundle is malformed. Build it again from your source copy.");
  const bundle = parsed.data;
  if (dataChecksum(bundle.data) !== bundle.manifest.sha256) throw new LegacyBundleError("The bundle checksum does not match its contents. The file was changed or damaged; build it again.");
  if (stableJson(countBundle(bundle.data)) !== stableJson(bundle.manifest.counts)) throw new LegacyBundleError("The bundle counts do not match its contents. Build it again.");
  return bundle;
}
