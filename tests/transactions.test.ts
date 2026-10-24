import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../lib/db/client";
import type { DbHandle } from "../lib/db/client";
import * as s from "../lib/db/schema";
import { withTx } from "../lib/db/tx";

let handle: DbHandle;

beforeEach(() => {
  handle = openDb(":memory:", path.resolve(__dirname, "..", "db", "migrations"));
});

afterEach(() => {
  handle.sqlite.close();
});

describe("SQLite transaction boundary", () => {
  it("commits synchronous writes and returns the callback value", async () => {
    const result = await withTx(handle.db, (tx) => {
      tx.insert(s.syncState).values({ dataClass: "example", changedAt: "2026-10-23" }).run();
      return 42;
    });
    expect(result).toBe(42);
    expect(await handle.db.select().from(s.syncState)).toHaveLength(1);
  });

  it("rolls back writes when the callback throws", async () => {
    await expect(withTx(handle.db, (tx) => {
      tx.insert(s.syncState).values({ dataClass: "example", changedAt: "2026-10-23" }).run();
      throw new Error("write failed");
    })).rejects.toThrow("write failed");
    expect(await handle.db.select().from(s.syncState)).toEqual([]);
  });

  it("rejects promise-returning callbacks instead of committing their writes", async () => {
    // The runtime check also protects callers outside TypeScript.
    // @ts-expect-error SQLite cannot keep a transaction open across an await.
    await expect(withTx(handle.db, (tx) => {
      tx.insert(s.syncState).values({ dataClass: "example", changedAt: "2026-10-23" }).run();
      return Promise.resolve(42);
    })).rejects.toThrow("SQLite transaction callbacks must be synchronous.");
    expect(await handle.db.select().from(s.syncState)).toEqual([]);
  });
});
