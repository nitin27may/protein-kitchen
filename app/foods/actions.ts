"use server";

import { revalidatePath } from "next/cache";
import { actionDenial, requireMember } from "@/lib/auth/access";
import { HouseholdAccessError } from "@/lib/auth/household";
import { memberHouseholdAccess, requireHouseholdProfile } from "@/lib/auth/household-access";
import { getBlobStore } from "@/lib/blob";
import { photoWritesEnabled } from "@/lib/blob/config";
import type { Db } from "@/lib/db/client";
import { buildFoodRecord } from "@/lib/foods/form";
import {
  archiveHouseholdFood, attachFoodLabelPhoto, createHouseholdFood, deleteHouseholdFood, FoodDataError, restoreHouseholdFood, updateHouseholdFood,
  type FoodScope,
} from "@/lib/human/household-foods";
import { MAX_UPLOAD_BYTES, PhotoError } from "@/lib/photos/process";
import { FoodSaveInput, type FoodSaveData } from "@/lib/schemas/food-draft";
import { getDb } from "@/lib/server/context";
import { getHouseholdFood } from "@/lib/server/food-queries";

/**
 * The owner's master list of foods. Every action checks the owner role first, resolves the household from the session
 * (never from the request), recomputes the per-100 g figures from the label numbers on the server, and refuses what the
 * label rules call an error. Members and other households never reach a writer.
 */
export type FoodResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; fields?: Record<string, string> };

const fail = (error: string, fields?: Record<string, string>): { ok: false; error: string; fields?: Record<string, string> } => ({ ok: false, error, ...(fields ? { fields } : {}) });

const PREVIEW_PHOTO_MESSAGE = "Photo changes are disabled in preview deployments.";

const MESSAGES: Partial<Record<FoodDataError["code"], string>> = {
  "duplicate-barcode": "You already have a food with this barcode.",
  "has-entries": "This food is in the food log, so it cannot be deleted. Archive it instead.",
  "not-found": "That food is not in your household.",
  "person-not-found": "Finish your household profile before continuing.",
};

const NOT_FOUND = "That food is not in your household.";
const validUid = (uid: unknown): uid is string => typeof uid === "string" && uid !== "" && uid.length <= 100;

/** Turns the refusals people can cause into words. Anything else is a bug or an outage and is rethrown. */
async function guarded<T extends object>(task: () => Promise<FoodResult<T>>): Promise<FoodResult<T>> {
  try {
    return await task();
  } catch (e) {
    if (e instanceof HouseholdAccessError) return fail(e.message);
    if (e instanceof FoodDataError) return fail(MESSAGES[e.code] ?? e.message);
    throw e;
  }
}

async function scopeOf(): Promise<{ db: Db; scope: FoodScope }> {
  const member = await requireMember();
  const db = await getDb();
  const access = await memberHouseholdAccess(db, member);
  return { db, scope: { householdId: access.householdId, personId: requireHouseholdProfile(access) } };
}

function parseSave(formData: FormData): { save: FoodSaveData } | { error: string; fields: Record<string, string> } {
  const raw = formData.get("save");
  let json: unknown;
  try { json = JSON.parse(typeof raw === "string" ? raw : ""); } catch { return { error: "The food could not be read. Reload and try again.", fields: {} }; }
  const parsed = FoodSaveInput.safeParse(json);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]!.message, fields: Object.fromEntries(parsed.error.issues.map((i) => [i.path.join(".") || "form", i.message])) };
  }
  return { save: parsed.data as FoodSaveData };
}

async function readPhoto(formData: FormData): Promise<{ bytes: Uint8Array | null } | { error: string }> {
  const file = formData.get("photo");
  if (!(file instanceof File) || file.size === 0) return { bytes: null };
  if (file.size > MAX_UPLOAD_BYTES) return { error: "That photo is larger than 8 MB." };
  return { bytes: new Uint8Array(await file.arrayBuffer()) };
}

function refresh() {
  revalidatePath("/foods", "layout");
}

/** Stores the label photo. Returns the words to show when the photo cannot be used; leftover storage files are only logged. */
async function storePhoto(db: Db, scope: FoodScope, uid: string, bytes: Uint8Array): Promise<string | null> {
  try {
    const { staleKeys } = await attachFoodLabelPhoto(db, getBlobStore(), scope, uid, bytes);
    if (staleKeys.length) console.error("Label photo storage cleanup left files behind.", { count: staleKeys.length });
    return null;
  } catch (e) {
    if (e instanceof PhotoError) return e.message;
    throw e;
  }
}

/** A food saved as LABEL whose photo failed would claim a label nobody can see: take it back out. */
async function takeBack(db: Db, scope: FoodScope, uid: string) {
  try { await deleteHouseholdFood(db, getBlobStore(), scope, uid); } catch { console.error("A food saved without its label photo could not be removed."); }
}

/** Adds a food from a label. The label photo, if any, arrives in the same request; with one the source is LABEL, without it MANUAL. */
export async function createFood(formData: FormData): Promise<FoodResult<{ uid: string }>> {
  const denied = await actionDenial("owner");
  if (denied) return denied;
  const parsed = parseSave(formData);
  if ("error" in parsed) return fail(parsed.error, parsed.fields);
  const photo = await readPhoto(formData);
  if ("error" in photo) return fail(photo.error);
  if (photo.bytes && !photoWritesEnabled()) return fail(PREVIEW_PHOTO_MESSAGE);
  return guarded(async () => {
    const { db, scope } = await scopeOf();
    const built = buildFoodRecord(parsed.save.draft, { hasLabelPhoto: photo.bytes !== null, checkedAgainstLabel: parsed.save.checkedAgainstLabel, now: new Date() });
    if (!built.ok) return fail(built.message, built.fieldErrors);
    const { uid } = await createHouseholdFood(db, scope, built.input);
    if (photo.bytes) {
      let problem: string | null;
      try { problem = await storePhoto(db, scope, uid, photo.bytes); } catch (e) { await takeBack(db, scope, uid); throw e; }
      if (problem) { await takeBack(db, scope, uid); return fail(problem); }
    }
    refresh();
    return { ok: true, uid };
  });
}

/** Replaces the confirmed record of a food. Past entries keep pointing at it, so the number of entries it changes is returned. */
export async function updateFood(uid: string, formData: FormData): Promise<FoodResult<{ uid: string; affectedEntries: number }>> {
  const denied = await actionDenial("owner");
  if (denied) return denied;
  if (!validUid(uid)) return fail(NOT_FOUND);
  const parsed = parseSave(formData);
  if ("error" in parsed) return fail(parsed.error, parsed.fields);
  const photo = await readPhoto(formData);
  if ("error" in photo) return fail(photo.error);
  if (photo.bytes && !photoWritesEnabled()) return fail(PREVIEW_PHOTO_MESSAGE);
  return guarded(async () => {
    const { db, scope } = await scopeOf();
    const existing = await getHouseholdFood(db, scope.householdId, uid);
    if (!existing) return fail(NOT_FOUND);
    const built = buildFoodRecord(parsed.save.draft, { hasLabelPhoto: existing.hasLabelPhoto || photo.bytes !== null, checkedAgainstLabel: parsed.save.checkedAgainstLabel, now: new Date() });
    if (!built.ok) return fail(built.message, built.fieldErrors);
    // The photo goes first so the stored source (LABEL) never outruns the photo that backs it.
    const problem = photo.bytes ? await storePhoto(db, scope, uid, photo.bytes) : null;
    if (problem) return fail(problem);
    const { affectedEntries } = await updateHouseholdFood(db, scope, uid, built.input);
    refresh();
    return { ok: true, uid, affectedEntries };
  });
}

/** Hides a food from pickers. Past entries are untouched. */
export async function archiveFood(uid: string): Promise<FoodResult> {
  const denied = await actionDenial("owner");
  if (denied) return denied;
  if (!validUid(uid)) return fail(NOT_FOUND);
  return guarded(async () => {
    const { db, scope } = await scopeOf();
    await archiveHouseholdFood(db, scope, uid);
    refresh();
    return { ok: true };
  });
}

export async function restoreFood(uid: string): Promise<FoodResult> {
  const denied = await actionDenial("owner");
  if (denied) return denied;
  if (!validUid(uid)) return fail(NOT_FOUND);
  return guarded(async () => {
    const { db, scope } = await scopeOf();
    await restoreHouseholdFood(db, scope, uid);
    refresh();
    return { ok: true };
  });
}

/** Removes a food no log entry uses. A food with entries is refused: archive it instead. */
export async function deleteFood(uid: string): Promise<FoodResult> {
  const denied = await actionDenial("owner");
  if (denied) return denied;
  if (!validUid(uid)) return fail(NOT_FOUND);
  return guarded(async () => {
    const { db, scope } = await scopeOf();
    const { staleKeys } = await deleteHouseholdFood(db, getBlobStore(), scope, uid);
    if (staleKeys.length) console.error("Label photo storage cleanup left files behind.", { count: staleKeys.length });
    refresh();
    return { ok: true };
  });
}

/**
 * Replaces the label photo of a food that already has one. A typed food gets its photo through Edit, so the numbers are
 * checked against the pack before the food is called "from label".
 */
export async function attachLabelPhoto(uid: string, formData: FormData): Promise<FoodResult<{ uid: string }>> {
  const denied = await actionDenial("owner");
  if (denied) return denied;
  if (!validUid(uid)) return fail(NOT_FOUND);
  const photo = await readPhoto(formData);
  if ("error" in photo) return fail(photo.error);
  if (!photo.bytes) return fail("Choose a photo first.");
  if (!photoWritesEnabled()) return fail(PREVIEW_PHOTO_MESSAGE);
  const bytes = photo.bytes;
  return guarded(async () => {
    const { db, scope } = await scopeOf();
    const existing = await getHouseholdFood(db, scope.householdId, uid);
    if (!existing) return fail(NOT_FOUND);
    if (existing.source === "MANUAL") return fail("Add the photo from Edit, so you check the numbers against the label at the same time.");
    const problem = await storePhoto(db, scope, uid, bytes);
    if (problem) return fail(problem);
    refresh();
    return { ok: true, uid };
  });
}
