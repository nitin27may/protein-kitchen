import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import { isPartMode } from "../parts/mode";
import type { PartModes } from "../parts/mode";
import type { Recipe } from "../schemas";

/** Relative imports only, so tests can run this against an in-memory database. */

export type PartWrite = { ok: true } | { ok: false; error: string };

/**
 * How each part is provided for one plan. Only parts that are bought or already made have a row, so a part missing
 * from the result is made. A mode the app does not know is ignored.
 */
export async function readPartModes(db: Db, planId: number): Promise<PartModes> {
  const rows = await db.select({ slug: s.planPartState.componentSlug, mode: s.planPartState.mode }).from(s.planPartState).where(eq(s.planPartState.planId, planId));
  const modes: PartModes = {};
  for (const r of rows) if (isPartMode(r.mode) && r.mode !== "make") modes[r.slug] = r.mode;
  return modes;
}

/** Saves a part's mode for a plan after checking all three inputs. "Make" is the default, so it removes the row. */
export async function writePartMode(db: Db, recipes: ReadonlyMap<string, Recipe>, planId: number, componentSlug: string, mode: unknown): Promise<PartWrite> {
  if (!isPartMode(mode)) return { ok: false, error: "Choose make, buy or have" };
  const component = recipes.get(componentSlug);
  if (!component || component.kind !== "component") return { ok: false, error: "That part was not found" };
  const [plan] = await db.select({ id: s.plans.id }).from(s.plans).where(eq(s.plans.id, planId)).limit(1);
  if (!plan) return { ok: false, error: "Plan not found" };
  if (mode === "make") {
    await db.delete(s.planPartState).where(and(eq(s.planPartState.planId, planId), eq(s.planPartState.componentSlug, componentSlug)));
  } else {
    const updatedAt = new Date().toISOString();
    await db
      .insert(s.planPartState)
      .values({ planId, componentSlug, mode, updatedAt })
      .onConflictDoUpdate({ target: [s.planPartState.planId, s.planPartState.componentSlug], set: { mode, updatedAt } });
  }
  return { ok: true };
}
