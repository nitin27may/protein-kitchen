import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as s from "../../lib/db/sqlite-schema";

/** Synthetic legacy data in every table, including non-contiguous ids and human-owned metadata. */
export function createSqliteSource() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "protein-kitchen-import-"));
  const file = path.join(directory, "source.db");
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema: s });
  migrate(db, { migrationsFolder: path.resolve("db/migrations") });
  const at = "2026-10-23T14:00:00.000+02:00";
  db.transaction((tx) => {
    tx.insert(s.ingredients).values({
      id: 100, slug: "fixture", name: "Fixture", aliases: ["sample"], state: "ready", kcal: 100.123456789,
      proteinG: 10.25, carbsG: 5, fatG: 2, fibreG: 1, source: "CNF", sourceId: "test", aisle: "test",
      whereToBuy: ["Fixture"], isPantryStaple: true, containsOnionGarlic: false, isDairy: false,
    }).run();
    tx.insert(s.ingredientMicros).values({ ingredientId: 100, source: "CNF", sourceId: "test", per100g: { iron_mg: 2.75 }, notReported: ["zinc_mg"] }).run();
    tx.insert(s.techniques).values({ id: 110, slug: "fixture", title: "Fixture", bodyMd: "Synthetic", tags: [] }).run();
    tx.insert(s.recipes).values({
      id: 200, slug: "fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: ["dinner"],
      cuisine: "test", isIndian: false, servings: 1, prepMin: 1, activeMin: 1, totalMin: 2, equipment: [], tags: [], fridgeDays: 1,
    }).run();
    tx.insert(s.recipeItems).values({ id: 210, recipeId: 200, position: 0, ingredientId: 100, grams: 80, optional: false }).run();
    tx.insert(s.recipeSteps).values({ recipeId: 200, stepNo: 1, text: "Synthetic step", techniqueId: 110, timerSec: 60 }).run();
    tx.insert(s.recipeAdvancePrep).values({ id: 220, recipeId: 200, kind: "soak", ingredientId: 100, grams: 80, leadHours: 8, instruction: "Synthetic prep" }).run();
    tx.insert(s.recipeMacros).values({ recipeId: 200, kcal: 80.0987654312, proteinG: 8.2, carbsG: 4, fatG: 1.6, fibreG: 0.8, autoTags: [] }).run();
    tx.insert(s.recipeAnchors).values({ recipeId: 200, ingredientId: 100, proteinG: 8.2 }).run();
    tx.insert(s.people).values({
      id: 300, name: "Synthetic import fixture", sex: "other", birthDate: "2000-02-29", heightCm: 170, weightKg: 70,
      activityLevel: "light", proteinTargetG: 84, dietFlags: ["vegetarian"],
    }).run();
    tx.insert(s.recipeFeedback).values({
      recipeId: 200, status: "tested", rating: 4, favourite: true, banned: false, notes: "Synthetic human note",
      testedAt: at, uid: "feedback-fixture", createdAt: at, updatedAt: at, createdByPersonId: 300,
    }).run();
    tx.insert(s.preferences).values({ id: 310, personId: 300, ingredientId: 100, kind: "like" }).run();
    tx.insert(s.planSetups).values({
      id: 400, personIds: [300], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"],
      cuisineBalance: 0.5, healthFocus: { lowSugar: true, light: true, nutrientDense: false }, prepStyle: "leftovers",
      shoppingDay: 6, prepDay: 7, createdAt: at,
    }).run();
    tx.insert(s.plans).values({ id: 500, setupId: 400, seed: 42, createdAt: at }).run();
    tx.insert(s.planSlots).values({ id: 600, planId: 500, date: "2026-11-02", slot: "dinner", recipeId: 200, locked: true, isLeftover: true }).run();
    tx.insert(s.planSlotPortions).values({ planSlotId: 600, personId: 300, servings: 1.25 }).run();
    tx.insert(s.habits).values({ id: 700, slug: "fixture", title: "Fixture", category: "test", evidenceGrade: "practical", evidenceNote: "Synthetic", defaultOn: false }).run();
    tx.insert(s.habitLog).values({ date: "2026-11-02", personId: 300, habitId: 700, done: true }).run();
    tx.insert(s.prepTaskState).values({ date: "2026-11-01", taskKey: "night:500:fixture", done: true }).run();
    tx.insert(s.groceryState).values({ planId: 500, ingredientId: 100, checked: true }).run();
    tx.insert(s.planPartState).values({ planId: 500, componentSlug: "fixture", mode: "have", updatedAt: at }).run();
    tx.insert(s.planProgress).values({ planId: 500, step: "prep", doneAt: at }).run();
    tx.insert(s.groceryManual).values({ id: 610, planId: 500, text: "Synthetic item", checked: false }).run();
    tx.insert(s.pantry).values({ ingredientId: 100, have: true, alwaysStock: false }).run();
    tx.insert(s.pushSubscriptions).values({ id: 620, personId: 300, endpoint: "https://example.invalid/push", p256dh: "synthetic", auth: "synthetic", createdAt: at }).run();
    tx.insert(s.reminderLog).values({ date: "2026-11-02", personId: 300, sentAt: at }).run();
    tx.insert(s.savedViews).values({ id: 630, list: "recipes", name: "Fixture", query: "time=15", isDefault: true, uid: "view-fixture", createdAt: at, updatedAt: at, createdByPersonId: 300 }).run();
    tx.insert(s.syncState).values({ dataClass: "recipe-feedback", changedAt: at, exportedAt: "2026-10-23" }).run();
    tx.insert(s.recipeLinks).values({
      id: 640, uid: "link-fixture", recipeId: 200, stepNo: 1, kind: "video", url: "https://example.invalid/fixture",
      title: "Synthetic link", position: 3, createdAt: at, updatedAt: at, createdByPersonId: 300,
    }).run();
    tx.insert(s.photos).values({
      id: 650, uid: "photo-fixture", recipeId: 200, origin: "upload", sha256: "a".repeat(64), width: 640, height: 480,
      isCover: true, title: "Synthetic photo", createdAt: at, updatedAt: at, createdByPersonId: 300,
    }).run();
    tx.insert(s.photoDecisions).values({
      id: 660, uid: "decision-fixture", candidateKey: "commons:fixture", subjectKind: "recipe", subjectSlug: "fixture",
      decision: "rejected", createdAt: at, updatedAt: at, createdByPersonId: 300,
    }).run();
    tx.insert(s.personRoutines).values({
      personId: 300, habitId: 700, days: [1, 3, 5], timeOfDay: "morning", servings: 1, active: true,
      uid: "routine-fixture", createdAt: at, updatedAt: at, createdByPersonId: 300,
    }).run();
    tx.insert(s.planRoutines).values({ planId: 500, personId: 300, habitId: 700, days: [1, 3, 5], timeOfDay: "morning", servings: 1 }).run();
  });
  return {
    file, sqlite, db,
    close() { sqlite.close(); fs.rmSync(directory, { recursive: true }); },
  };
}
