import { and, eq } from "drizzle-orm";
import type { MemberAccess } from "../auth/access";
import type { Db } from "../db/client";
import * as s from "../db/schema";

/** A personal data download, deliberately separate from household backup and state-sync formats. */
export async function readAccountExport(db: Db, member: Pick<MemberAccess, "userId" | "personId">) {
  return db.transaction(async (tx) => {
    const [identity] = await tx.select({
      account: { name: s.authUsers.name, email: s.authUsers.email, emailVerified: s.authUsers.emailVerified, role: s.householdMembers.role },
      profile: {
        name: s.people.name, sex: s.people.sex, birthDate: s.people.birthDate, heightCm: s.people.heightCm,
        weightKg: s.people.weightKg, activityLevel: s.people.activityLevel, proteinTargetG: s.people.proteinTargetG,
        proteinGPerKg: s.people.proteinGPerKg, kcalTarget: s.people.kcalTarget, reminderTime: s.people.reminderTime,
        reminderTimezone: s.people.reminderTimezone, dietFlags: s.people.dietFlags,
      },
    }).from(s.householdMembers).innerJoin(s.authUsers, eq(s.authUsers.id, s.householdMembers.userId))
      .innerJoin(s.people, eq(s.people.id, s.householdMembers.personId))
      .where(and(eq(s.householdMembers.userId, member.userId), eq(s.people.id, member.personId), eq(s.authUsers.emailVerified, true)));
    if (!identity) return undefined;
    const preferences = await tx.select({ kind: s.preferences.kind, ingredient: s.ingredients.slug, recipe: s.recipes.slug })
      .from(s.preferences).leftJoin(s.ingredients, eq(s.ingredients.id, s.preferences.ingredientId))
      .leftJoin(s.recipes, eq(s.recipes.id, s.preferences.recipeId)).where(eq(s.preferences.personId, member.personId))
      .orderBy(s.preferences.kind, s.ingredients.slug, s.recipes.slug);
    const routines = await tx.select({
      habit: s.habits.slug, active: s.personRoutines.active, days: s.personRoutines.days,
      timeOfDay: s.personRoutines.timeOfDay, servings: s.personRoutines.servings,
    }).from(s.personRoutines).innerJoin(s.habits, eq(s.habits.id, s.personRoutines.habitId))
      .where(eq(s.personRoutines.personId, member.personId)).orderBy(s.habits.slug);
    const feedback = await tx.select({
      recipe: s.recipes.slug, uid: s.personRecipeFeedback.uid, rating: s.personRecipeFeedback.rating,
      favourite: s.personRecipeFeedback.favourite, createdAt: s.personRecipeFeedback.createdAt, updatedAt: s.personRecipeFeedback.updatedAt,
    }).from(s.personRecipeFeedback).innerJoin(s.recipes, eq(s.recipes.id, s.personRecipeFeedback.recipeId))
      .where(eq(s.personRecipeFeedback.personId, member.personId)).orderBy(s.recipes.slug);
    // Amounts only, as stored; macros are never part of a log row. Foods are named, not given by database id.
    const foodLog = await tx.select({
      uid: s.foodLog.uid, date: s.foodLog.date, slot: s.foodLog.slot, kind: s.foodLog.kind, recipe: s.foodLog.recipeSlug, servings: s.foodLog.servings,
      ingredient: s.foodLog.ingredientSlug, food: s.householdFoods.name, brand: s.householdFoods.brand, grams: s.foodLog.grams,
      displayQty: s.foodLog.displayQty, displayUnit: s.foodLog.displayUnit, plannedRecipe: s.foodLog.plannedRecipeSlug,
      plannedServings: s.foodLog.plannedServings, note: s.foodLog.note, createdAt: s.foodLog.createdAt, updatedAt: s.foodLog.updatedAt,
    }).from(s.foodLog).leftJoin(s.householdFoods, and(eq(s.householdFoods.id, s.foodLog.householdFoodId), eq(s.householdFoods.householdId, s.foodLog.householdId)))
      .where(eq(s.foodLog.personId, member.personId)).orderBy(s.foodLog.date, s.foodLog.slot, s.foodLog.uid);
    return { format: "protein-kitchen-account", version: 1, exportedAt: new Date().toISOString(), ...identity, preferences, routines, feedback, foodLog };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
