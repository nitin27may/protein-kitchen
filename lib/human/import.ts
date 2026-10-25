import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { withTx } from "../db/tx";
import * as s from "../db/schema";
import { loadRenames } from "../db/renames";
import { registerBuiltinClasses } from "./builtin";
import type { ExportBundle } from "./export";
import { registeredClasses } from "./registry";
import { checkLegacyBundleTarget } from "./legacy-bundle";

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
  if (bundle.manifest.version !== 1 && bundle.manifest.version !== 2) throw new Error("Unsupported human-data export version.");
  return withTx(db, async (tx) => {
    await checkLegacyBundleTarget(tx, "import");
    registerBuiltinClasses();
    const renames = opts.renames ?? loadRenames();
    const resolveRecipeId = async (slug: string): Promise<number | undefined> => {
      const direct = (await tx.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, slug)))[0];
      if (direct) return direct.id;
      const renamed = renames[slug];
      if (!renamed) return undefined;
      return (await tx.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, renamed)))[0]?.id;
    };

    const report: ImportReport = { imported: {}, skipped: [] };
    for (const cls of registeredClasses()) {
      const mine = Object.fromEntries(Object.entries(bundle.files).filter(([path]) => path.startsWith(cls.prefix)));
      const result = await cls.importFiles(tx, mine, { resolveRecipeId });
      report.imported[cls.name] = result.imported;
      report.skipped.push(...result.skipped);
    }
    return report;
  });
}
