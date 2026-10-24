import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { openPostgres } from "../../lib/db/postgres/client";
import { authUsers, authAccounts, householdMembers, households, people } from "../../lib/db/schema";
import { e2eTarget } from "./target";

const email = "authorized-browser-fixture@example.test";
const password = "Synthetic-authorized-browser-password-123!";
let state: Awaited<ReturnType<APIRequestContext["storageState"]>> | undefined;

export const test = base.extend({
  storageState: async ({ playwright }, use) => {
    if (!state) {
      const handle = openPostgres(e2eTarget(process.env.POSTGRES_E2E_URL));
      try {
        const [existing] = await handle.db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email)).limit(1);
        if (!existing) await handle.db.transaction(async (tx) => {
          const id = randomUUID();
          const householdId = randomUUID();
          await tx.insert(households).values({ id: householdId, name: "Synthetic browser household" });
          await tx.insert(authUsers).values({ id, name: "Synthetic authorized cook", email, emailVerified: true });
          await tx.insert(authAccounts).values({
            id: randomUUID(), userId: id, providerId: "credential", accountId: id, password: await hashPassword(password),
          });
          const [profile] = await tx.insert(people).values({
            householdId,
            name: "Synthetic authorized fixture", sex: "other", birthDate: "2000-01-01", heightCm: 170, weightKg: 70,
            activityLevel: "light", dietFlags: [],
          }).returning({ id: people.id });
          await tx.insert(householdMembers).values({ householdId, userId: id, role: "owner", personId: profile!.id });
        });
      } finally { await handle.close(); }
      const client = await playwright.request.newContext({ baseURL: "http://127.0.0.1:3112" });
      try {
        const response = await client.post("/api/auth/sign-in/email", {
          headers: { origin: "http://127.0.0.1:3112", "x-forwarded-for": "127.0.0.31" },
          data: { email, password },
        });
        expect(response.status()).toBe(200);
        state = await client.storageState();
      } finally { await client.dispose(); }
    }
    await use(state);
  },
});
export { expect };
