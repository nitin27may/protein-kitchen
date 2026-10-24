import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { verifiedSessionUser } from "@/lib/auth/access";
import { HouseholdAccessError } from "@/lib/auth/household";
import { AuthConfigurationError } from "@/lib/auth/config";
import { safeAuthReturn } from "@/lib/auth/browser";
import { getDb } from "@/lib/server/context";
import { householdMembers, people } from "@/lib/db/schema";
import { HouseholdEntry } from "@/components/auth/HouseholdEntry";
import { ProfileForm } from "@/components/ProfileForm";
import { Banner, PageTitle } from "@/components/ui";
import { finishProfile } from "./actions";

export const metadata = { title: "Join your household" };
export default async function Onboarding({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeAuthReturn((await searchParams).next);
  let user;
  try { user = await verifiedSessionUser(); }
  catch (error) {
    if (error instanceof HouseholdAccessError) redirect("/sign-in");
    if (!(error instanceof AuthConfigurationError)) throw error;
    console.error("Onboarding requires authentication configuration.");
    return <div className="p-4"><Banner tone="bad">Authentication is not configured on this instance.</Banner></div>;
  }
  const db = await getDb();
  const [member] = await db.select().from(householdMembers).where(eq(householdMembers.userId, user.id));
  if (member?.personId !== null && member?.personId !== undefined) redirect(next);
  if (!member) return <section className="mx-auto max-w-lg space-y-5 px-4 pb-28 pt-8">
    <h1 className="text-2xl font-bold">Finish joining your household</h1>
    <p className="break-words">Signed in as {user.email}. Re-enter your invitation or initial household key to confirm membership.</p>
    <HouseholdEntry />
  </section>;
  const profiles = member.role === "owner" ? await db.select({ id: people.id, name: people.name }).from(people) : [];
  return <>
    <PageTitle title="Your meal profile" sub="Your own portions and targets, on the household's shared plan." />
    {profiles.length ? <section className="mx-4 mb-6 space-y-3 rounded-card border border-line p-4">
      <h2 className="text-lg font-semibold">Already have a profile?</h2>
      <p className="text-sm text-muted">Link it instead of creating a duplicate. Unavailable or reserved profiles cannot be linked.</p>
      <HouseholdEntry profiles={profiles} />
    </section> : null}
    <ProfileForm nextHref={next} saveAction={finishProfile}
      initial={{ name: user.name, sex: "other", birthDate: "", heightCm: "", weightKg: "", activityLevel: "moderate", proteinMode: "per_kg", proteinValue: 1.2, kcalTarget: "", reminderTime: "" }} />
  </>;
}
