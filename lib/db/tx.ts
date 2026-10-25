import type { Db } from "./client";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Database work only: image processing, network and blob operations stay outside the transaction. */
export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
