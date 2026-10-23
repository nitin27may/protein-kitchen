import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { loadRenames } from "../db/renames";
import { registerBuiltinClasses } from "./builtin";
import type { ExportBundle } from "./export";
import { registeredClasses } from "./registry";

export interface ImportReport {
  imported: Record<string, number>;
  /** Files that could not be placed, for example a recipe that no longer exists and has no rename entry. */
  skipped: string[];
}

/**
 * Loads an export back into a database. Idempotent. Recipes are found by slug; a slug that no longer exists is
 * followed through data/renames.json. Importing never marks a data class as changed, because the data already
 * matches what was exported.
 */
export async function importHumanData(db: Db, bundle: ExportBundle, opts: { renames?: Record<string, string> } = {}): Promise<ImportReport> {
  registerBuiltinClasses();
  const renames = opts.renames ?? loadRenames();
  const resolveRecipeId = async (slug: string): Promise<number | undefined> => {
    const direct = (await db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, slug)))[0];
    if (direct) return direct.id;
    const renamed = renames[slug];
    if (!renamed) return undefined;
    return (await db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, renamed)))[0]?.id;
  };

  const report: ImportReport = { imported: {}, skipped: [] };
  for (const cls of registeredClasses()) {
    const mine = Object.fromEntries(Object.entries(bundle.files).filter(([path]) => path.startsWith(cls.prefix)));
    const result = await cls.importFiles(db, mine, { resolveRecipeId });
    report.imported[cls.name] = result.imported;
    report.skipped.push(...result.skipped);
  }
  return report;
}
