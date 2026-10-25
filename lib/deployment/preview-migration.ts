import { runtimeTarget } from "../db/postgres/runtime-target";
import { validatePostgresTarget } from "../db/postgres/target";

type Environment = Readonly<Record<string, string | undefined>>;
type Migration = { hash: string; folderMillis: number };
type LedgerRow = { hash: string; created_at: string | number };

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

export function requireMigrationPrefix(rows: LedgerRow[], expected: Migration[], complete = false) {
  if (rows.length > expected.length || (complete && rows.length !== expected.length) ||
      rows.some((row, i) => row.hash !== expected[i]!.hash || Number(row.created_at) !== expected[i]!.folderMillis)) {
    throw new Error("Preview migration ledger is pending or divergent.");
  }
}

export const previewLibraryTables = new Set([
  "library_state", "ingredients", "ingredient_micros", "techniques", "recipes",
  "recipe_items", "recipe_steps", "recipe_advance_prep", "recipe_macros", "recipe_anchors", "habits",
]);
