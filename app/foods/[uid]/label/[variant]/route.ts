import { and, eq } from "drizzle-orm";
import { routeAccess } from "@/lib/auth/access";
import { HouseholdAccessError } from "@/lib/auth/household";
import { memberHouseholdAccess } from "@/lib/auth/household-access";
import { getBlobStore } from "@/lib/blob";
import * as s from "@/lib/db/schema";
import { foodLabelKeys } from "@/lib/photos/keys";
import { getDb } from "@/lib/server/context";

export const dynamic = "force-dynamic";

/**
 * Serves the photo of a food's label to members of the household that owns the food. The food is found by uid AND
 * household, so another household's uid is a 404. Responses are never cached by a shared cache.
 */
export async function GET(request: Request, { params }: { params: Promise<{ uid: string; variant: string }> }): Promise<Response> {
  const access = await routeAccess(request);
  if (access.response) return access.response;
  const { uid, variant } = await params;
  const missing = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "private, no-store" } });
  if (variant !== "master" && variant !== "thumb") return missing();
  const db = await getDb();
  let householdId: string;
  try {
    householdId = (await memberHouseholdAccess(db, access.member)).householdId;
  } catch (error) {
    if (!(error instanceof HouseholdAccessError)) throw error;
    return new Response("Household not available", { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }
  const [row] = await db.select({ photoUid: s.householdFoods.labelPhotoUid }).from(s.householdFoods)
    .where(and(eq(s.householdFoods.uid, uid), eq(s.householdFoods.householdId, householdId))).limit(1);
  if (!row?.photoUid) return missing();
  const blob = await getBlobStore().get(foodLabelKeys(row.photoUid)[variant]);
  if (!blob) return missing();
  return new Response(Buffer.from(blob.bytes), {
    headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
