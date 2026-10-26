import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { verifiedSessionIdentity, verifiedSessionUser } from "@/lib/auth/access";
import { HouseholdAccessError } from "@/lib/auth/household";
import { AuthConfigurationError, householdOwnerEmail } from "@/lib/auth/config";
import { legacyInviteToken, safeAuthReturn } from "@/lib/auth/browser";
import { getDb } from "@/lib/server/context";
import { householdMembers, people } from "@/lib/db/schema";
import { LinkProfile } from "@/components/auth/LinkProfile";
import { StartOwnKitchen } from "@/components/auth/StartOwnKitchen";
import { AcceptLegacyInvite } from "@/components/auth/AcceptLegacyInvite";
import { OnboardingProfileForm } from "@/components/OnboardingProfileForm";
import { Banner, PageTitle } from "@/components/ui";
import { ensureAdmission, resolveSessionHouseholdAccess, sessionHouseholds } from "@/lib/auth/household-session";
import { HouseholdChooser } from "@/components/auth/HouseholdChooser";
import { EmailAssociationPrompt } from "@/components/auth/EmailAssociationPrompt";
import { pendingEmailAssociations } from "@/lib/auth/household";

export const metadata = { title: "Set up your account" };
export const dynamic = "force-dynamic";
export default async function Onboarding({ searchParams }: { searchParams: Promise<{ next?: string; invite?: string }> }) {
  const params = await searchParams;
  const next = safeAuthReturn(params.next);
  let user;
  try { user = await verifiedSessionUser(); }
  catch (error) {
    if (error instanceof HouseholdAccessError) redirect("/sign-in");
    if (!(error instanceof AuthConfigurationError)) throw error;
    console.error("Onboarding requires authentication configuration.");
    return <div className="p-4"><Banner tone="bad">Authentication is not configured on this instance.</Banner></div>;
  }
  const db = await getDb();
  const identity = await verifiedSessionIdentity();
  const associations = await pendingEmailAssociations(db, identity);
  const [member] = await db.select().from(householdMembers).where(eq(householdMembers.userId, user.id));
  if (!member) {
    const invite = legacyInviteToken(params.invite);
    if (invite) return <section className="mx-auto max-w-lg space-y-5 px-4 pb-28 pt-8">
      <h1 className="text-2xl font-bold">Join a household</h1>
      <p className="break-words">Signed in as {user.email}.</p>
      <AcceptLegacyInvite token={invite} />
    </section>;
    const admission = await ensureAdmission(db, identity, { ownerEmail: householdOwnerEmail(process.env) });
    if (admission.status === "association") {
      return <section className="mx-auto max-w-lg space-y-5 px-4 pb-28 pt-8">
        <h1 className="text-2xl font-bold">Finish setting up your account</h1>
        <p className="break-words">Signed in as {user.email}.</p>
        <EmailAssociationPrompt associations={associations} />
        <StartOwnKitchen />
      </section>;
    }
    redirect(`/onboarding?next=${encodeURIComponent(next)}`);
  }
  let access;
  const choices = await sessionHouseholds(db, identity);
  try { access = await resolveSessionHouseholdAccess(db, identity); }
  catch (error) {
    if (!(error instanceof HouseholdAccessError)) throw error;
    if (choices.households.length) return <div className="mx-auto max-w-xl space-y-5 px-4 pb-28 pt-8">
      <h1 className="text-2xl font-bold">Choose a household</h1>
      <EmailAssociationPrompt associations={associations} />
      <HouseholdChooser {...choices} />
    </div>;
    return <div className="p-4"><Banner tone="bad">Your household ownership needs an operator migration before onboarding can continue.</Banner></div>;
  }
  if (access.personId !== null) redirect(next);
  const profiles = access.role === "owner" ? await db.select({ id: people.id, name: people.name }).from(people)
    .where(eq(people.householdId, access.householdId)) : [];
  return <>
    <PageTitle title="Your meal profile" sub="Your own portions and targets, on the household's shared plan." />
    {associations.length ? <div className="mx-4 mb-6"><EmailAssociationPrompt associations={associations} /></div> : null}
    {profiles.length ? <section className="mx-4 mb-6 space-y-3 rounded-card border border-line p-4">
      <h2 className="text-lg font-semibold">Already have a profile?</h2>
      <p className="text-sm text-muted">Link it instead of creating a duplicate. Unavailable or reserved profiles cannot be linked.</p>
      <LinkProfile profiles={profiles} />
    </section> : null}
    <OnboardingProfileForm nextHref={next}
      initial={{ name: user.name, sex: "other", birthDate: "", heightCm: "", weightKg: "", activityLevel: "moderate", proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: "", reminderTime: "" }} />
  </>;
}
