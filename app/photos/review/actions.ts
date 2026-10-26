"use server";

import { revalidatePath, updateTag } from "next/cache";
import { z } from "zod";
import { requireMember } from "@/lib/auth/access";
import { curatorDenial } from "@/lib/auth/curator";
import { getBlobStore } from "@/lib/blob";
import { rejectLibraryCandidates, removeLibraryPhoto as removeLibraryPhotoRow, setLibraryCover as setLibraryCoverRow, undoLibraryRejection as undoLibraryRejectionRow } from "@/lib/human/library-photos";
import { LIBRARY_PHOTOS_TAG } from "@/lib/library-photos/tags";
import { loadCandidates } from "@/lib/photos/candidates";
import { isPhotoUid } from "@/lib/photos/keys";
import { libraryPhotoFetch } from "@/lib/photos/remote-seam";
import { displayName } from "@/lib/schemas";
import { getData, getDb } from "@/lib/server/context";
import { APPROVE_BATCH_MAX, approveBatch, listPendingKeys as listPendingKeyRows, PENDING_KEYS_MAX, REJECT_BATCH_MAX, type ItemRef, type ItemResult } from "@/lib/server/library-review";

/**
 * Server actions for library photo review. Every action starts with curatorDenial() (signed-in member, review window
 * open, photo writes allowed, curator), then validates its input, then works. The client only ever names a candidate
 * as {kind, slug, key}: the URL, licence and credit come from data/photo-candidates.json on the server. Writes go
 * through lib/human/library-photos.ts only. The route segment limit (maxDuration) lives on app/photos/review/page.tsx.
 */

type Failure = { ok: false; error: string };
const fail = (error: string): Failure => ({ ok: false, error });
const INVALID = "That request was not valid.";

const Kind = z.enum(["recipe", "ingredient"]);
const Item = z.object({
  kind: Kind,
  slug: z.string().min(1).max(160).regex(/^[a-z0-9][a-z0-9-]*$/),
  key: z.string().min(1).max(500).regex(/^(commons|openverse):.+/),
}).strict();
const Filter = z.object({
  kind: z.enum(["all", "recipe", "ingredient", "recipes", "ingredients"]).optional(),
  q: z.string().max(120).optional(),
  pendingOnly: z.boolean().optional(),
  onlyWithoutPhoto: z.boolean().optional(),
}).strict();
const dedupe = (items: ItemRef[]): ItemRef[] => [...new Map(items.map((i) => [`${i.kind}\u0000${i.slug}\u0000${i.key}`, i] as const)).values()];
const ApproveInput = z.object({ items: z.array(Item).min(1).max(APPROVE_BATCH_MAX) }).strict();
const RejectInput = z.object({ items: z.array(Item).min(1).max(REJECT_BATCH_MAX) }).strict();
const Uid = z.string().refine(isPhotoUid);

function refreshReview(libraryChanged: boolean) {
  if (libraryChanged) updateTag(LIBRARY_PHOTOS_TAG);
  revalidatePath("/photos/review");
}

export async function listPendingKeys(filter: z.input<typeof Filter> = {}): Promise<{ ok: true; keys: ItemRef[]; truncated: boolean } | Failure> {
  const denied = await curatorDenial();
  if (denied) return denied;
  const parsed = Filter.safeParse(filter);
  if (!parsed.success) return fail(INVALID);
  const kind = parsed.data.kind === "recipes" ? "recipe" : parsed.data.kind === "ingredients" ? "ingredient" : parsed.data.kind;
  const data = getData();
  const names = {
    recipes: new Map([...data.recipes.values()].filter((r) => r.kind === "recipe").map((r) => [r.slug, r.name] as const)),
    ingredients: new Map([...data.ingredients.values()].map((i) => [i.slug, displayName(i)] as const)),
  };
  const keys = await listPendingKeyRows(await getDb(), loadCandidates(process.cwd()), names, { ...parsed.data, kind }, PENDING_KEYS_MAX + 1);
  return { ok: true, keys: keys.slice(0, PENDING_KEYS_MAX), truncated: keys.length > PENDING_KEYS_MAX };
}

export async function approveLibraryBatch(input: z.input<typeof ApproveInput>): Promise<{ ok: true; results: ItemResult[] } | Failure> {
  const denied = await curatorDenial();
  if (denied) return denied;
  const parsed = ApproveInput.safeParse(input);
  if (!parsed.success) return fail(`Approve between 1 and ${APPROVE_BATCH_MAX} photos at a time.`);
  const member = await requireMember();
  const result = await approveBatch(await getDb(), getBlobStore(), loadCandidates(process.cwd()), dedupe(parsed.data.items), {
    personId: member.personId, fetchImpl: libraryPhotoFetch(process.env),
  });
  if (result.ok && result.results.some((r) => r.status === "approved")) refreshReview(true);
  return result;
}

export async function rejectLibraryBatch(input: z.input<typeof RejectInput>): Promise<{ ok: true; rejected: number } | Failure> {
  const denied = await curatorDenial();
  if (denied) return denied;
  const parsed = RejectInput.safeParse(input);
  if (!parsed.success) return fail(`Reject between 1 and ${REJECT_BATCH_MAX} photos at a time.`);
  const member = await requireMember();
  const file = loadCandidates(process.cwd());
  // Only candidates the server lists can be rejected; anything else is ignored rather than recorded.
  const listed = dedupe(parsed.data.items).filter((i) => (file[i.kind === "recipe" ? "recipes" : "ingredients"][i.slug] ?? []).some((c) => c.key === i.key));
  const rejected = await rejectLibraryCandidates(await getDb(), listed.map((i) => ({ subjectKind: i.kind, subjectSlug: i.slug, candidateKey: i.key })), member.personId);
  refreshReview(false);
  return { ok: true, rejected };
}

export async function removeLibraryPhoto(uid: string): Promise<{ ok: true } | Failure> {
  const denied = await curatorDenial();
  if (denied) return denied;
  if (!Uid.safeParse(uid).success) return fail(INVALID);
  const member = await requireMember();
  if (!(await removeLibraryPhotoRow(await getDb(), getBlobStore(), uid, member.personId))) return fail("That photo is already gone.");
  refreshReview(true);
  return { ok: true };
}

export async function setLibraryCover(uid: string): Promise<{ ok: true } | Failure> {
  const denied = await curatorDenial();
  if (denied) return denied;
  if (!Uid.safeParse(uid).success) return fail(INVALID);
  if (!(await setLibraryCoverRow(await getDb(), uid))) return fail("That photo is no longer in the library.");
  refreshReview(true);
  return { ok: true };
}

export async function undoLibraryRejection(item: z.input<typeof Item>): Promise<{ ok: true } | Failure> {
  const denied = await curatorDenial();
  if (denied) return denied;
  const parsed = Item.safeParse(item);
  if (!parsed.success) return fail(INVALID);
  const { kind, slug, key } = parsed.data;
  if (!(await undoLibraryRejectionRow(await getDb(), { subjectKind: kind, subjectSlug: slug, candidateKey: key }))) return fail("That photo was not rejected.");
  refreshReview(false);
  return { ok: true };
}
