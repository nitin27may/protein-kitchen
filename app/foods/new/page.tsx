import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import { FoodForm } from "@/components/foods/FoodForm";
import { PageTitle } from "@/components/ui";
import { memberHouseholdAccess } from "@/lib/auth/household-access";
import { foodCatalog } from "@/lib/foods/list";
import { getDb } from "@/lib/server/context";
import { listHouseholdFoods } from "@/lib/server/food-queries";

export const metadata: Metadata = { title: "Add a food" };
export const dynamic = "force-dynamic";

export default async function NewFoodPage() {
  const member = await requirePageMember("owner");
  const db = await getDb();
  const access = await memberHouseholdAccess(db, member);
  const existing = foodCatalog(await listHouseholdFoods(db, access.householdId, { includeArchived: true }));
  return (
    <>
      <PageTitle title="Add a food" sub="Photograph the nutrition label, then type the numbers from it." />
      <FoodForm existing={existing} />
    </>
  );
}
