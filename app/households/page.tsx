import { redirect } from "next/navigation";
import { verifiedSessionIdentity } from "@/lib/auth/access";
import { HouseholdAccessError } from "@/lib/auth/household";
import { AuthConfigurationError } from "@/lib/auth/config";
import { sessionHouseholds } from "@/lib/auth/household-session";
import { getDb } from "@/lib/server/context";
import { HouseholdChooser } from "@/components/auth/HouseholdChooser";
import { Banner, LinkButton } from "@/components/ui";

export const metadata = { title: "Choose a household" };
export const dynamic = "force-dynamic";

export default async function Households() {
  try {
    const identity = await verifiedSessionIdentity();
    const choices = await sessionHouseholds(await getDb(), identity);
    return <div className="mx-auto max-w-xl space-y-5 px-4 pb-28 pt-8">
      <h1 className="text-2xl font-bold">Choose a household</h1>
      <HouseholdChooser {...choices} />
      {!choices.households.length ? <LinkButton href="/onboarding">Continue setup</LinkButton> : null}
    </div>;
  } catch (error) {
    if (error instanceof HouseholdAccessError) redirect("/sign-in");
    if (!(error instanceof AuthConfigurationError)) throw error;
    console.error("Household selection requires authentication configuration.");
    return <div className="p-4"><Banner tone="bad">Authentication is not configured on this instance.</Banner></div>;
  }
}
