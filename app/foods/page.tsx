import { requirePageMember } from "@/lib/auth/access";
import type { Metadata } from "next";
import { FoodsList } from "@/components/foods/FoodsList";
import { LinkButton, PageTitle } from "@/components/ui";
import { memberHouseholdAccess } from "@/lib/auth/household-access";
import { getDb } from "@/lib/server/context";
import { householdFoodUsage, listHouseholdFoods } from "@/lib/server/food-queries";

export const metadata: Metadata = { title: "Your foods" };
export const dynamic = "force-dynamic";

export default async function FoodsPage() {
  const member = await requirePageMember();
  const db = await getDb();
  const access = await memberHouseholdAccess(db, member);
  const [foods, usage] = await Promise.all([listHouseholdFoods(db, access.householdId, { includeArchived: true }), householdFoodUsage(db, access.householdId)]);
  const owner = member.role === "owner";
  return (
    <>
      <PageTitle
        title="Your foods"
        sub={owner ? "Packaged foods from their labels. Anyone in the household can pick them when logging." : "Packaged foods your household owner added. You can pick them when logging."}
        action={owner ? <LinkButton href="/foods/new">Add a food</LinkButton> : undefined}
      />
      <FoodsList foods={foods} usage={usage} />
    </>
  );
}
