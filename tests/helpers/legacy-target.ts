import * as s from "../../lib/db/schema";
import type { DbHandle } from "./db";

const at = "2026-11-02T00:00:00.000Z";

/**
 * Library rows (recipes fixture and new-name, ingredient fixture, habit fixture), the household "mine" with an owner, a
 * member and an unverified owner, and two neighbouring households that hold data of their own.
 */
export async function seedLegacyTarget(h: Pick<DbHandle, "db" | "client">) {
  await h.db.insert(s.ingredients).values({
    id: 1, slug: "fixture", name: "Fixture", aliases: [], state: "ready", kcal: 1, proteinG: 0, carbsG: 0, fatG: 0, fibreG: 0,
    source: "USDA", sourceId: "fixture", aisle: "test", whereToBuy: [], isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
  });
  await h.db.insert(s.recipes).values(["fixture", "new-name"].map((slug, i) => ({
    id: i + 1, slug, name: slug, kind: "recipe" as const, family: "test", mealSlots: ["lunch"], cuisine: "test", isIndian: false, servings: 1,
    prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
  })));
  await h.db.insert(s.habits).values({ id: 1, slug: "fixture", title: "Fixture", category: "test", evidenceGrade: "practical", evidenceNote: "Synthetic", defaultOn: false });
  await h.db.insert(s.households).values([{ id: "mine", name: "Mine" }, { id: "other-a", name: "A" }, { id: "other-b", name: "B" }]);
  await h.db.insert(s.authUsers).values(["owner", "member", "unverified", "a", "b"].map((id) => ({ id, name: id, email: `${id}@example.test`, emailVerified: id !== "unverified" })));
  const profile = (id: number, householdId: string, name: string) => ({
    id, householdId, name, sex: "other" as const, birthDate: "2001-01-01", heightCm: 170, weightKg: 70, activityLevel: "light" as const, dietFlags: [],
  });
  await h.db.insert(s.people).values([
    profile(1, "mine", "Starter profile"), profile(2, "mine", "Member profile"), profile(3, "other-a", "Neighbour A"), profile(4, "other-b", "Neighbour B"),
  ]);
  await h.db.insert(s.householdMembers).values([
    { householdId: "mine", userId: "owner", role: "owner", personId: 1 }, { householdId: "mine", userId: "member", role: "member", personId: 2 },
    { householdId: "mine", userId: "unverified", role: "owner", personId: null },
    { householdId: "other-a", userId: "a", role: "owner", personId: 3 }, { householdId: "other-b", userId: "b", role: "owner", personId: 4 },
  ]);
  await h.client.exec("select setval(pg_get_serial_sequence('people', 'id'), 100)");
  // The neighbours hold data of their own that an import must never touch.
  for (const [householdId, personId, n] of [["other-a", 3, "a"], ["other-b", 4, "b"]] as const) {
    await h.db.insert(s.recipeFeedback).values({ householdId, recipeId: 1, rating: 3, notes: `neighbour ${n}`, uid: `neighbour-${n}` });
    await h.db.insert(s.pantry).values({ householdId, ingredientId: 1, have: true, alwaysStock: false });
    await h.db.insert(s.savedViews).values({ householdId, list: "recipes", name: n, query: "", uid: `neighbour-view-${n}` });
    await h.db.insert(s.habitLog).values({ personId, habitId: 1, date: "2026-11-02", done: true });
    await h.db.insert(s.syncState).values({ householdId, dataClass: "recipe-feedback", changedAt: at });
  }
}
