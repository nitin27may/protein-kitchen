import { z } from "zod";
import type { DataSet } from "../data/load";
import type { GroceryIngredient, GroceryRecipe } from "../grocery/aggregate";
import { buildCandidates } from "../planner/candidates";
import type { Candidate } from "../planner/types";

/**
 * Library-only payload for on-device planning. It is built from /data alone (no household feedback, no people, no
 * database), so it is identical for every visitor and can be cached by the browser and a CDN. Browser-safe.
 */

export const ANON_LIBRARY_VERSION = 1;
export const ANON_LIBRARY_PATH = "/api/anon-library";

export interface AnonCandidate extends Omit<Candidate, "ingredients"> {
  /** A set in the planner; an ordered array on the wire so iteration order survives. */
  ingredients: string[];
}

const slug = z.string().min(1).max(120);
const grams = z.number().positive();
const MacrosSchema = z.object({ kcal: z.number(), protein_g: z.number(), carbs_g: z.number(), fat_g: z.number(), fibre_g: z.number() });

const CandidateSchema = z.object({
  slug, name: z.string(), family: z.string(), mealSlots: z.array(z.string()), isIndian: z.boolean(),
  activeMin: z.number(), makeAheadMin: z.number(), perServing: MacrosSchema, anchors: z.array(z.string()),
  ingredients: z.array(z.string()), lowSugar: z.boolean(), light: z.boolean(), nutrientDense: z.boolean(),
  freeSugarG: z.number(), nutrientScore: z.number(), batchFriendly: z.boolean(), fridgeDays: z.number(),
  favourite: z.literal(false), banned: z.literal(false), rating: z.null(), tested: z.literal(false),
});

const RecipeSchema = z.object({
  servings: z.number().positive(),
  items: z.array(z.union([
    z.object({ ingredient: slug, grams }),
    z.object({ component: slug, grams, alt_ingredient: slug.optional() }),
  ])).min(1),
});

const IngredientSchema = z.object({
  name: z.string(), display_name: z.string().optional(), aisle: z.string(),
  state: z.enum(["dry", "cooked", "raw", "ready"]), pack_size_g: z.number().positive().nullable(), is_pantry_staple: z.boolean(),
});

export const AnonLibraryPayloadSchema = z.object({
  v: z.literal(ANON_LIBRARY_VERSION),
  libraryVersion: z.string().min(1),
  candidates: z.array(CandidateSchema),
  recipes: z.record(slug, RecipeSchema),
  ingredients: z.record(slug, IngredientSchema),
});

export type AnonLibraryPayload = {
  v: typeof ANON_LIBRARY_VERSION;
  libraryVersion: string;
  candidates: AnonCandidate[];
  recipes: Record<string, GroceryRecipe>;
  ingredients: Record<string, GroceryIngredient>;
};

export interface AnonLibrary {
  libraryVersion: string;
  candidates: Candidate[];
  recipes: Map<string, GroceryRecipe>;
  ingredients: Map<string, GroceryIngredient>;
}

/** Server side: no feedback, so every candidate starts neutral. */
export function buildAnonLibraryPayload(data: DataSet, libraryVersion: string): AnonLibraryPayload {
  const recipes: Record<string, GroceryRecipe> = {};
  for (const r of data.recipes.values()) {
    if (r.kind === "routine") continue;
    recipes[r.slug] = {
      servings: r.servings,
      items: r.items.map((item) => "ingredient" in item
        ? { ingredient: item.ingredient, grams: item.grams }
        : { component: item.component, grams: item.grams, ...(item.alt_ingredient ? { alt_ingredient: item.alt_ingredient } : {}) }),
    };
  }
  const ingredients: Record<string, GroceryIngredient> = {};
  for (const i of data.ingredients.values()) {
    ingredients[i.slug] = {
      name: i.name, ...(i.display_name ? { display_name: i.display_name } : {}), aisle: i.aisle, state: i.state,
      pack_size_g: i.pack_size_g, is_pantry_staple: i.is_pantry_staple,
    };
  }
  return {
    v: ANON_LIBRARY_VERSION,
    libraryVersion,
    candidates: buildCandidates(data, new Map()).map((c) => ({ ...c, ingredients: [...c.ingredients] })),
    recipes,
    ingredients,
  };
}

/** Client side: validates the payload and restores the planner's types. Throws on a malformed or unknown-version payload. */
export function hydrateAnonLibrary(raw: unknown): AnonLibrary {
  const payload = AnonLibraryPayloadSchema.parse(raw);
  return {
    libraryVersion: payload.libraryVersion,
    candidates: payload.candidates.map((c) => ({ ...c, ingredients: new Set(c.ingredients) })),
    recipes: new Map(Object.entries(payload.recipes)) as Map<string, GroceryRecipe>,
    ingredients: new Map(Object.entries(payload.ingredients)) as Map<string, GroceryIngredient>,
  };
}
