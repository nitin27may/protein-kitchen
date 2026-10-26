import { createSqliteSource } from "./sqlite-source";
import * as s from "../../lib/db/sqlite-schema";

const at = "2026-10-23T14:00:00.000+02:00";

/**
 * The all-table synthetic source plus a second person, renamed/unknown library slugs and plan rows that exercise remapping.
 * Library slugs: recipes fixture, old-name (renamed to new-name) and gone-recipe; ingredients fixture and gone-ingredient;
 * habits fixture and gone-habit. Every value is synthetic.
 */
export function createLegacySource() {
  const source = createSqliteSource();
  const { db } = source;
  db.transaction((tx) => {
    tx.insert(s.recipes).values([201, 202].map((id) => ({
      id, slug: id === 201 ? "old-name" : "gone-recipe", name: `Fixture ${id}`, kind: "recipe" as const, family: "test", mealSlots: ["dinner"],
      cuisine: "test", isIndian: false, servings: 1, prepMin: 1, activeMin: 1, totalMin: 2, equipment: [], tags: [], fridgeDays: 1,
    }))).run();
    tx.insert(s.ingredients).values({
      id: 101, slug: "gone-ingredient", name: "Gone", aliases: [], state: "ready", kcal: 1, proteinG: 1, carbsG: 1, fatG: 1, fibreG: 1,
      source: "CNF", sourceId: "gone", aisle: "test", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
    }).run();
    tx.insert(s.habits).values({ id: 701, slug: "gone-habit", title: "Gone", category: "test", evidenceGrade: "practical", evidenceNote: "Synthetic", defaultOn: false }).run();
    tx.insert(s.people).values({
      id: 301, name: "Second synthetic cook", sex: "female", birthDate: "1990-05-05", heightCm: 160, weightKg: 55,
      activityLevel: "moderate", proteinGPerKg: 1.2, dietFlags: ["vegetarian"],
    }).run();
    // One feedback row has no uid or timestamps, like rows written before human-data bookkeeping existed.
    tx.insert(s.recipeFeedback).values([
      { recipeId: 201, status: "tested", rating: 5, favourite: false, banned: false, notes: "Renamed recipe note", testedAt: at, uid: null, createdAt: null, updatedAt: null },
      { recipeId: 202, status: "draft", rating: null, favourite: true, banned: false, notes: null },
    ]).run();
    tx.insert(s.preferences).values([
      { id: 311, personId: 301, ingredientId: 100, kind: "avoid" }, { id: 312, personId: 301, recipeId: 202, kind: "pin" },
      { id: 313, personId: 301, recipeId: 201, kind: "like" },
    ]).run();
    tx.update(s.planSetups).set({ personIds: [300, 301] }).run();
    tx.insert(s.planSlots).values([
      { id: 601, planId: 500, date: "2026-11-03", slot: "lunch", recipeId: 201, locked: false, isLeftover: false },
      { id: 602, planId: 500, date: "2026-11-04", slot: "lunch", recipeId: 202, locked: false, isLeftover: false },
    ]).run();
    tx.insert(s.planSlotPortions).values([{ planSlotId: 601, personId: 301, servings: 2 }, { planSlotId: 601, personId: 300, servings: 1 }]).run();
    tx.insert(s.habitLog).values({ date: "2026-11-03", personId: 301, habitId: 701, done: false }).run();
    tx.insert(s.prepTaskState).values({ date: "2026-11-03", taskKey: "night:999:2026-11-03:recipe:fixture:0", done: true }).run();
    tx.insert(s.pantry).values({ ingredientId: 101, have: true, alwaysStock: true }).run();
    tx.insert(s.savedViews).values({ id: 631, list: "ingredients", name: "No uid", query: "x=1", isDefault: false }).run();
    tx.insert(s.planPartState).values({ planId: 500, componentSlug: "old-name", mode: "buy", updatedAt: at }).run();
  });
  return source;
}
