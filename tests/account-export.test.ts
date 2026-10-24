import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type DbHandle } from "./helpers/db";
import * as s from "../lib/db/schema";
import { loadData } from "../lib/data/load";
import { seedDatabase } from "../lib/db/seed";
import { writePersonRoutine } from "../lib/human/routines";
import { writeRecipeFeedback } from "../lib/human/feedback";
import { writePersonalRecipeFeedback } from "../lib/human/personal-feedback";
import { readAccountExport } from "../lib/server/account-export";
import { getDb } from "../lib/server/context";
import { routeAccess } from "../lib/auth/access";
import { GET } from "../app/api/account/export/route";

vi.mock("../lib/server/context", () => ({ getDb: vi.fn() }));
vi.mock("../lib/auth/access", () => ({ routeAccess: vi.fn() }));
const library = loadData(process.cwd());
let h: DbHandle;
let first: number;
let second: number;
const keys = (value: object) => Object.keys(value).sort();
const member = () => ({ userId: "first-user", personId: first, role: "owner" as const });
const request = (query = "") => new Request(`https://kitchen.example.test/api/account/export${query}`);

beforeEach(async () => {
  vi.resetAllMocks();
  h = await openDb();
  await seedDatabase(h.db, library);
  const people = await h.db.insert(s.people).values(["First", "Second"].map((name, index) => ({
    name: `Synthetic ${name} private profile`, sex: "other" as const, birthDate: index ? "1999-06-15" : "2000-01-01",
    heightCm: 170 + index, weightKg: 70 + index, activityLevel: "light" as const, dietFlags: ["vegetarian"],
    proteinTargetG: 95 + index, kcalTarget: 2000 + index, reminderTime: "21:00",
  }))).returning();
  first = people[0]!.id; second = people[1]!.id;
  await h.db.insert(s.authUsers).values(["first", "second"].map((key) => ({
    id: `${key}-user`, name: `Synthetic ${key} cook`, email: `${key}@example.test`, emailVerified: true,
  })));
  await h.db.insert(s.householdMembers).values([
    { userId: "first-user", personId: first, role: "owner" }, { userId: "second-user", personId: second, role: "member" },
  ]);
  await h.db.insert(s.authAccounts).values({
    id: "account-secret-sentinel", userId: "first-user", providerId: "credential", accountId: "first-user",
    password: "synthetic-password-secret-sentinel", accessToken: "synthetic-access-secret-sentinel", refreshToken: "synthetic-refresh-secret-sentinel",
  });
  await h.db.insert(s.authSessions).values({
    id: "session-secret-sentinel", userId: "first-user", token: "synthetic-session-secret-sentinel",
    expiresAt: new Date("2030-01-01"), ipAddress: "synthetic-ip-secret-sentinel",
  });
  await h.db.insert(s.authVerifications).values({
    id: "verification-secret-sentinel", identifier: "synthetic-otp-identifier", value: "synthetic-otp-secret-sentinel", expiresAt: new Date("2030-01-01"),
  });
  await h.db.insert(s.authRateLimits).values({ id: "rate-secret-sentinel", key: "synthetic-rate-secret-sentinel", count: 1, lastRequest: 1 });
  await h.db.insert(s.householdInvitations).values({
    id: "invite-secret-sentinel", email: "invited@example.test", tokenHash: "synthetic-invite-secret-sentinel",
    invitedByUserId: "first-user", expiresAt: new Date("2030-01-01"),
  });
  vi.mocked(getDb).mockResolvedValue(h.db);
  vi.mocked(routeAccess).mockResolvedValue({ member: member() });
});

describe("allowlisted personal account snapshot", () => {
  it("exports exact allowed keys and only the requesting account's profile and choices", async () => {
    const [ingredient] = await h.db.select({ id: s.ingredients.id, slug: s.ingredients.slug }).from(s.ingredients).limit(1);
    const [recipe] = await h.db.select({ id: s.recipes.id, slug: s.recipes.slug }).from(s.recipes).where(eq(s.recipes.kind, "recipe")).limit(1);
    const [habit] = await h.db.select({ id: s.habits.id, slug: s.habits.slug }).from(s.habits).where(eq(s.habits.slug, "soaked-methi-seeds"));
    await h.db.insert(s.preferences).values([
      { personId: first, ingredientId: ingredient!.id, kind: "like" }, { personId: first, recipeId: recipe!.id, kind: "pin" },
      { personId: second, ingredientId: ingredient!.id, kind: "avoid" },
    ]);
    await writePersonRoutine(h.db, first, habit!.id, { active: true, days: [1, 4], timeOfDay: "waking", servings: 1 });
    await writePersonRoutine(h.db, second, habit!.id, { active: false, days: [2], timeOfDay: "evening", servings: 2 });
    await writeRecipeFeedback(h.db, recipe!.id, { notes: "shared-private-note-sentinel" });
    await writePersonalRecipeFeedback(h.db, first, recipe!.id, { rating: 5, favourite: true });
    await writePersonalRecipeFeedback(h.db, second, recipe!.id, { rating: 2 });
    const before = await h.db.select().from(s.syncState).orderBy(s.syncState.dataClass);
    const result = (await readAccountExport(h.db, member()))!;
    expect(keys(result)).toEqual(["account", "exportedAt", "feedback", "format", "preferences", "profile", "routines", "version"]);
    expect(result).toMatchObject({ format: "protein-kitchen-account", version: 1, exportedAt: expect.stringMatching(/Z$/) });
    expect(result.account).toEqual({ name: "Synthetic first cook", email: "first@example.test", emailVerified: true, role: "owner" });
    expect(result.profile).toEqual({
      name: "Synthetic First private profile", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
      activityLevel: "light", dietFlags: ["vegetarian"], proteinTargetG: 95, proteinGPerKg: null, kcalTarget: 2000, reminderTime: "21:00",
    });
    expect(result.preferences).toEqual([
      { kind: "like", ingredient: ingredient!.slug, recipe: null }, { kind: "pin", ingredient: null, recipe: recipe!.slug },
    ]);
    expect(result.routines).toEqual([{ habit: habit!.slug, active: true, days: [1, 4], timeOfDay: "waking", servings: 1 }]);
    expect(result.feedback).toHaveLength(1);
    expect(keys(result.feedback[0]!)).toEqual(["createdAt", "favourite", "rating", "recipe", "uid", "updatedAt"]);
    expect(result.feedback[0]).toMatchObject({ recipe: recipe!.slug, rating: 5, favourite: true });
    const json = JSON.stringify(result);
    for (const forbidden of ["secret-sentinel", "shared-private-note-sentinel", "second@example.test", "Synthetic Second", "1999-06-15", "first-user"]) {
      expect(json).not.toContain(forbidden);
    }
    expect(await h.db.select().from(s.syncState).orderBy(s.syncState.dataClass)).toEqual(before);
  });
  it("supports members, empty collections and nullable personal fields", async () => {
    await h.db.update(s.people).set({ proteinTargetG: null, proteinGPerKg: 1.2, kcalTarget: null, reminderTime: null }).where(eq(s.people.id, second));
    const result = (await readAccountExport(h.db, { userId: "second-user", personId: second }))!;
    expect(result.account.role).toBe("member");
    expect(result.profile).toMatchObject({ proteinTargetG: null, proteinGPerKg: 1.2, kcalTarget: null, reminderTime: null });
    expect([result.preferences, result.routines, result.feedback]).toEqual([[], [], []]);
  });
  it("rechecks user/profile binding, email verification and live membership inside the snapshot", async () => {
    expect(await readAccountExport(h.db, { userId: "first-user", personId: second })).toBeUndefined();
    await h.db.update(s.authUsers).set({ emailVerified: false }).where(eq(s.authUsers.id, "first-user"));
    expect(await readAccountExport(h.db, member())).toBeUndefined();
    await h.db.update(s.authUsers).set({ emailVerified: true }).where(eq(s.authUsers.id, "first-user"));
    await h.db.delete(s.people).where(eq(s.people.id, first));
    expect(await readAccountExport(h.db, member())).toBeUndefined();
    expect(await readAccountExport(h.db, { userId: "missing-user", personId: second })).toBeUndefined();
  });
});

describe("account download route", () => {
  it.each([401, 403, 503])("returns uncached %i auth failures without reading account data", async (status) => {
    const response = Response.json({ ok: false }, { status, headers: { "Cache-Control": "private, no-store" } });
    vi.mocked(routeAccess).mockResolvedValue({ response });
    const result = await GET(request("?personId=123"));
    expect(result).toBe(response);
    expect(getDb).not.toHaveBeenCalled();
  });
  it("rejects all query parameters, including forged user/person selectors, before accessing data", async () => {
    for (const query of ["?userId=second-user", `?personId=${second}`, "?format=json", "?x="]) {
      const result = await GET(request(query));
      expect(result.status).toBe(400);
      expect(result.headers.get("cache-control")).toContain("no-store");
      expect(await result.json()).toEqual({ ok: false, error: "Account downloads do not accept query parameters." });
    }
    expect(getDb).not.toHaveBeenCalled();
  });
  it("returns an uncached failure if access changed after the initial guard", async () => {
    await h.db.delete(s.householdMembers).where(eq(s.householdMembers.userId, "first-user"));
    const result = await GET(request());
    expect(result.status).toBe(403);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(result.headers.has("content-disposition")).toBe(false);
  });
  it("delivers the caller's allowlisted JSON as a private attachment", async () => {
    const result = await GET(request());
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(result.headers.get("content-disposition")).toBe('attachment; filename="protein-kitchen-account.json"');
    expect(await result.json()).toMatchObject({ account: { email: "first@example.test" }, profile: { name: "Synthetic First private profile" } });
    expect(routeAccess).toHaveBeenCalledWith(expect.any(Request));
  });
});
