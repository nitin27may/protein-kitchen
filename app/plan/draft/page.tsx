import type { Metadata } from "next";
import { DraftPlan } from "@/components/DraftPlan";
import type { ServingUnit } from "@/lib/schemas";
import { servingWeightG } from "@/lib/nutrition/portion";
import { buildCandidates } from "@/lib/planner/candidates";
import { getData } from "@/lib/server/context";
import { currentLibraryVersion } from "@/lib/server/anon-library";
import { todayISO } from "@/lib/server/time";

export const metadata: Metadata = { title: "Your plan" };
export const dynamic = "force-dynamic";

/**
 * The plan a visitor made on this device. The server sends only library facts (plate weights and the library version);
 * the draft itself lives in the browser and is never requested from here.
 */
export default function DraftPlanPage() {
  const data = getData();
  const serving: Record<string, { servingG: number; unit: ServingUnit | null }> = {};
  for (const c of buildCandidates(data)) {
    try {
      serving[c.slug] = { servingG: servingWeightG(c.slug, data.recipes, data.ingredients), unit: data.recipes.get(c.slug)?.serving_unit ?? null };
    } catch {
      serving[c.slug] = { servingG: 0, unit: null };
    }
  }
  return <DraftPlan libraryVersion={currentLibraryVersion(data)} serving={serving} today={todayISO()} />;
}
