import type { Db } from "./client";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Runs `fn` inside a database transaction. This is the ONE place that changes when the data layer moves from
 * better-sqlite3 to Postgres.
 *
 * Today the callback must be synchronous: better-sqlite3 transactions cannot await, so inside `fn` the queries end
 * in `.run()`, `.get()` or `.all()` and nothing else may be awaited (no fetches, no file or image work, no other
 * async call). The function is still `async` so every caller already awaits it. On Postgres, `fn` becomes an async
 * callback and each query inside it gets an `await`; the bodies are the only lines that then change.
 */
export async function withTx<T>(db: Db, fn: (tx: Tx) => T): Promise<T> {
  return db.transaction((tx) => fn(tx));
}
