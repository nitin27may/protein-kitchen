import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FoodForm } from "@/components/foods/FoodForm";
import { PageTitle } from "@/components/ui";
import { memberHouseholdAccess } from "@/lib/auth/household-access";
import { draftFromStored, valuesFromDraft } from "@/lib/foods/form";
import { foodCatalog } from "@/lib/foods/list";
import { getDb } from "@/lib/server/context";
import { getHouseholdFood, listHouseholdFoods } from "@/lib/server/food-queries";

export const metadata: Metadata = { title: "Edit food" };
export const dynamic = "force-dynamic";

export default async function EditFoodPage({ params }: { params: Promise<{ uid: string }> }) {
  const member = await requirePageMember("owner");
  const { uid } = await params;
  const db = await getDb();
  const access = await memberHouseholdAccess(db, member);
  const food = await getHouseholdFood(db, access.householdId, uid);
  if (!food) notFound();
  const existing = foodCatalog(await listHouseholdFoods(db, access.householdId, { includeArchived: true }));
  return (
    <>
      <PageTitle title={`Edit ${food.name}`} sub="Check the numbers against the label, then save." />
      <FoodForm uid={food.uid} initial={valuesFromDraft(draftFromStored(food))} existingPhotoSrc={food.hasLabelPhoto ? `/foods/${food.uid}/label/master` : null} existing={existing} usageCount={food.usageCount} />
    </>
  );
}
