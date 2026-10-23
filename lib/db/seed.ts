import { eq, inArray } from "drizzle-orm";
import type { DataSet } from "../data/load";
import { anchorIngredients, perServing, proteinByIngredient } from "../nutrition/macros";
import type { RecipeTotals } from "../nutrition/macros";
import { autoTags } from "../nutrition/tags";
import type { Db } from "./client";
import * as s from "./schema";

export interface SeedReport {
  ingredients: number;
  recipes: number;
  techniques: number;
  habits: number;
  anchors: number;
  /** Rows in the database with no matching file in /data. Reported, never deleted. */
  staleIngredients: string[];
  staleRecipes: string[];
}

/** Rebuilds all content tables from /data. User state tables are never written. */
export function seedDatabase(db: Db, data: DataSet): SeedReport {
  return db.transaction((tx) => {
    // Ingredients
    for (const ing of data.ingredients.values()) {
      const row = {
        slug: ing.slug,
        name: ing.name,
        aliases: ing.aliases,
        state: ing.state,
        cookedYield: ing.cooked_yield ?? null,
        kcal: ing.per100g.kcal,
        proteinG: ing.per100g.protein_g,
        carbsG: ing.per100g.carbs_g,
        fatG: ing.per100g.fat_g,
        fibreG: ing.per100g.fibre_g,
        source: ing.source,
        sourceId: ing.source_id,
        aisle: ing.aisle,
        packSizeG: ing.pack_size_g,
        whereToBuy: ing.where_to_buy,
        isPantryStaple: ing.is_pantry_staple,
        containsOnionGarlic: ing.contains_onion_garlic,
        isDairy: ing.is_dairy,
        image: ing.image ?? null,
        imageCredit: ing.image_credit ?? null,
      };
      tx.insert(s.ingredients).values(row).onConflictDoUpdate({ target: s.ingredients.slug, set: row }).run();
    }
    const ingId = new Map(tx.select({ id: s.ingredients.id, slug: s.ingredients.slug }).from(s.ingredients).all().map((r) => [r.slug, r.id]));

    for (const [slug, m] of Object.entries(data.micros)) {
      const id = ingId.get(slug);
      if (id === undefined) continue;
      const row = { ingredientId: id, source: m.source, sourceId: m.source_id, per100g: m.per100g, notReported: m.not_reported };
      tx.insert(s.ingredientMicros).values(row).onConflictDoUpdate({ target: s.ingredientMicros.ingredientId, set: row }).run();
    }

    // Techniques
    for (const [slug, t] of data.techniques) {
      const row = { slug, title: t.title, bodyMd: t.body, tags: t.tags };
      tx.insert(s.techniques).values(row).onConflictDoUpdate({ target: s.techniques.slug, set: row }).run();
    }
    const techId = new Map(tx.select({ id: s.techniques.id, slug: s.techniques.slug }).from(s.techniques).all().map((r) => [r.slug, r.id]));

    // Habits
    for (const h of data.habits) {
      const row = {
        slug: h.slug,
        title: h.title,
        category: h.category,
        evidenceGrade: h.evidence_grade,
        evidenceNote: h.evidence_note,
        sourceUrl: h.source_url,
        caution: h.caution,
        defaultOn: h.default_on,
      };
      tx.insert(s.habits).values(row).onConflictDoUpdate({ target: s.habits.slug, set: row }).run();
    }

    // Recipes (first pass, so components can reference each other by id)
    for (const r of data.recipes.values()) {
      const row = {
        slug: r.slug,
        name: r.name,
        kind: r.kind,
        family: r.family,
        mealSlots: r.meal_slots,
        cuisine: r.cuisine,
        isIndian: r.is_indian,
        servings: r.servings,
        prepMin: r.prep_min,
        activeMin: r.active_min,
        totalMin: r.total_min,
        equipment: r.equipment,
        tags: r.tags,
        fridgeDays: r.fridge_days,
        image: r.image ?? null,
        imageCredit: r.image_credit ?? null,
      };
      tx.insert(s.recipes).values(row).onConflictDoUpdate({ target: s.recipes.slug, set: row }).run();
    }
    const recId = new Map(tx.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes).all().map((r) => [r.slug, r.id]));
    const seededIds = [...data.recipes.keys()].map((slug) => recId.get(slug)).filter((v): v is number => v !== undefined);

    // Feedback rows exist for every recipe but are never overwritten.
    for (const id of seededIds) tx.insert(s.recipeFeedback).values({ recipeId: id }).onConflictDoNothing().run();

    // Children are derived, so clear and rebuild.
    for (const table of [s.recipeItems, s.recipeSteps, s.recipeAdvancePrep, s.recipeMacros, s.recipeAnchors] as const) {
      tx.delete(table).where(inArray(table.recipeId, seededIds)).run();
    }

    const memo = new Map<string, RecipeTotals>();
    let anchorRows = 0;
    for (const r of data.recipes.values()) {
      const id = recId.get(r.slug)!;
      r.items.forEach((item, position) => {
        tx.insert(s.recipeItems)
          .values({
            recipeId: id,
            position,
            ingredientId: "ingredient" in item ? ingId.get(item.ingredient) ?? null : null,
            componentId: "component" in item ? recId.get(item.component) ?? null : null,
            grams: item.grams,
            displayQty: "ingredient" in item ? item.display_qty ?? null : null,
            displayUnit: "ingredient" in item ? item.display_unit ?? null : null,
            optional: item.optional ?? false,
          })
          .run();
      });
      r.steps.forEach((step, i) => {
        tx.insert(s.recipeSteps)
          .values({
            recipeId: id,
            stepNo: i + 1,
            text: step.text,
            techniqueId: step.technique ? techId.get(step.technique) ?? null : null,
            timerSec: step.timer_sec ?? null,
          })
          .run();
      });
      for (const prep of r.advance_prep) {
        tx.insert(s.recipeAdvancePrep)
          .values({
            recipeId: id,
            kind: prep.kind,
            ingredientId: prep.ingredient ? ingId.get(prep.ingredient) ?? null : null,
            grams: prep.grams ?? null,
            leadHours: prep.lead_hours,
            instruction: prep.instruction,
          })
          .run();
      }

      const m = perServing(r.slug, data.recipes, data.ingredients, memo);
      tx.insert(s.recipeMacros)
        .values({
          recipeId: id,
          kcal: m.kcal,
          proteinG: m.protein_g,
          carbsG: m.carbs_g,
          fatG: m.fat_g,
          fibreG: m.fibre_g,
          autoTags: r.kind === "recipe" ? autoTags(r, m) : [],
        })
        .run();

      if (r.kind === "recipe") {
        const by = proteinByIngredient(r.slug, data.recipes, data.ingredients);
        const anchors = new Set(anchorIngredients(r.slug, data.recipes, data.ingredients));
        for (const [slug, protein] of by) {
          if (!anchors.has(slug)) continue;
          tx.insert(s.recipeAnchors).values({ recipeId: id, ingredientId: ingId.get(slug)!, proteinG: protein / r.servings }).run();
          anchorRows++;
        }
      }
    }

    const staleIngredients = [...ingId.keys()].filter((slug) => !data.ingredients.has(slug));
    const staleRecipes = [...recId.keys()].filter((slug) => !data.recipes.has(slug));
    return {
      ingredients: data.ingredients.size,
      recipes: data.recipes.size,
      techniques: data.techniques.size,
      habits: data.habits.length,
      anchors: anchorRows,
      staleIngredients,
      staleRecipes,
    };
  });
}

export function recipeIdBySlug(db: Db, slug: string): number | undefined {
  return db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, slug)).get()?.id;
}
