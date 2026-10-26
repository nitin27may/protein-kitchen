import sharp from "sharp";
import type { Db } from "../../lib/db/client";
import type { BlobStore } from "../../lib/blob/types";
import * as s from "../../lib/db/schema";
import { approveLibraryCandidate, type LibraryApproveInput } from "../../lib/human/library-photos";

export const libraryCredit = { title: "Falafel", author: "A. Person", licence: "CC BY 4.0", licenceUrl: "https://creativecommons.org/licenses/by/4.0/", sourceUrl: "https://commons.example.test/falafel" };

export const fixtureImage = (colour = "#c87828") => sharp({ create: { width: 1600, height: 1200, channels: 3, background: colour } }).jpeg().toBuffer();

export async function addRecipe(db: Db, slug: string): Promise<number> {
  const [row] = await db.insert(s.recipes)
    .values({ slug, name: slug, kind: "recipe", family: "bowls", mealSlots: ["lunch"], cuisine: "indian", isIndian: true, servings: 2, prepMin: 5, activeMin: 10, totalMin: 15, equipment: [], tags: [], fridgeDays: 2 })
    .returning({ id: s.recipes.id });
  return row!.id;
}

export const addIngredient = (db: Db, slug: string) => db.insert(s.ingredients).values({ slug, name: slug, aliases: [], state: "ready", kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0, source: "USDA", sourceId: "x", aisle: "dairy", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: true });

/** Approves one library photo through the L1 writer (the only writer) and returns its uid. */
export async function approveFixture(db: Db, store: BlobStore, over: Partial<LibraryApproveInput> = {}): Promise<string> {
  const result = await approveLibraryCandidate(db, store, {
    candidateKey: "commons:one", origin: "commons", subjectKind: "recipe", subjectSlug: "falafel-bowl", bytes: await fixtureImage(),
    credit: libraryCredit, licenceCheckedAt: "2026-10-01T00:00:00.000Z", personId: null, ...over,
  });
  if (result.status !== "approved") throw new Error(`fixture approval failed: ${result.status}`);
  return result.uid;
}
