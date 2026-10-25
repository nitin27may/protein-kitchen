import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq, getTableName, sql } from "drizzle-orm";
import * as s from "../lib/db/schema";
import { HouseholdAccessError, pendingEmailAssociations } from "../lib/auth/household";
import { ensureAdmission } from "../lib/auth/household-session";
import { openDb, type DbHandle } from "./helpers/db";

vi.mock("../lib/auth/household", async (original) => {
  const actual = await original<typeof import("../lib/auth/household")>();
  return { ...actual, pendingEmailAssociations: vi.fn(actual.pendingEmailAssociations) };
});

let h: DbHandle;
beforeAll(async () => { h = await openDb(); });
afterEach(async () => {
  vi.mocked(pendingEmailAssociations).mockClear();
  await h.db.execute(sql`truncate table ${sql.join(Object.values(s).map((t) => sql.identifier(getTableName(t))), sql`, `)} restart identity cascade`);
});
afterAll(async () => { await h.close(); });

it("refuses admission when the account disappears between the membership check and creation", async () => {
  await h.db.insert(s.authUsers).values({ id: "ghost", name: "Ghost", email: "ghost@example.test", emailVerified: true });
  await h.db.insert(s.authSessions).values({
    id: "ghost-session", userId: "ghost", token: "synthetic-ghost", updatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
  });
  const actual = await vi.importActual<typeof import("../lib/auth/household")>("../lib/auth/household");
  vi.mocked(pendingEmailAssociations).mockImplementationOnce(async (db, identity) => {
    const found = await actual.pendingEmailAssociations(db, identity);
    await db.delete(s.authUsers).where(eq(s.authUsers.id, "ghost"));
    return found;
  });
  await expect(ensureAdmission(h.db, { userId: "ghost", sessionId: "ghost-session" }))
    .rejects.toThrow(new HouseholdAccessError("This household is not available to your verified account."));
  expect(await h.db.select().from(s.households)).toEqual([]);
});
