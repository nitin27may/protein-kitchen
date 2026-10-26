import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import * as s from "../lib/db/schema";
import { deleteOwnAccount } from "../lib/auth/household";
import { createAuth, type AuthCodeMail } from "../lib/auth/create";
import { createMemoryStore } from "../lib/blob/memory";
import { photoKeys } from "../lib/photos/keys";
import { openDb, type DbHandle } from "./helpers/db";

let h: DbHandle;
beforeAll(async () => { h = await openDb(); });
afterEach(async () => {
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

const at = "2026-11-02T00:00:00Z";
const future = () => new Date(Date.now() + 5 * 60_000);
const hashCode = (code: string) => createHash("sha256").update(code).digest("base64url");
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function library() {
  await h.db.insert(s.ingredients).values({
    id: 1, slug: "fixture", name: "Fixture", aliases: [], state: "ready", kcal: 1, proteinG: 0, carbsG: 0,
    fatG: 0, fibreG: 0, source: "USDA", sourceId: "fixture", aisle: "test", whereToBuy: [],
    isPantryStaple: false, containsOnionGarlic: false, isDairy: false,
  });
  await h.db.insert(s.recipes).values({
    id: 1, slug: "fixture", name: "Fixture", kind: "recipe", family: "test", mealSlots: ["lunch"], cuisine: "test",
    isIndian: false, servings: 1, prepMin: 0, activeMin: 0, totalMin: 0, equipment: [], tags: [], fridgeDays: 1,
  });
  await h.db.insert(s.habits).values({ id: 1, slug: "fixture", title: "Fixture", category: "test", evidenceGrade: "practical", evidenceNote: "Synthetic", defaultOn: false });
}

/** One household with a single member and a row in every household-scoped table and everything hanging off its profile. */
async function household(id: string, n: number, extra: { role?: "owner" | "member" } = {}) {
  const userId = `user-${id}`;
  await h.db.insert(s.households).values({ id, name: `Household ${id}` });
  await h.db.insert(s.authUsers).values({ id: userId, name: `Cook ${id}`, email: `${id}@example.test`, emailVerified: true });
  const [person] = await h.db.insert(s.people).values({
    householdId: id, name: `Profile ${id}`, sex: "other", birthDate: "1985-03-04", heightCm: 183, weightKg: 93,
    activityLevel: "light", dietFlags: [],
  }).returning();
  const personId = person!.id;
  await h.db.insert(s.householdMembers).values({ householdId: id, userId, personId, role: extra.role ?? "owner" });
  await h.db.insert(s.authSessions).values({ id: `session-${id}`, userId, token: `token-${id}`, updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), activeHouseholdId: id });
  await h.db.insert(s.householdInvitations).values({ id: `invite-${id}`, householdId: id, email: `guest-${id}@example.test`, invitedByUserId: userId, personId, tokenHash: `hash-${id}`, expiresAt: new Date(Date.now() + 86_400_000) });
  const [setup] = await h.db.insert(s.planSetups).values({ householdId: id, personIds: [personId], startDate: "2026-11-02", endDate: "2026-11-02", mealTypes: ["lunch"], cuisineBalance: 0.5, createdAt: at }).returning();
  const [plan] = await h.db.insert(s.plans).values({ householdId: id, setupId: setup!.id, seed: 1, createdAt: at }).returning();
  const [slot] = await h.db.insert(s.planSlots).values({ planId: plan!.id, date: "2026-11-02", slot: "lunch", recipeId: 1 }).returning();
  await h.db.insert(s.planSlotPortions).values({ planSlotId: slot!.id, personId, servings: 1 });
  await h.db.insert(s.preferences).values({ personId, recipeId: 1, kind: "like" });
  await h.db.insert(s.groceryManual).values({ planId: plan!.id, text: "Synthetic", checked: true });
  await h.db.insert(s.groceryState).values({ planId: plan!.id, ingredientId: 1, checked: true });
  await h.db.insert(s.pantry).values({ householdId: id, ingredientId: 1, have: true, alwaysStock: true });
  await h.db.insert(s.planProgress).values({ planId: plan!.id, step: "prep", doneAt: at });
  await h.db.insert(s.planPartState).values({ planId: plan!.id, componentSlug: "fixture", mode: "have", updatedAt: at });
  await h.db.insert(s.habitLog).values({ personId, habitId: 1, date: "2026-11-02", done: true });
  await h.db.insert(s.reminderLog).values({ personId, date: "2026-11-02", sentAt: at });
  await h.db.insert(s.personRoutines).values({ personId, habitId: 1, days: [1], timeOfDay: "morning", servings: 1, active: true });
  await h.db.insert(s.planRoutines).values({ planId: plan!.id, personId, habitId: 1, days: [1], timeOfDay: "morning", servings: 1 });
  await h.db.insert(s.prepTaskState).values({ householdId: id, date: "2026-11-02", taskKey: "k", done: true });
  await h.db.insert(s.personRecipeFeedback).values({ personId, recipeId: 1, uid: `personal-${id}`, rating: 5, createdAt: at, updatedAt: at });
  await h.db.insert(s.recipeFeedback).values({ householdId: id, recipeId: 1, rating: 5, notes: "Synthetic", uid: `feedback-${id}` });
  await h.db.insert(s.savedViews).values({ householdId: id, list: "recipes", name: "Synthetic", query: "", uid: `view-${id}` });
  await h.db.insert(s.recipeLinks).values({ householdId: id, recipeId: 1, uid: `link-${id}`, kind: "recipe", url: "https://example.test", title: "Synthetic", createdAt: at, updatedAt: at });
  await h.db.insert(s.photos).values({ householdId: id, uid: uid(n), recipeId: 1, origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: at, updatedAt: at });
  await h.db.insert(s.photoDecisions).values({ householdId: id, uid: `decision-${id}`, subjectKind: "recipe", subjectSlug: "fixture", candidateKey: "commons:fixture", decision: "rejected", createdAt: at, updatedAt: at });
  await h.db.insert(s.pushSubscriptions).values({ personId, endpoint: `https://push.example.test/${id}`, p256dh: "synthetic", auth: "synthetic", createdAt: at });
  await h.db.insert(s.reminderBatches).values({ householdId: id, id: `batch-${id}`, personId, date: "2026-11-02", payload: { title: "t", body: "b", url: "/" }, expiresAt: at, createdAt: at });
  await h.db.insert(s.reminderDeliveries).values({ batchId: `batch-${id}`, subscriptionId: 1, fingerprint: "f", updatedAt: at });
  await h.db.insert(s.syncState).values({ householdId: id, dataClass: "recipe-links", changedAt: at });
  await h.db.insert(s.stateSyncJobs).values({ householdId: id, targetKey: `target-${id}` });
  await h.db.insert(s.stateSyncRequests).values({ id: `request-${id}`, targetKey: `target-${id}`, status: "success", startedAt: at });
  return { userId, personId, photoUid: uid(n) };
}
async function code(email: string, value = "123456", over: Partial<typeof s.authVerifications.$inferInsert> = {}) {
  await h.db.insert(s.authVerifications).values({
    id: `code-${email}`, identifier: `email-verification-otp-${email}`, value: `${hashCode(value)}:0`, expiresAt: future(), ...over,
  });
}
const proof = (id: string, value = "123456") => ({ userId: `user-${id}`, sessionToken: `token-${id}`, code: value });

type Column = { table_name: string };
async function tablesWith(column: string): Promise<string[]> {
  const result = await h.db.execute(sql`select table_name from information_schema.columns where table_schema = 'public' and column_name = ${column} order by table_name`);
  return ((result as unknown as { rows: Column[] }).rows).map((row) => row.table_name);
}
async function countWhere(table: string, column: string, values: (string | number)[]) {
  if (!values.length) return 0;
  const result = await h.db.execute(sql`select count(*)::int as n from ${sql.identifier(table)} where ${sql.identifier(column)} in (${sql.join(values.map((v) => sql`${v}`), sql`, `)})`);
  return (result as unknown as { rows: { n: number }[] }).rows[0]!.n;
}
async function scoped(householdIds: string[], personIds: number[], planIds: number[]) {
  const out: Record<string, number> = {};
  for (const table of await tablesWith("household_id")) out[`${table}.household_id`] = await countWhere(table, "household_id", householdIds);
  for (const table of await tablesWith("person_id")) out[`${table}.person_id`] = await countWhere(table, "person_id", personIds);
  for (const table of await tablesWith("plan_id")) out[`${table}.plan_id`] = await countWhere(table, "plan_id", planIds);
  return out;
}
async function ids(householdId: string) {
  const people = (await h.db.select({ id: s.people.id }).from(s.people).where(eq(s.people.householdId, householdId))).map((r) => r.id);
  const plans = (await h.db.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.householdId, householdId))).map((r) => r.id);
  return { people, plans };
}

describe("deleting the last member deletes the household", () => {
  beforeEach(library);

  it("leaves no row for the household in any table with a household, profile or plan column, and does not touch another household", async () => {
    await household("a", 1); await household("b", 2);
    const a = await ids("a"), b = await ids("b");
    const beforeA = await scoped(["a"], a.people, a.plans);
    const beforeB = await scoped(["b"], b.people, b.plans);
    // Every scoped table must be seeded, so a table added later fails here until the fixture and the deletion cover it.
    for (const [name, rows] of Object.entries(beforeA)) expect(rows, `fixture has no ${name} row`).toBeGreaterThan(0);
    expect((await tablesWith("household_id")).length).toBeGreaterThanOrEqual(15);
    await code("a@example.test");

    const { photoKeys: keys } = await deleteOwnAccount(h.db, proof("a"));

    expect(keys.sort()).toEqual(Object.values(photoKeys(uid(1))).sort());
    for (const [name, rows] of Object.entries(await scoped(["a"], a.people, a.plans))) expect(rows, name).toBe(0);
    expect(await scoped(["b"], b.people, b.plans)).toEqual(beforeB);
    expect(await h.db.select().from(s.households)).toMatchObject([{ id: "b" }]);
    expect(await h.db.select().from(s.people).where(eq(s.people.householdId, "a"))).toEqual([]);
    expect(await h.db.select({ id: s.authUsers.id }).from(s.authUsers)).toEqual([{ id: "user-b" }]);
    expect(await h.db.select().from(s.authSessions)).toMatchObject([{ id: "session-b", activeHouseholdId: "b" }]);
    expect(await h.db.select().from(s.authVerifications)).toEqual([]);
  });

  it("works for a passwordless account and refuses a wrong, expired, exhausted, foreign or reused code without deleting anything", async () => {
    await household("a", 1);
    const before = await scoped(["a"], (await ids("a")).people, (await ids("a")).plans);
    await code("a@example.test");
    await expect(deleteOwnAccount(h.db, proof("a", "000000"))).rejects.toThrow("not valid");
    await expect(deleteOwnAccount(h.db, proof("a", "abcdef"))).rejects.toThrow("not valid");
    expect((await h.db.select().from(s.authVerifications))[0]!.value.endsWith(":2")).toBe(true);
    // The third wrong guess exhausts the code; even the right one is then refused.
    await expect(deleteOwnAccount(h.db, proof("a", "111111"))).rejects.toThrow("not valid");
    await expect(deleteOwnAccount(h.db, proof("a"))).rejects.toThrow("not valid");
    expect(await h.db.select().from(s.authVerifications)).toEqual([]);

    await code("a@example.test", "123456", { expiresAt: new Date(Date.now() - 1000) });
    await expect(deleteOwnAccount(h.db, proof("a"))).rejects.toThrow("not valid");
    expect(await h.db.select().from(s.authVerifications)).toEqual([]);

    await code("someone-else@example.test");
    await expect(deleteOwnAccount(h.db, proof("a"))).rejects.toThrow("not valid");
    expect(await scoped(["a"], (await ids("a")).people, (await ids("a")).plans)).toEqual(before);
    expect(await h.db.select().from(s.authUsers).where(eq(s.authUsers.id, "user-a"))).toHaveLength(1);

    await code("a@example.test");
    await deleteOwnAccount(h.db, proof("a"));
    // The same code cannot be used again, even by a new account with the same address.
    await household("a", 1);
    await expect(deleteOwnAccount(h.db, proof("a"))).rejects.toThrow("not valid");
    expect(await h.db.select().from(s.households)).toHaveLength(1);
  });

  it("treats a code row without an attempt counter as unused and one with a corrupt counter as spent", async () => {
    await household("a", 1);
    await code("a@example.test", "123456", { value: hashCode("123456") });
    await deleteOwnAccount(h.db, proof("a"));
    expect(await h.db.select().from(s.households)).toEqual([]);
    await household("a", 1);
    await code("a@example.test", "123456", { value: `${hashCode("123456")}:x` });
    await expect(deleteOwnAccount(h.db, proof("a"))).rejects.toThrow("not valid");
    expect(await h.db.select().from(s.authVerifications)).toEqual([]);
  });

  it("tells an owner with other members to transfer ownership first and writes nothing", async () => {
    await household("a", 1);
    await h.db.insert(s.authUsers).values({ id: "user-other", name: "Other", email: "other@example.test", emailVerified: true });
    await h.db.insert(s.householdMembers).values({ householdId: "a", userId: "user-other", role: "member" });
    await code("a@example.test");
    const before = await scoped(["a"], (await ids("a")).people, (await ids("a")).plans);
    await expect(deleteOwnAccount(h.db, proof("a"))).rejects.toThrow("Transfer ownership first");
    expect(await scoped(["a"], (await ids("a")).people, (await ids("a")).plans)).toEqual(before);
    expect(await h.db.select().from(s.authVerifications)).toHaveLength(1);
    // With a second verified owner who has a profile, the first owner may leave and the household stays.
    const [person] = await h.db.insert(s.people).values({ householdId: "a", name: "Second", sex: "other", birthDate: "1990-01-01", heightCm: 170, weightKg: 70, activityLevel: "light", dietFlags: [] }).returning();
    await h.db.update(s.householdMembers).set({ role: "owner", personId: person!.id }).where(eq(s.householdMembers.userId, "user-other"));
    await deleteOwnAccount(h.db, proof("a"));
    expect(await h.db.select().from(s.households)).toMatchObject([{ id: "a" }]);
    expect(await h.db.select().from(s.householdMembers)).toMatchObject([{ userId: "user-other" }]);
  });

  it("rolls everything back, including the consumed code, when the household cannot be deleted", async () => {
    await household("a", 1);
    await code("a@example.test");
    const before = await scoped(["a"], (await ids("a")).people, (await ids("a")).plans);
    await h.failWrite("households", "DELETE", "reject_household_delete");
    try {
      await expect(deleteOwnAccount(h.db, proof("a"))).rejects.toThrow();
      expect(await scoped(["a"], (await ids("a")).people, (await ids("a")).plans)).toEqual(before);
      expect(await h.db.select().from(s.authVerifications)).toHaveLength(1);
    } finally { await h.dropFailure("households", "reject_household_delete"); }
  });
});

describe("account deletion over the auth HTTP endpoint", () => {
  const origin = "http://localhost:3112";
  let mailbox: AuthCodeMail[];
  let store: ReturnType<typeof createMemoryStore>;
  let auth: ReturnType<typeof createAuth>;
  beforeEach(async () => {
    await library();
    mailbox = []; store = createMemoryStore();
    auth = createAuth(h.db, {
      baseURL: origin, secret: "synthetic-deletion-household-secret-32chars", isVercel: false,
      sendCode: async (mail) => { mailbox.push(mail); }, sendLink: async () => {},
      deletePhotoKeys: async (keys) => { for (const key of keys) await store.delete(key); },
    });
  });
  const call = (path: string, body?: object, headers: Record<string, string> = {}) => auth.handler(new Request(`${origin}/api/auth${path}`, {
    method: body ? "POST" : "GET",
    headers: { origin, "content-type": "application/json", "x-forwarded-for": "127.0.0.9", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }));
  const cookieOf = (response: Response) => response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const latest = (email: string, type: AuthCodeMail["type"]) => mailbox.findLast((mail) => mail.email === email && mail.type === type)!.otp;
  async function signIn(email: string) {
    expect((await call("/email-otp/send-verification-otp", { email, type: "sign-in" })).status).toBe(200);
    const response = await call("/sign-in/email-otp", { email, otp: latest(email, "sign-in") });
    expect(response.status, await response.clone().text()).toBe(200);
    return cookieOf(response);
  }

  it("signs in by code, deletes the account and household with a fresh code, removes the photo files, then a new sign-in starts a fresh kitchen", async () => {
    // Create the user through the real flow, then give them a kitchen like onboarding does.
    const first = await signIn("cook@example.test");
    const [user] = await h.db.select().from(s.authUsers);
    expect(await h.db.select().from(s.authAccounts).then((rows) => rows.filter((row) => row.password))).toEqual([]);
    await h.db.insert(s.households).values({ id: "kitchen", name: "Kitchen" });
    await h.db.insert(s.householdMembers).values({ householdId: "kitchen", userId: user!.id, role: "owner" });
    const [person] = await h.db.insert(s.people).values({ householdId: "kitchen", name: "Cook", sex: "other", birthDate: "1985-03-04", heightCm: 183, weightKg: 93, activityLevel: "light", dietFlags: [] }).returning();
    await h.db.update(s.householdMembers).set({ personId: person!.id }).where(eq(s.householdMembers.userId, user!.id));
    await h.db.insert(s.photos).values({ householdId: "kitchen", uid: uid(7), recipeId: 1, origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: at, updatedAt: at });
    for (const key of Object.values(photoKeys(uid(7)))) await store.put(key, Buffer.from("bytes"), "image/webp");
    await store.put("photos/other/master.webp", Buffer.from("keep"), "image/webp");

    expect((await call("/delete-household-account", { code: "000000", confirmation: "DELETE" }, { cookie: first })).status).toBe(403);
    expect((await call("/delete-household-account", { confirmation: "DELETE" }, { cookie: first })).status).toBe(400);
    expect((await call("/delete-household-account", { code: "123456", password: "x", confirmation: "DELETE" }, { cookie: first })).status).toBe(400);
    expect(await h.db.select().from(s.households)).toHaveLength(1);

    expect((await call("/email-otp/send-verification-otp", { email: "cook@example.test", type: "email-verification" })).status).toBe(200);
    const response = await call("/delete-household-account", { code: latest("cook@example.test", "email-verification"), confirmation: "DELETE" }, { cookie: first });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.getSetCookie().join(";")).toMatch(/session_token=;.*Max-Age=0/i);
    for (const table of [s.households, s.people, s.householdMembers, s.photos, s.authUsers, s.authSessions, s.authAccounts]) {
      expect(await h.db.select().from(table), getTableName(table)).toEqual([]);
    }
    expect(await store.list()).toEqual(["photos/other/master.webp"]);
    expect(await (await call("/get-session", undefined, { cookie: first })).json()).toBeNull();

    const again = await signIn("cook@example.test");
    const [fresh] = await h.db.select().from(s.authUsers);
    expect(fresh!.id).not.toBe(user!.id);
    expect(await h.db.select().from(s.householdMembers)).toEqual([]);
    expect(await (await call("/get-session", undefined, { cookie: again })).json()).toMatchObject({ user: { email: "cook@example.test" } });
  });

  it("refuses a code that was mailed for another address", async () => {
    const cookie = await signIn("cook@example.test");
    const [user] = await h.db.select().from(s.authUsers);
    await h.db.insert(s.households).values({ id: "kitchen", name: "Kitchen" });
    await h.db.insert(s.householdMembers).values({ householdId: "kitchen", userId: user!.id, role: "owner" });
    await h.db.insert(s.authUsers).values({ id: "neighbour", name: "Neighbour", email: "neighbour@example.test", emailVerified: true });
    expect((await call("/email-otp/send-verification-otp", { email: "neighbour@example.test", type: "email-verification" })).status).toBe(200);
    const response = await call("/delete-household-account", { code: latest("neighbour@example.test", "email-verification"), confirmation: "DELETE" }, { cookie });
    expect(response.status).toBe(403);
    expect(await h.db.select().from(s.authUsers)).toHaveLength(2);
  });

  it("still deletes when no photo cleanup is configured or the cleanup fails, and says nothing about the failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const deletePhotoKeys of [undefined, async () => { throw new Error("synthetic storage failure"); }]) {
      auth = createAuth(h.db, {
        baseURL: origin, secret: "synthetic-deletion-household-secret-32chars", isVercel: false,
        sendCode: async (mail) => { mailbox.push(mail); }, sendLink: async () => {}, deletePhotoKeys,
      });
      const cookie = await signIn("cook@example.test");
      const [user] = await h.db.select().from(s.authUsers);
      await h.db.insert(s.households).values({ id: "kitchen", name: "Kitchen" });
      await h.db.insert(s.householdMembers).values({ householdId: "kitchen", userId: user!.id, role: "owner" });
      await h.db.insert(s.photos).values({ householdId: "kitchen", uid: uid(8), recipeId: 1, origin: "upload", sha256: "0".repeat(64), width: 1, height: 1, createdAt: at, updatedAt: at });
      expect((await call("/email-otp/send-verification-otp", { email: "cook@example.test", type: "email-verification" })).status).toBe(200);
      const response = await call("/delete-household-account", { code: latest("cook@example.test", "email-verification"), confirmation: "DELETE" }, { cookie });
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await h.db.select().from(s.households)).toEqual([]);
      await h.db.delete(s.mailSends);
    }
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});
