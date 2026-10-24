import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { beforeEach, expect, it } from "vitest";
import * as s from "../lib/db/schema";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
let personId: number;
const setup = {
  personIds: [], startDate: "2026-11-02", endDate: "2026-11-08", mealTypes: ["dinner"], cuisineBalance: 0.5,
  createdAt: "2026-11-01T12:00:00.000Z",
};
beforeEach(async () => {
  h = await openDb();
  await h.db.insert(s.households).values([{ id: "a", name: "First fixture" }, { id: "b", name: "Second fixture" }]);
  await h.db.insert(s.authUsers).values({ id: "fixture", name: "Fixture", email: "fixture@example.test", emailVerified: true });
  const [person] = await h.db.insert(s.people).values({
    householdId: "a", name: "Synthetic profile", sex: "other", birthDate: "2000-01-01",
    heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [],
  }).returning({ id: s.people.id });
  personId = person!.id;
});

it("declares exactly the reviewed composite parent keys and preserves existing nullable profile deletion behavior", () => {
  for (const [table, name, child, parent] of [
    [s.householdMembers, "household_members_profile_household_fk", "person_id", s.people],
    [s.householdInvitations, "household_invitations_profile_household_fk", "person_id", s.people],
    [s.plans, "plans_setup_household_fk", "setup_id", s.planSetups],
  ] as const) {
    const keys = getTableConfig(table).foreignKeys.filter((key) => key.getName() === name);
    expect(keys).toHaveLength(1);
    const key = keys[0]!;
    expect(key.reference().columns.map((column) => column.name)).toEqual(["household_id", child]);
    expect(key.reference().foreignTable).toBe(parent);
    expect(key.reference().foreignColumns.map((column) => column.name)).toEqual(["household_id", "id"]);
    expect(key.onDelete).toBe("no action");
  }
});

it("rejects cross-household membership and invitation profiles, including attempts to move an owned profile", async () => {
  await expect(h.db.insert(s.householdMembers).values({ householdId: "b", userId: "fixture", role: "owner", personId })).rejects.toThrow();
  await h.db.insert(s.householdMembers).values({ householdId: "a", userId: "fixture", role: "owner", personId });
  const invitation = {
    id: "fixture", email: "recipient@example.test", tokenHash: "fixture", invitedByUserId: "fixture", personId,
    createdAt: new Date("2026-11-01T12:00:00.000Z"), expiresAt: new Date("2026-11-08T12:00:00.000Z"),
  };
  await expect(h.db.insert(s.householdInvitations).values({ ...invitation, householdId: "b" })).rejects.toThrow();
  await h.db.insert(s.householdInvitations).values({ ...invitation, householdId: "a" });
  await expect(h.db.update(s.householdMembers).set({ householdId: "b" })).rejects.toThrow();
  await expect(h.db.update(s.householdInvitations).set({ householdId: "b" })).rejects.toThrow();
  await expect(h.db.update(s.people).set({ householdId: "b" }).where(eq(s.people.id, personId))).rejects.toThrow();
  await expect(h.db.update(s.people).set({ householdId: null }).where(eq(s.people.id, personId))).rejects.toThrow();
  expect(await h.db.select().from(s.people)).toMatchObject([{ householdId: "a" }]);
});

it("keeps household ownership while the existing profile deletion FKs clear optional links", async () => {
  await h.db.insert(s.householdMembers).values({ householdId: "a", userId: "fixture", role: "owner", personId });
  await h.db.insert(s.householdInvitations).values({
    id: "fixture", householdId: "a", email: "recipient@example.test", tokenHash: "fixture", invitedByUserId: "fixture", personId,
    createdAt: new Date("2026-11-01T12:00:00.000Z"), expiresAt: new Date("2026-11-08T12:00:00.000Z"),
  });
  await h.db.delete(s.people).where(eq(s.people.id, personId));
  expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ householdId: "a", personId: null }]);
  expect(await h.db.select().from(s.householdInvitations)).toMatchObject([{ householdId: "a", personId: null }]);
});

it("rejects mismatched plan/setup ownership while retaining the old single-parent delete protection", async () => {
  const [row] = await h.db.insert(s.planSetups).values({ ...setup, householdId: "a", personIds: [personId] }).returning();
  const plan = { setupId: row!.id, seed: 42, createdAt: setup.createdAt };
  await expect(h.db.insert(s.plans).values({ ...plan, householdId: "b" })).rejects.toThrow();
  await h.db.insert(s.plans).values({ ...plan, householdId: "a" });
  await expect(h.db.update(s.planSetups).set({ householdId: "b" })).rejects.toThrow();
  await expect(h.db.update(s.planSetups).set({ householdId: null })).rejects.toThrow();
  await expect(h.db.update(s.plans).set({ householdId: "b" })).rejects.toThrow();
  await expect(h.db.delete(s.planSetups)).rejects.toThrow();
  expect(await h.db.select().from(s.plans)).toMatchObject([{ householdId: "a" }]);
});

it("preserves nullable legacy writes during expansion, without admitting them through scoped access", async () => {
  await h.db.insert(s.householdMembers).values({ userId: "fixture", role: "owner", personId });
  const [row] = await h.db.insert(s.planSetups).values(setup).returning();
  await h.db.insert(s.plans).values({ setupId: row!.id, seed: 42, createdAt: setup.createdAt });
  expect(await h.db.select().from(s.plans)).toMatchObject([{ householdId: null }]);
  expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ householdId: null }]);
});
