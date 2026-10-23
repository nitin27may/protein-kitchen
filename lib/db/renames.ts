import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { registerBuiltinClasses } from "../human/builtin";
import { registeredClasses } from "../human/registry";
import type { Db } from "./client";
import * as s from "./schema";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "use a lowercase slug");

/**
 * data/renames.json: `{ "old-slug": "new-slug" }`. A recipe or component whose slug changes needs an entry here so
 * ratings, links and photos follow it. No chains: a new slug must not itself be an old slug.
 */
export const RenamesSchema = z.record(slug, slug).superRefine((map, ctx) => {
  for (const [from, to] of Object.entries(map)) {
    if (from === to) ctx.addIssue({ code: "custom", message: `"${from}" is renamed to itself` });
    if (map[to] !== undefined) ctx.addIssue({ code: "custom", message: `"${from}" to "${to}" chains into another rename; point it at the final slug` });
  }
});

export type Renames = z.infer<typeof RenamesSchema>;

export function loadRenames(root: string = process.cwd()): Renames {
  const file = path.join(root, "data", "renames.json");
  if (!fs.existsSync(file)) return {};
  return RenamesSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * Moves human-owned data from renamed recipes to their new slug. Run by the seed after content is upserted.
 * - New slug not seeded yet: the old row is renamed in place, so ids, plans and human data all stay attached.
 * - Both exist: each registered human data class moves its rows (unless the new row already has its own), then the
 *   old row is deleted only if no plan or recipe still uses it. Otherwise it stays and its human data is cleared.
 * Idempotent. Returns the old slugs whose human data moved.
 */
export async function applyRenames(db: Db, renames: Record<string, string>): Promise<{ moved: string[] }> {
  registerBuiltinClasses();
  const moved: string[] = [];
  for (const [oldSlug, newSlug] of Object.entries(renames)) {
    const oldRow = (await db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, oldSlug)))[0];
    if (!oldRow) continue;
    const newRow = (await db.select({ id: s.recipes.id }).from(s.recipes).where(eq(s.recipes.slug, newSlug)))[0];

    if (!newRow) {
      await db.update(s.recipes).set({ slug: newSlug }).where(eq(s.recipes.id, oldRow.id));
      moved.push(oldSlug);
      continue;
    }

    let any = false;
    for (const cls of registeredClasses()) {
      if (cls.moveRecipe && (await cls.moveRecipe(db, oldRow.id, newRow.id))) any = true;
    }
    if (any) moved.push(oldSlug);

    // Never delete a recipe that still holds someone's ratings, links or photos (for example when the new
    // recipe already had its own and nothing could be moved).
    let holdsData = false;
    for (const cls of registeredClasses()) {
      if (cls.hasRecipeData && (await cls.hasRecipeData(db, oldRow.id))) holdsData = true;
    }
    if (holdsData) continue;

    const used = (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(s.planSlots)
        .where(eq(s.planSlots.recipeId, oldRow.id))
    )[0]?.n ?? 0;
    const usedAsPart = (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(s.recipeItems)
        .where(eq(s.recipeItems.componentId, oldRow.id))
    )[0]?.n ?? 0;
    if (Number(used) === 0 && Number(usedAsPart) === 0) await db.delete(s.recipes).where(eq(s.recipes.id, oldRow.id));
  }
  return { moved };
}
