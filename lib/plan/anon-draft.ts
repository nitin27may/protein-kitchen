import { z } from "zod";
import { safeAuthReturn } from "../auth/browser";
import type { GeneratedPlan, PersonTarget, PlannedSlot, Slot } from "../planner/types";
import { MAX_PLAN_DAYS, MEAL_SLOTS } from "../schemas";
import { CreatePlanInput } from "./create-plan-input";

/**
 * On-device state for an anonymous visitor: the plan draft, the profile it was made for, and the action to finish after
 * signup. Pure and browser-safe (no Node, database or server imports). Nothing here is sent to the server except the
 * draft itself, at import time, and the server never trusts its slots.
 */

export const ANON_DRAFT_VERSION = 1;
export const ANON_PROFILE_VERSION = 1;
export const ANON_DRAFT_KEY = "pk-anon-draft";
export const ANON_PROFILE_KEY = "pk-anon-profile";
export const PENDING_INTENT_KEY = "pk-pending-intent";
export const ANON_PROFILE_REF = ANON_PROFILE_KEY;
/** The single person an anonymous plan is made for. The server replaces it with the member's own profile on import. */
export const ANON_PERSON_ID = "1";

export const DRAFT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** The localStorage copy exists only so an email link opened in a new tab can find the draft. */
export const MIRROR_TTL_MS = 30 * 60 * 1000;
export const INTENT_TTL_MS = 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

// ---------- Schemas ----------

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const recipeSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/);

export const DraftSlotSchema = z.object({
  date: isoDate,
  slot: z.enum(MEAL_SLOTS),
  recipeSlug,
  locked: z.boolean(),
  isLeftover: z.boolean().optional(),
}).strict();

export const portionKey = (date: string, slot: string) => `${date}|${slot}`;

export const AnonDraftSchema = z.object({
  version: z.literal(ANON_DRAFT_VERSION),
  libraryVersion: z.string().min(1).max(128),
  /** Same shape as the create-plan action's input. `personIds` is a placeholder; the server uses the member's profile. */
  setup: CreatePlanInput,
  seed: z.number().int().min(0).max(2 ** 31 - 1),
  slots: z.array(DraftSlotSchema).max(MAX_PLAN_DAYS * MEAL_SLOTS.length),
  /** Quarter servings for the one anonymous person, keyed by `portionKey(date, slot)`. */
  portions: z.record(z.string(), z.number().min(0.25).max(4).multipleOf(0.25)),
  profileRef: z.string().min(1).max(64),
  createdAt: z.string().datetime(),
}).strict();

export type AnonDraft = z.output<typeof AnonDraftSchema>;

const ProteinSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("perKg"), gPerKg: z.number().min(0.6).max(3), weightKg: z.number().min(30).max(300) }).strict(),
  z.object({ mode: z.literal("fixed"), grams: z.number().int().min(30).max(400) }).strict(),
]);

/** Strict on purpose: birth date, sex, height and activity never enter anonymous storage. */
export const AnonProfileSchema = z.object({
  version: z.literal(ANON_PROFILE_VERSION).default(ANON_PROFILE_VERSION),
  name: z.string().trim().max(60).optional().transform((value) => value || "You"),
  protein: ProteinSchema,
  kcalTarget: z.number().int().min(1000).max(6000).nullable().optional().transform((value) => value ?? null),
  liked: z.array(recipeSlug).max(200).default([]),
  avoided: z.array(recipeSlug).max(200).default([]),
}).strict();

export type AnonProfile = z.output<typeof AnonProfileSchema>;
export type AnonProfileInput = z.input<typeof AnonProfileSchema>;

/** Same rounding as the household profile, so the same inputs give the same daily target on both sides. */
export function anonProteinTargetG(profile: AnonProfile): number {
  return profile.protein.mode === "fixed" ? profile.protein.grams : Math.round(profile.protein.gPerKg * profile.protein.weightKg);
}

export function anonProfileToTarget(profile: AnonProfile): PersonTarget {
  const avoided = new Set(profile.avoided);
  return {
    id: ANON_PERSON_ID,
    name: profile.name,
    proteinTargetG: anonProteinTargetG(profile),
    kcalTarget: profile.kcalTarget,
    liked: new Set(profile.liked.filter((slug) => !avoided.has(slug))),
    avoided,
  };
}

const IntentBase = { returnTo: z.string().transform((value) => safeAuthReturn(value)), createdAt: z.string().datetime() };
const slugField = recipeSlug;

export const PendingIntentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("save-plan"), ...IntentBase }).strict(),
  z.object({ kind: z.literal("favourite"), slug: slugField, ...IntentBase }).strict(),
  z.object({ kind: z.literal("rate"), slug: slugField, value: z.number().int().min(1).max(5), ...IntentBase }).strict(),
  z.object({ kind: z.literal("ban"), slug: slugField, ...IntentBase }).strict(),
  z.object({ kind: z.literal("tested"), slug: slugField, ...IntentBase }).strict(),
  z.object({ kind: z.literal("tick-grocery"), ingredient: slugField, ...IntentBase }).strict(),
  z.object({ kind: z.literal("save-profile"), ...IntentBase }).strict(),
]);

export type PendingIntent = z.output<typeof PendingIntentSchema>;
export type PendingIntentKind = PendingIntent["kind"];
/** What a caller supplies: `createdAt` is added when absent, and `returnTo` is made safe. */
export type PendingIntentInput = PendingIntent extends infer T ? (T extends unknown ? Omit<T, "createdAt"> & { createdAt?: string } : never) : never;

// ---------- Draft <-> plan ----------

/** Turns a generated plan into the storable draft. `now` is passed in so the result is testable. */
export function buildAnonDraft(args: {
  setup: z.input<typeof CreatePlanInput>;
  seed: number;
  plan: Pick<GeneratedPlan, "slots">;
  libraryVersion: string;
  now: Date;
  profileRef?: string;
}): AnonDraft {
  const portions: Record<string, number> = {};
  for (const slot of args.plan.slots) portions[portionKey(slot.date, slot.slot)] = slot.servings[ANON_PERSON_ID] ?? 1;
  return AnonDraftSchema.parse({
    version: ANON_DRAFT_VERSION,
    libraryVersion: args.libraryVersion,
    setup: args.setup,
    seed: args.seed,
    slots: args.plan.slots.map((s) => ({
      date: s.date, slot: s.slot, recipeSlug: s.recipeSlug, locked: s.locked, ...(s.isLeftover ? { isLeftover: true } : {}),
    })),
    portions,
    profileRef: args.profileRef ?? ANON_PROFILE_REF,
    createdAt: args.now.toISOString(),
  });
}

/** Rebuilds the planner's slots for display. Reasons are not stored, so they come back empty. */
export function draftToPlannedSlots(draft: AnonDraft): PlannedSlot[] {
  return draft.slots.map((s) => ({
    date: s.date, slot: s.slot as Slot, recipeSlug: s.recipeSlug, locked: s.locked, reasons: [],
    servings: { [ANON_PERSON_ID]: draft.portions[portionKey(s.date, s.slot)] ?? 1 },
    ...(s.isLeftover ? { isLeftover: true } : {}),
  }));
}

/**
 * True when a regenerated plan is the same meals and portions as the draft. A mismatch means the library, the
 * household's feedback or the profile changed since the draft was made, or the draft was altered.
 */
export function planMatchesDraft(draft: AnonDraft, slots: readonly PlannedSlot[], personId: string): boolean {
  if (slots.length !== draft.slots.length) return false;
  const key = (date: string, slot: string, recipe: string, locked: boolean, leftover: boolean, servings: number) =>
    `${date}|${slot}|${recipe}|${locked}|${leftover}|${servings}`;
  const wanted = new Set(draft.slots.map((s) =>
    key(s.date, s.slot, s.recipeSlug, s.locked, s.isLeftover ?? false, draft.portions[portionKey(s.date, s.slot)] ?? 1)));
  if (wanted.size !== draft.slots.length) return false;
  return slots.every((s) => wanted.has(key(s.date, s.slot, s.recipeSlug, s.locked, s.isLeftover ?? false, s.servings[personId] ?? 1)));
}

export function draftExpiresAt(draft: Pick<AnonDraft, "createdAt">): number {
  return Date.parse(draft.createdAt) + DRAFT_TTL_MS;
}

export function isDraftExpired(draft: Pick<AnonDraft, "createdAt">, now: Date): boolean {
  return now.getTime() >= draftExpiresAt(draft);
}

// ---------- Storage ----------

/** The subset of the Web Storage API used here, so tests and servers can inject a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** sessionStorage is primary. localStorage holds a short-lived mirror, written only when signup starts. */
export interface AnonStores {
  session: StorageLike | null;
  local: StorageLike | null;
}

/** Storage can throw or be absent (private windows, blocked site data), so every access is guarded. */
export function browserStores(): AnonStores {
  const pick = (name: "sessionStorage" | "localStorage"): StorageLike | null => {
    try {
      const store = (globalThis as { [k: string]: unknown })[name] as StorageLike | undefined;
      return store ?? null;
    } catch {
      return null;
    }
  };
  return { session: pick("sessionStorage"), local: pick("localStorage") };
}

function read(store: StorageLike | null, key: string): string | null {
  try { return store?.getItem(key) ?? null; } catch { return null; }
}
function write(store: StorageLike | null, key: string, value: string): boolean {
  try { store?.setItem(key, value); return store !== null; } catch { return false; }
}
function drop(store: StorageLike | null, key: string): void {
  try { store?.removeItem(key); } catch { /* nothing to remove */ }
}

const MirrorSchema = z.object({ expiresAt: z.number(), value: z.string() });

/** Session value first; otherwise a live mirror, which is promoted into the session. An expired mirror is deleted. */
function readRaw(stores: AnonStores, key: string, now: Date): { raw: string; fromMirror: boolean } | null {
  const own = read(stores.session, key);
  if (own !== null) return { raw: own, fromMirror: false };
  const mirrored = read(stores.local, key);
  if (mirrored === null) return null;
  let envelope: z.infer<typeof MirrorSchema> | null = null;
  try {
    const parsed = MirrorSchema.safeParse(JSON.parse(mirrored));
    envelope = parsed.success ? parsed.data : null;
  } catch { envelope = null; }
  if (!envelope || now.getTime() >= envelope.expiresAt) {
    drop(stores.local, key);
    return null;
  }
  write(stores.session, key, envelope.value);
  return { raw: envelope.value, fromMirror: true };
}

function removeEverywhere(stores: AnonStores, key: string) {
  drop(stores.session, key);
  drop(stores.local, key);
}

/** Copies the stored value to the 30-minute mirror. Returns false when there is nothing to mirror or storage refused. */
function mirror(stores: AnonStores, key: string, now: Date): boolean {
  const raw = read(stores.session, key);
  if (raw === null) return false;
  return write(stores.local, key, JSON.stringify({ expiresAt: now.getTime() + MIRROR_TTL_MS, value: raw }));
}

// ---------- Draft storage ----------

export type DraftLoad =
  | { status: "ok"; draft: AnonDraft }
  | { status: "none" }
  | { status: "expired" }
  | { status: "invalid" }
  | { status: "version-mismatch" }
  /** The library changed since the draft was made. The draft is kept so the person can regenerate or sign up anyway. */
  | { status: "library-mismatch"; draft: AnonDraft };

export function saveAnonDraft(stores: AnonStores, draft: AnonDraft): boolean {
  return write(stores.session, ANON_DRAFT_KEY, JSON.stringify(AnonDraftSchema.parse(draft)));
}

/**
 * Reads and validates the draft. Expired, unreadable and old-format drafts are deleted. With `libraryVersion`, a draft
 * made against a different library is refused (and kept).
 */
export function loadAnonDraft(stores: AnonStores, opts: { now: Date; libraryVersion?: string }): DraftLoad {
  const found = readRaw(stores, ANON_DRAFT_KEY, opts.now);
  if (!found) return { status: "none" };
  let json: unknown;
  try { json = JSON.parse(found.raw); } catch { json = undefined; }
  if (json === undefined || json === null || typeof json !== "object") {
    removeEverywhere(stores, ANON_DRAFT_KEY);
    return { status: "invalid" };
  }
  if ((json as { version?: unknown }).version !== ANON_DRAFT_VERSION) {
    removeEverywhere(stores, ANON_DRAFT_KEY);
    return { status: "version-mismatch" };
  }
  const parsed = AnonDraftSchema.safeParse(json);
  if (!parsed.success) {
    removeEverywhere(stores, ANON_DRAFT_KEY);
    return { status: "invalid" };
  }
  const draft = parsed.data;
  const created = Date.parse(draft.createdAt);
  if (created > opts.now.getTime() + FUTURE_SKEW_MS) {
    removeEverywhere(stores, ANON_DRAFT_KEY);
    return { status: "invalid" };
  }
  if (isDraftExpired(draft, opts.now)) {
    removeEverywhere(stores, ANON_DRAFT_KEY);
    return { status: "expired" };
  }
  if (opts.libraryVersion !== undefined && draft.libraryVersion !== opts.libraryVersion) return { status: "library-mismatch", draft };
  return { status: "ok", draft };
}

/** Deletes the draft from both stores: after a successful import, or when the person discards it. */
export const clearAnonDraft = (stores: AnonStores) => removeEverywhere(stores, ANON_DRAFT_KEY);

// ---------- Profile storage ----------

export function saveAnonProfile(stores: AnonStores, input: AnonProfileInput): AnonProfile {
  const profile = AnonProfileSchema.parse(input);
  write(stores.session, ANON_PROFILE_KEY, JSON.stringify(profile));
  return profile;
}

export function loadAnonProfile(stores: AnonStores, now: Date): AnonProfile | null {
  const found = readRaw(stores, ANON_PROFILE_KEY, now);
  if (!found) return null;
  try {
    const parsed = AnonProfileSchema.safeParse(JSON.parse(found.raw));
    if (parsed.success) return parsed.data;
  } catch { /* fall through to delete */ }
  removeEverywhere(stores, ANON_PROFILE_KEY);
  return null;
}

export const clearAnonProfile = (stores: AnonStores) => removeEverywhere(stores, ANON_PROFILE_KEY);

// ---------- Pending intent ----------

export function serializePendingIntent(input: PendingIntentInput, now: Date = new Date()): string {
  return JSON.stringify(PendingIntentSchema.parse({ createdAt: now.toISOString(), ...input }));
}

/** Null for anything unreadable, unknown, or older than a day. `returnTo` always comes back same-origin and relative. */
export function parsePendingIntent(raw: unknown, now: Date): PendingIntent | null {
  let json: unknown = raw;
  if (typeof raw === "string") {
    try { json = JSON.parse(raw); } catch { return null; }
  }
  const parsed = PendingIntentSchema.safeParse(json);
  if (!parsed.success) return null;
  const age = now.getTime() - Date.parse(parsed.data.createdAt);
  if (age >= INTENT_TTL_MS || age < -FUTURE_SKEW_MS) return null;
  return parsed.data;
}

export function savePendingIntent(stores: AnonStores, input: PendingIntentInput, now: Date): boolean {
  return write(stores.session, PENDING_INTENT_KEY, serializePendingIntent(input, now));
}

export function loadPendingIntent(stores: AnonStores, now: Date): PendingIntent | null {
  const found = readRaw(stores, PENDING_INTENT_KEY, now);
  if (!found) return null;
  const intent = parsePendingIntent(found.raw, now);
  if (!intent) removeEverywhere(stores, PENDING_INTENT_KEY);
  return intent;
}

export const clearPendingIntent = (stores: AnonStores) => removeEverywhere(stores, PENDING_INTENT_KEY);

// ---------- Signup carry-through ----------

/**
 * Call when signup starts: copies the draft, profile and pending intent into localStorage for 30 minutes so an email
 * link opened in a new tab can find them. Returns which items were mirrored.
 */
export function mirrorForSignup(stores: AnonStores, now: Date): { draft: boolean; profile: boolean; intent: boolean } {
  return {
    draft: mirror(stores, ANON_DRAFT_KEY, now),
    profile: mirror(stores, ANON_PROFILE_KEY, now),
    intent: mirror(stores, PENDING_INTENT_KEY, now),
  };
}

/** Removes the mirror only (for example when signup is abandoned). The session copy stays. */
export function dropMirror(stores: AnonStores): void {
  for (const key of [ANON_DRAFT_KEY, ANON_PROFILE_KEY, PENDING_INTENT_KEY]) drop(stores.local, key);
}

/** After a completed import: nothing anonymous may remain on the device. */
export function clearAllAnonState(stores: AnonStores): void {
  for (const key of [ANON_DRAFT_KEY, ANON_PROFILE_KEY, PENDING_INTENT_KEY]) removeEverywhere(stores, key);
}
