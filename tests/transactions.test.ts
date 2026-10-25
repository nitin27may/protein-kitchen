import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./helpers/db";
import type { DbHandle } from "./helpers/db";
import * as s from "../lib/db/schema";
import { withTx } from "../lib/db/tx";

let handle: DbHandle;
const at = "2026-10-23T12:00:00.000Z";
beforeEach(async () => { handle = await openDb(); });

describe("awaited transaction boundary", () => {
  it("commits awaited writes and returns the callback value", async () => {
    const result = await withTx(handle.db, async (tx) => {
      await tx.insert(s.syncState).values({ dataClass: "example", changedAt: at });
      await Promise.resolve();
      expect(await tx.select().from(s.syncState)).toHaveLength(1);
      return 42;
    });
    expect(result).toBe(42);
    expect(await handle.db.select().from(s.syncState)).toHaveLength(1);
  });

  it("rolls back writes before and after an await when the callback rejects", async () => {
    await expect(withTx(handle.db, async (tx) => {
      await tx.insert(s.syncState).values({ dataClass: "first", changedAt: at });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tx.insert(s.syncState).values({ dataClass: "second", changedAt: at });
      throw new Error("write failed");
    })).rejects.toThrow("write failed");
    expect(await handle.db.select().from(s.syncState)).toEqual([]);
  });

  it("rolls back a successful statement when a later database statement fails", async () => {
    await expect(withTx(handle.db, async (tx) => {
      await tx.insert(s.syncState).values({ dataClass: "duplicate", changedAt: at });
      await tx.insert(s.syncState).values({ dataClass: "duplicate", changedAt: at });
    })).rejects.toThrow();
    expect(await handle.db.select().from(s.syncState)).toEqual([]);
    await withTx(handle.db, async (tx) => { await tx.insert(s.syncState).values({ dataClass: "retry", changedAt: at }); });
    expect(await handle.db.select().from(s.syncState)).toHaveLength(1);
  });
});
