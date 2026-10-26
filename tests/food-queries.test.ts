import { beforeEach, describe, expect, it } from "vitest";
import * as s from "../lib/db/schema";
import { createHouseholdFood, archiveHouseholdFood } from "../lib/human/household-foods";
import { logFoodEntry } from "../lib/human/food-log";
import { getHouseholdFood, householdFoodUsage, listHouseholdFoods } from "../lib/server/food-queries";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
const A = { householdId: "a", personId: 1 };
const B = { householdId: "b", personId: 2 };
const food = (over: Record<string, unknown> = {}) => ({
  name: "Greek yogurt", brand: "Oikos", kcal: 57, proteinG: 10, carbsG: 3.6, fatG: 0.2, fibreG: null, labelBasis: "per_100g" as const, source: "LABEL" as const,
  per100gMicros: { calcium_mg: 110 }, notReported: ["iron_mg"], fieldOrigins: {}, ...over,
});

beforeEach(async () => {
  h = await openDb();
  await h.db.insert(s.households).values([{ id: "a", name: "First" }, { id: "b", name: "Second" }]);
  await h.db.insert(s.people).values([
    { id: 1, householdId: "a", name: "Asha", sex: "female", birthDate: "1985-03-04", heightCm: 165, weightKg: 60, activityLevel: "light", dietFlags: [] },
    { id: 2, householdId: "b", name: "Ben", sex: "male", birthDate: "1984-01-02", heightCm: 180, weightKg: 80, activityLevel: "light", dietFlags: [] },
  ]);
});

describe("household food reads", () => {
  it("lists a household's foods by name, hides archived ones unless asked, and never shows another household's", async () => {
    const zebra = await createHouseholdFood(h.db, A, food({ name: "zebra crackers", brand: null }));
    await createHouseholdFood(h.db, A, food({ name: "Apple sauce", fibreG: 1.2, fieldOrigins: { densityGPerMl: "assumed_water" } }));
    await createHouseholdFood(h.db, B, food({ name: "Other household food" }));
    await archiveHouseholdFood(h.db, A, zebra.uid);
    const active = await listHouseholdFoods(h.db, "a");
    expect(active.map((f) => f.name)).toEqual(["Apple sauce"]);
    expect(active[0]).toMatchObject({ key: expect.stringMatching(/^hf:/), source: "LABEL", estimatedWeight: true, fibreG: 1.2, archived: false, hasLabelPhoto: false });
    const all = await listHouseholdFoods(h.db, "a", { includeArchived: true });
    expect(all.map((f) => f.name)).toEqual(["Apple sauce", "zebra crackers"]);
    expect(all[1]).toMatchObject({ archived: true, brand: null, fibreG: null, estimatedWeight: false });
    expect((await listHouseholdFoods(h.db, "b")).map((f) => f.name)).toEqual(["Other household food"]);
    expect(await listHouseholdFoods(h.db, "nobody")).toEqual([]);
  });

  it("reads one food with its usage and who confirmed it; another household finds nothing", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-02", slot: "snack", kind: "extra", item: { type: "food", householdFoodUid: uid, grams: 100 } });
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-03", slot: "snack", kind: "extra", item: { type: "food", householdFoodUid: uid, grams: 100 } });
    const detail = await getHouseholdFood(h.db, "a", uid);
    expect(detail).toMatchObject({ uid, name: "Greek yogurt", usageCount: 2, confirmedByName: "Asha", per100gMicros: { calcium_mg: 110 }, notReported: ["iron_mg"], state: "ready" });
    expect(await getHouseholdFood(h.db, "b", uid)).toBeNull();
    expect(await getHouseholdFood(h.db, "a", "missing")).toBeNull();
  });

  it("leaves the confirmer's name empty when the profile is gone", async () => {
    const { uid } = await createHouseholdFood(h.db, A, food());
    await h.db.delete(s.people).where((await import("drizzle-orm")).eq(s.people.id, 1));
    expect((await getHouseholdFood(h.db, "a", uid))!.confirmedByName).toBeNull();
  });

  it("counts usage per food, keyed hf:<uid>, inside the household only", async () => {
    const yogurt = await createHouseholdFood(h.db, A, food());
    const other = await createHouseholdFood(h.db, B, food({ name: "Elsewhere" }));
    await createHouseholdFood(h.db, A, food({ name: "Never logged" }));
    await logFoodEntry(h.db, A, { personId: 1, date: "2026-11-02", slot: "snack", kind: "extra", item: { type: "food", householdFoodUid: yogurt.uid, grams: 100 } });
    await logFoodEntry(h.db, B, { personId: 2, date: "2026-11-02", slot: "snack", kind: "extra", item: { type: "food", householdFoodUid: other.uid, grams: 100 } });
    const usage = await householdFoodUsage(h.db, "a");
    expect(Object.keys(usage)).toEqual([`hf:${yogurt.uid}`]);
    expect(usage[`hf:${yogurt.uid}`]).toMatchObject({ count: 1, lastLoggedAt: expect.stringMatching(/^\d{4}-/) });
    expect(await householdFoodUsage(h.db, "nobody")).toEqual({});
  });
});
