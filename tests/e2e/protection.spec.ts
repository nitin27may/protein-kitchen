import { test, expect } from "./member-fixture";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { openPostgres } from "../../lib/db/postgres/client";
import { authUsers, householdMembers, people } from "../../lib/db/schema";
import { e2eTarget } from "./target";

test("anonymous pages, server components, photo bytes and exports never disclose household data", async ({ browser }) => {
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    const page = await anonymous.newPage();
    expect(await anonymous.cookies()).toEqual([]);
    for (const url of ["/", "/profiles", "/recipes", "/groceries", "/photos/review", `/plan/${process.env.E2E_PREP_PLAN_ID}/prep`]) {
      await page.goto(`http://127.0.0.1:3112${url}`);
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    }
    for (const url of [
      `/api/plan/${process.env.E2E_PREP_PLAN_ID}/export?format=pdf`,
      `/api/plan/${process.env.E2E_PREP_PLAN_ID}/export?format=xlsx`,
      "/photos/00000000-0000-4000-8000-000000000001/thumb",
      "/api/push/subscribe?personId=300&endpoint=private",
    ]) {
      const response = await anonymous.request.get(`http://127.0.0.1:3112${url}`);
      expect(response.status()).toBe(401);
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(await response.text()).not.toContain("Synthetic import fixture");
    }
    const rsc = await anonymous.request.get("http://127.0.0.1:3112/profiles", { headers: { RSC: "1" } });
    expect(rsc.headers()["cache-control"]).toContain("no-store");
    expect(await rsc.text()).not.toContain("Synthetic import fixture");
  } finally { await anonymous.close(); }
});

test("captured Server Actions cannot edit another profile or survive revoked household membership", async ({ page }) => {
  const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
  try {
    const [account] = await handle.db.select({ userId: householdMembers.userId, personId: householdMembers.personId })
      .from(householdMembers).innerJoin(authUsers, eq(authUsers.id, householdMembers.userId))
      .where(eq(authUsers.email, "authorized-browser-fixture@example.test"));
    expect(account?.personId).toBeTruthy();
    const personId = account!.personId!;
    const [foreign] = await handle.db.select({ id: people.id, name: people.name }).from(people).where(ne(people.id, personId)).limit(1);
    expect(foreign).toBeTruthy();
    await handle.db.update(householdMembers).set({ role: "member" }).where(eq(householdMembers.userId, account!.userId));
    try {
      await page.goto(`/profiles/${personId}`);
      const outgoing = page.waitForRequest((req) => req.method() === "POST" && req.headers()["next-action"] !== undefined);
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      const submitted = await outgoing;
      await page.waitForLoadState("networkidle");
      const body = submitted.postData();
      expect(body).toBeTruthy();
      const [profile] = z.tuple([z.object({ id: z.number(), name: z.string() }).passthrough()]).parse(JSON.parse(body!));
      expect(profile.id).toBe(personId);
      const headers = { origin: "http://127.0.0.1:3112", "content-type": submitted.headers()["content-type"]!, "next-action": submitted.headers()["next-action"]! };
      const foreignAttempt = await page.request.post(`/profiles/${personId}`, {
        headers, data: JSON.stringify([{ ...profile, id: foreign!.id, name: "Must never be saved" }]),
      });
      expect(await foreignAttempt.text()).toContain("only change your own profile");
      expect(await handle.db.select({ name: people.name }).from(people).where(eq(people.id, foreign!.id))).toEqual([{ name: foreign!.name }]);
      await handle.db.delete(householdMembers).where(eq(householdMembers.userId, account!.userId));
      const replay = await page.request.post(`/profiles/${personId}`, { headers, data: body! });
      expect(await replay.text()).toContain("Finish household and profile onboarding");
      const exportResult = await page.request.get(`/api/plan/${process.env.E2E_PREP_PLAN_ID}/export?format=pdf`);
      expect(exportResult.status()).toBe(403);
      expect(exportResult.headers()["cache-control"]).toContain("no-store");
      await page.goto("/groceries");
      await expect(page).toHaveURL(/\/onboarding/);
    } finally {
      await handle.db.insert(householdMembers).values({ userId: account!.userId, personId, role: "owner" })
        .onConflictDoUpdate({ target: householdMembers.userId, set: { role: "owner", personId } });
      expect(await handle.db.select().from(householdMembers).where(and(eq(householdMembers.userId, account!.userId), eq(householdMembers.personId, personId)))).toHaveLength(1);
    }
  } finally { await handle.close(); }
});
