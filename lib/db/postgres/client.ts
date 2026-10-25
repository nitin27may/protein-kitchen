import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { validatePostgresTarget } from "./target";
import type { PostgresTarget } from "./target";

export function openPostgres(target: PostgresTarget) {
  const url = validatePostgresTarget(target);
  const pool = new Pool({
    connectionString: url.toString(),
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 5_000,
    application_name: "protein-kitchen",
  });
  pool.on("error", (error: Error) => {
    console.error("Postgres idle connection failed.", {
      name: error.name,
      code: "code" in error && typeof error.code === "string" ? error.code : undefined,
    });
  });
  if (process.env.VERCEL === "1") attachDatabasePool(pool);
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

export type PostgresDb = ReturnType<typeof openPostgres>["db"];
