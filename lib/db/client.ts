import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { openPostgres } from "./postgres/client";
import { runtimeTarget } from "./postgres/runtime-target";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
  db: Db;
  close(): Promise<void>;
}

export function openDb(): DbHandle {
  return openPostgres(runtimeTarget(process.env));
}
