import { runtimeTarget } from "../db/postgres/runtime-target";
import { validatePostgresTarget } from "../db/postgres/target";
import type { PoolClient } from "pg";
import { requireMigrationPrefix } from "../db/postgres/migration-ledger";

type Environment = Readonly<Record<string, string | undefined>>;

export function previewMigrationTarget(env: Environment) {
  if (env.DATABASE_ENV !== "preview" || env.VERCEL_ENV !== "preview" ||
      !env.NEON_DEVELOPMENT_BRANCH_ID || env.PREVIEW_MIGRATION_BRANCH !== env.NEON_DEVELOPMENT_BRANCH_ID ||
      env.PREVIEW_MIGRATION_BRANCH === env.NEON_PRODUCTION_BRANCH_ID) {
    throw new Error("Preview migrations require explicit preview mode and acknowledgement of the isolated development branch.");
  }
  const target = {
    ...runtimeTarget(env), connectionString: env.DATABASE_URL_UNPOOLED ?? "",
    nonProductionHost: env.DATABASE_DIRECT_NONPRODUCTION_HOST,
  };
  const url = validatePostgresTarget(target);
  if (!url.hostname.endsWith(".neon.tech") || url.hostname.split(".")[0]!.endsWith("-pooler")) {
    throw new Error("Preview migrations require the verified direct Neon endpoint.");
  }
  return target;
}

export { requireMigrationPrefix };

export const previewLibraryTables = new Set([
  "library_state", "ingredients", "ingredient_micros", "techniques", "recipes",
  "recipe_items", "recipe_steps", "recipe_advance_prep", "recipe_macros", "recipe_anchors", "habits",
]);

export async function requirePreviewLibraryOnly(client: Pick<PoolClient, "query">) {
  const tables = await client.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public'",
  );
  for (const { tablename } of tables.rows) {
    if (previewLibraryTables.has(tablename)) continue;
    const quoted = `"${tablename.replaceAll('"', '""')}"`;
    const result = await client.query(`select exists(select 1 from public.${quoted} limit 1) as occupied`);
    if (result.rows[0].occupied) throw new Error("Preview migration refuses a target containing non-library state.");
  }
}
